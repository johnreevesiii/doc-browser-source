// audio-worklet.js: AudioWorklet processor that plays the core's audio
// from a shared AudioRing. Loaded with audioContext.audioWorklet.addModule.
// GPL-2.0-or-later.
//
// Jitter buffer (both off by default, the cabinet sets them):
// - processorOptions.primeFrames: after a start or an underrun, play silence
//   until this much is buffered. A race board hands over two frames of audio
//   at a time (it draws every second vblank), so the ring must hold more than
//   one hand-over to play through without gaps.
// - processorOptions.maxBufferedFrames: latency cap. A board paced by the
//   page's clock makes its audio a little faster than the sound card plays
//   it, so the ring slowly fills. Above the cap, one render quantum plays
//   129 frames squeezed into 128 (linear, under 1 percent faster for 3 ms),
//   so the delay comes back down without a click or the burst drop of a
//   full ring. More than twice the cap (after the context was suspended)
//   jumps straight back to the cap.
// - processorOptions.targetFrames: set point (the race boards). Instead of
//   waiting for the cap, a small controller (createRateController) keeps
//   the low point of the buffer near this many frames: it plays a render
//   quantum a touch faster (129 frames as 128) when the buffer sits above
//   the set point and a touch slower (127 frames as 128) when below, never
//   more than one frame in 128 (under 0.8 percent, not heard), so the race
//   sound stays a steady, short time behind the picture. A race board hands
//   over a whole drawn frame of audio at once (about 1470 frames every
//   second vblank), so the buffer saws up and down by that much; the
//   controller watches its low point over the last windowQuanta quanta.
//   Optional (off unless underrunBoostFrames is set): after an underrun the
//   set point rises by underrunBoostFrames, up to maxBoostFrames, and eases
//   back over about boostDecaySeconds. Measured locally it raised the delay
//   by about 10 ms without fewer gaps (the gaps came at screen changes), so
//   the cabinet leaves it off.
//   The skip above twice the cap stays.
// - processorOptions.reportEveryFrames: how often the stats go to the page.

import { AudioRing } from './audio-ring.js';

export const PROCESSOR_NAME = 'doc-host-audio';

// Base class is resolved at load time so node tests can supply a stub.
const Base = globalThis.AudioWorkletProcessor || class {};

// Pure controller for the set point mode. step(level) takes the frames left
// in the ring after a quantum and returns +1 (squeeze the next quantum), -1
// (stretch it) or 0. The level's low point over the last `window` calls is
// compared with the set point; the error times `gain` (quanta of correction
// per quantum per frame of error, clamped to one) accumulates, and each
// whole unit is spent as one squeezed or stretched quantum, so a small error
// gives an occasional correction and a large one a correction every quantum.
export function createRateController({ targetFrames, window = 32, gain = 1 / 256 } = {}) {
  const hist = new Int32Array(Math.max(1, window | 0));
  let n = 0;
  let idx = 0;
  let acc = 0;
  let target = targetFrames;
  return {
    reset() { n = 0; idx = 0; acc = 0; },
    get target() { return target; },
    setTarget(v) { target = v; },
    low() {
      if (n === 0) return 0;
      let m = Infinity;
      for (let i = 0; i < n; i++) if (hist[i] < m) m = hist[i];
      return m;
    },
    step(level) {
      hist[idx] = level;
      idx = (idx + 1) % hist.length;
      if (n < hist.length) n++;
      // Until the window is full the low point is not known yet.
      if (n < hist.length) return 0;
      const err = this.low() - target;
      acc += Math.max(-1, Math.min(1, err * gain));
      if (acc >= 1) { acc -= 1; return 1; }
      if (acc <= -1) { acc += 1; return -1; }
      return 0;
    },
  };
}

export class HostAudioProcessor extends Base {
  constructor(options = {}) {
    super();
    const opts = options.processorOptions || {};
    this.ring = new AudioRing(opts.buffer, opts.capacityFrames);
    this.maxBuffered = opts.maxBufferedFrames > 0 ? opts.maxBufferedFrames : 0;
    this.prime = opts.primeFrames > 0 ? opts.primeFrames : 0;
    this.primed = this.prime === 0;
    this.trimmed = 0;
    this.skipped = 0;
    this.stretched = 0;
    this.tmp = [new Float32Array(0), new Float32Array(0)];
    this.framesSinceReport = 0;
    this.reportEvery = opts.reportEveryFrames || 48000;
    this.control = opts.targetFrames > 0
      ? createRateController({ targetFrames: opts.targetFrames, window: opts.windowQuanta || 32, gain: opts.controlGain || 1 / 256 })
      : null;
    this.next = 0; // +1 squeeze, -1 stretch the next quantum (set point mode)
    this.baseTarget = opts.targetFrames > 0 ? opts.targetFrames : 0;
    this.boost = 0;
    this.boostStep = opts.underrunBoostFrames > 0 ? opts.underrunBoostFrames : 0;
    this.maxBoost = opts.maxBoostFrames ?? 1024;
    // Frames of boost given back per quantum.
    this.boostDecay = this.boostStep / (((opts.boostDecaySeconds || 20) * 44100) / 128);
    // Buffered frames over the report period: low, high, sum and count.
    this.lvMin = Infinity;
    this.lvMax = 0;
    this.lvSum = 0;
    this.lvN = 0;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const left = out[0];
    const right = out[1] || out[0];
    const want = left.length;
    let avail = this.ring.available();
    // Far over the cap (the context was suspended by the mute button while
    // the boards went on): jump to the cap at once; the squeeze alone would
    // take many seconds to catch up.
    if (this.maxBuffered && avail > 2 * this.maxBuffered) {
      this.skipped += this.ring.skip(avail - this.maxBuffered);
      avail = this.ring.available();
    }
    if (!this.primed && avail >= this.prime) {
      this.primed = true;
      if (this.control) { this.control.reset(); this.next = 0; }
    }
    if (!this.primed) {
      left.fill(0);
      right.fill(0);
    } else if (this.control) {
      if (this.next > 0 && want > 1 && avail >= want + 1) this.squeeze(left, right, want);
      else if (this.next < 0 && want > 2 && avail >= want) this.stretch(left, right, want);
      else if (this.ring.pull(left, right) < want) {
        this.primed = false;
        this.boost = Math.min(this.maxBoost, this.boost + this.boostStep);
      }
      if (this.primed && this.boost > 0) this.boost = Math.max(0, this.boost - this.boostDecay);
      this.control.setTarget(this.baseTarget + this.boost);
      this.next = this.primed ? this.control.step(this.ring.available()) : 0;
    } else if (this.maxBuffered && want > 1 && avail > this.maxBuffered + want) {
      this.squeeze(left, right, want);
    } else if (this.ring.pull(left, right) < want && this.prime) {
      this.primed = false;
    }
    if (avail < this.lvMin) this.lvMin = avail;
    if (avail > this.lvMax) this.lvMax = avail;
    this.lvSum += avail;
    this.lvN++;
    this.framesSinceReport += want;
    if (this.port && this.framesSinceReport >= this.reportEvery) {
      this.framesSinceReport = 0;
      this.port.postMessage({
        underruns: this.ring.underruns, buffered: this.ring.available(), trimmed: this.trimmed, stretched: this.stretched, skipped: this.skipped,
        low: this.lvN ? this.lvMin : 0, high: this.lvMax, avg: this.lvN ? Math.round(this.lvSum / this.lvN) : 0,
        target: this.control ? Math.round(this.control.target) : 0,
      });
      this.lvMin = Infinity; this.lvMax = 0; this.lvSum = 0; this.lvN = 0;
    }
    return true;
  }

  // want + 1 frames from the ring, played as want frames.
  squeeze(left, right, want) {
    if (this.tmp[0].length !== want + 1) this.tmp = [new Float32Array(want + 1), new Float32Array(want + 1)];
    const [tl, tr] = this.tmp;
    this.ring.pull(tl, tr);
    const step = want / (want - 1);
    for (let i = 0; i < want; i++) {
      const p = i * step;
      const k = Math.min(Math.floor(p), want - 1);
      const fr = p - k;
      left[i] = tl[k] + (tl[k + 1] - tl[k]) * fr;
      right[i] = tr[k] + (tr[k + 1] - tr[k]) * fr;
    }
    this.trimmed++;
  }

  // want - 1 frames from the ring, played as want frames.
  stretch(left, right, want) {
    if (this.tmp[0].length !== want - 1) this.tmp = [new Float32Array(want - 1), new Float32Array(want - 1)];
    const [tl, tr] = this.tmp;
    this.ring.pull(tl, tr);
    const step = (want - 2) / (want - 1);
    for (let i = 0; i < want; i++) {
      const p = i * step;
      const k = Math.min(Math.floor(p), want - 3);
      const fr = p - k;
      left[i] = tl[k] + (tl[k + 1] - tl[k]) * fr;
      right[i] = tr[k] + (tr[k + 1] - tr[k]) * fr;
    }
    this.stretched++;
  }
}

if (typeof globalThis.registerProcessor === 'function') {
  globalThis.registerProcessor(PROCESSOR_NAME, HostAudioProcessor);
}
