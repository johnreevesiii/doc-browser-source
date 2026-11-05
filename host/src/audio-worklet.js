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

// Adaptive resampler mode (ResamplingAudioProcessor, RESAMPLER_NAME): the
// context runs at the sound card's own rate (no browser resampler and its
// extra delay in front of the speakers), and this processor converts the
// core's 44100 Hz itself with a cubic (Catmull-Rom) interpolator whose step
// is trimmed continuously by createDriftControl, so the buffer's low point
// holds a set point without the squeeze or stretch steps of the older modes.
// - Set point: targetFrames. A gap after steady play (steadySeconds of
//   playing) raises it by boostFrames, up to maxTargetFrames; it eases back
//   over boostDecaySeconds. Gaps right after a start (boot, a silent screen
//   change) do not count: no buffer could have covered them.
// - Backlog (a worklet stall, a board hitch and its catch-up, the mute):
//   when the low point over the window passes the set point plus two
//   hand-overs (handoverFrames: a board hands its audio over in one batch per
//   retro_run, about 735 frames for the seat and 1470 for a race board), one
//   quantum crossfades from the current read point to a point further on, so
//   the low point lands at the set point plus one hand-over, never below it.
//   Smaller errors drain through the trim, which may reach maxTrimLarge while
//   the error is above half a hand-over and maxTrim otherwise.
// - Gaps fade out and back in (no clicks).
// - When the card's rate is below the core's (a 16 kHz hands-free headset),
//   a fourth-order lowpass at 0.45 of the card's rate runs on the core's
//   frames first (no aliasing).
//
// Pure controller: step(level) takes the frames buffered (core rate) after a
// quantum and returns the rate trim (a fraction) for the next quantum. The
// low point of the level over windowSeconds is held at the target: a
// proportional term (kp, trim per frame of error) plus an integral (kiPerS,
// per frame-second, for the boards' steady clock offset of about +0.35
// percent: the hub's 60 Hz against the guest's own rate). The trim glides
// toward the wanted value with time constant glideSeconds. Every time
// constant is in seconds, so the loop behaves the same at 44.1, 48, 96 or
// 192 kHz (quantumSeconds = 128 / the card's rate).
export function createDriftControl({ targetFrames, quantumSeconds = 128 / 48000, windowSeconds = 0.064, kp = 1 / 60000, kiPerS = 1 / 320000,
  maxTrim = 0.006, maxTrimLarge = 0.01, largeError = 367, glideSeconds = 0.05 } = {}) {
  const hist = new Int32Array(Math.max(1, Math.ceil(windowSeconds / quantumSeconds)));
  const glide = 1 - Math.exp(-quantumSeconds / glideSeconds);
  let n = 0;
  let idx = 0;
  let integ = 0;
  let trim = 0;
  let target = targetFrames;
  const low = () => {
    let m = Infinity;
    for (let i = 0; i < n; i++) if (hist[i] < m) m = hist[i];
    return n ? m : 0;
  };
  const integMax = maxTrim / kiPerS;
  return {
    reset() { n = 0; idx = 0; trim = Math.max(-maxTrim, Math.min(maxTrim, kiPerS * integ)); },
    // Forgets the window and fills it with level: the low point is level at
    // once (a jump in the ring, as after the mute, makes the old levels
    // meaningless).
    seed(level) { hist.fill(level); n = hist.length; idx = 0; },
    get target() { return target; },
    setTarget(v) { target = v; },
    get trim() { return trim; },
    // The window is full: low() is the low point over windowSeconds.
    get ready() { return n >= hist.length; },
    windowQuanta: hist.length,
    low,
    step(level) {
      hist[idx] = level;
      idx = (idx + 1) % hist.length;
      if (n < hist.length) n++;
      if (n < hist.length) return trim;
      const err = low() - target;
      // Anti-windup: the integral is for the clock offset, so it moves only
      // while the error is small and the output is not at a limit (a
      // backlog drained at full trim would otherwise wind it up, and the
      // level would undershoot the set point for many seconds after).
      const cap = err > largeError ? maxTrimLarge : maxTrim;
      const raw = kp * err + kiPerS * integ;
      if (Math.abs(err) <= largeError && raw < maxTrim && raw > -maxTrim) integ = Math.max(-integMax, Math.min(integMax, integ + err * quantumSeconds));
      const want = Math.max(-maxTrim, Math.min(cap, raw));
      trim += (want - trim) * glide;
      return trim;
    },
  };
}

// Catmull-Rom through b (t = 0) and c (t = 1).
export function cubic(a, b, c, d, t) {
  return b + 0.5 * t * (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)));
}

// Butterworth lowpass biquad coefficients (RBJ cookbook), one section.
export function lowpassCoefficients(cutoffHz, rate, q = Math.SQRT1_2) {
  const w = (2 * Math.PI * cutoffHz) / rate;
  const alpha = Math.sin(w) / (2 * q);
  const cw = Math.cos(w);
  const a0 = 1 + alpha;
  return { b0: ((1 - cw) / 2) / a0, b1: (1 - cw) / a0, b2: ((1 - cw) / 2) / a0, a1: (-2 * cw) / a0, a2: (1 - alpha) / a0 };
}

// Fourth-order lowpass for one channel (two biquads, Q 0.541 and 1.307).
export function createLowpass(cutoffHz, rate) {
  const s = [lowpassCoefficients(cutoffHz, rate, 0.5411961), lowpassCoefficients(cutoffHz, rate, 1.3065630)];
  const z = new Float64Array(4);
  return (x) => {
    let v = x;
    for (let k = 0; k < 2; k++) {
      const c = s[k];
      const y = c.b0 * v + z[2 * k];
      z[2 * k] = c.b1 * v - c.a1 * y + z[2 * k + 1];
      z[2 * k + 1] = c.b2 * v - c.a2 * y;
      v = y;
    }
    return v;
  };
}

export class ResamplingAudioProcessor extends Base {
  constructor(options = {}) {
    super();
    const o = options.processorOptions || {};
    this.ring = new AudioRing(o.buffer, o.capacityFrames);
    this.inRate = o.inRate || 44100;
    this.outRate = o.outRate || globalThis.sampleRate || 48000;
    this.ratio = this.inRate / this.outRate;
    const quantumSeconds = 128 / this.outRate;
    this.baseTarget = o.targetFrames > 0 ? o.targetFrames : 512;
    this.maxTarget = Math.max(this.baseTarget, o.maxTargetFrames || this.baseTarget * 4);
    this.handover = o.handoverFrames > 0 ? o.handoverFrames : 735;
    this.boostStep = o.boostFrames ?? 256;
    this.boost = 0;
    // Frames of boost given back per quantum.
    this.boostDecay = this.boostStep > 0 ? (this.boostStep * quantumSeconds) / (o.boostDecaySeconds || 30) : 0;
    this.control = createDriftControl({ targetFrames: this.baseTarget, quantumSeconds, largeError: this.handover / 2 });
    // Local history of core frames (filtered when the card's rate is lower);
    // the read point pos keeps one frame before it for the interpolator.
    this.cap = 16384;
    this.bl = new Float32Array(this.cap);
    this.br = new Float32Array(this.cap);
    this.have = 0;
    this.pos = 1;
    this.primed = false;
    this.gain = 0;
    this.lastL = 0;
    this.lastR = 0;
    this.underruns = 0;
    this.prevLevel = -1;
    this.reseeds = 0;
    this.skipped = 0;
    this.skips = 0;
    // Quanta played since the last start; steadySeconds of them make an
    // underrun count toward the boost.
    this.playedQuanta = 0;
    this.steadyQuanta = Math.round((o.steadySeconds ?? 2) / quantumSeconds);
    this.lpL = this.outRate < this.inRate ? createLowpass(0.45 * this.outRate, this.inRate) : null;
    this.lpR = this.lpL ? createLowpass(0.45 * this.outRate, this.inRate) : null;
    this.reportEvery = o.reportEveryFrames || this.outRate;
    this.sinceReport = 0;
    this.lvMin = Infinity; this.lvMax = 0; this.lvSum = 0; this.lvN = 0;
  }

  // Core frames waiting: the ring plus what the history holds past pos.
  level() { return this.ring.available() + Math.max(0, Math.floor(this.have - this.pos)); }

  // Pulls core frames straight into the history until it holds upTo frames
  // (no allocation), filtering them when the card's rate is lower.
  fill(upTo) {
    const from = this.have;
    const want = Math.min(Math.min(upTo, this.cap) - from, this.ring.available());
    if (want <= 0) return;
    const got = this.ring.pullInto(this.bl, this.br, from, want);
    if (this.lpL) {
      for (let i = from; i < from + got; i++) { this.bl[i] = this.lpL(this.bl[i]); this.br[i] = this.lpR(this.br[i]); }
    }
    this.have += got;
  }

  // Drops history frames before the one ahead of the read point.
  compact() {
    const drop = Math.max(0, Math.floor(this.pos) - 1);
    if (drop > 0) {
      this.bl.copyWithin(0, drop, this.have); this.br.copyWithin(0, drop, this.have);
      this.have -= drop;
      this.pos -= drop;
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const L = out[0];
    const R = out[1] || out[0];
    const want = L.length;
    const target = this.baseTarget + this.boost;
    this.control.setTarget(target);
    // A jump in the ring between two quanta of more than four hand-overs (the
    // mute or a suspended context ending, a long worklet stall; a board's
    // held frames going out together are at most about three): the old low
    // points no longer apply. The window is refilled with the new level less
    // one hand-over, so the backlog is skipped once, in this quantum, to the
    // set point plus two hand-overs at the peak; the next window's low point
    // is then under the skip threshold (a deeper seed would land too high
    // and skip a second time one window later).
    if (this.primed && this.prevLevel >= 0) {
      const lv0 = this.level();
      if (lv0 - this.prevLevel > 4 * this.handover) { this.control.seed(lv0 - this.handover); this.reseeds++; }
    }
    if (!this.primed && this.ring.available() >= target + 128) {
      this.primed = true;
      this.control.reset();
      this.have = 0;
      this.fill(1);
      // The first frame doubles as the one before it.
      this.bl[1] = this.bl[0]; this.br[1] = this.br[0];
      this.have = 2;
      this.pos = 1;
    }
    if (!this.primed) {
      this.fadeOut(L, R, 0, want);
    } else {
      const step = this.ratio * (1 + this.control.trim);
      // Backlog: skip ahead so the low point lands at the set point plus one
      // hand-over, crossfading over this quantum.
      let jump = 0;
      if (this.control.ready && this.control.low() > target + 2 * this.handover) {
        this.compact();
        const room = this.cap - Math.ceil(this.pos + 2 * want * step) - 8;
        jump = Math.max(0, Math.min(Math.floor(this.control.low() - (target + this.handover)), room));
      }
      this.fill(Math.floor(this.pos + jump + (want - 1) * step) + 3);
      if (jump > 0 && Math.floor(this.pos + jump + (want - 1) * step) + 2 >= this.have) jump = 0;
      const bl = this.bl;
      const br = this.br;
      let i = 0;
      if (jump > 0) {
        let pb = this.pos + jump;
        for (; i < want; i++) {
          const k = Math.floor(this.pos);
          const kb = Math.floor(pb);
          const t = this.pos - k;
          const tb = pb - kb;
          const g = (i + 1) / want;
          const a0 = cubic(bl[k - 1], bl[k], bl[k + 1], bl[k + 2], t);
          const a1 = cubic(br[k - 1], br[k], br[k + 1], br[k + 2], t);
          const b0 = cubic(bl[kb - 1], bl[kb], bl[kb + 1], bl[kb + 2], tb);
          const b1 = cubic(br[kb - 1], br[kb], br[kb + 1], br[kb + 2], tb);
          L[i] = (a0 + (b0 - a0) * g) * this.gain;
          R[i] = (a1 + (b1 - a1) * g) * this.gain;
          if (this.gain < 1) this.gain = Math.min(1, this.gain + 1 / 64);
          this.pos += step;
          pb += step;
        }
        this.pos = pb;
        this.skipped += jump;
        this.skips++;
        this.control.reset();
      } else {
        for (; i < want; i++) {
          const k = Math.floor(this.pos);
          if (k + 2 >= this.have) break;
          const t = this.pos - k;
          L[i] = cubic(bl[k - 1], bl[k], bl[k + 1], bl[k + 2], t) * this.gain;
          R[i] = cubic(br[k - 1], br[k], br[k + 1], br[k + 2], t) * this.gain;
          if (this.gain < 1) this.gain = Math.min(1, this.gain + 1 / 64);
          this.pos += step;
        }
      }
      if (i > 0) { this.lastL = L[i - 1]; this.lastR = R[i - 1]; }
      this.compact();
      if (i < want) {
        // Ran dry: fade out the rest of this quantum, then rebuffer. Only a
        // gap after steady play raises the set point.
        this.fadeOut(L, R, i, want);
        this.underruns++;
        this.primed = false;
        this.gain = 0;
        this.have = 0;
        if (this.playedQuanta >= this.steadyQuanta) this.boost = Math.min(this.maxTarget - this.baseTarget, this.boost + this.boostStep);
        this.playedQuanta = 0;
      } else {
        this.playedQuanta++;
        this.control.step(this.level());
        if (this.boost > 0) this.boost = Math.max(0, this.boost - this.boostDecay);
      }
    }
    const lv = this.level();
    this.prevLevel = this.primed ? lv : -1;
    if (lv < this.lvMin) this.lvMin = lv;
    if (lv > this.lvMax) this.lvMax = lv;
    this.lvSum += lv; this.lvN++;
    this.sinceReport += want;
    if (this.port && this.sinceReport >= this.reportEvery) {
      this.sinceReport = 0;
      this.port.postMessage({
        underruns: this.underruns, buffered: lv, low: this.lvN ? this.lvMin : 0, high: this.lvMax,
        avg: this.lvN ? Math.round(this.lvSum / this.lvN) : 0, target: Math.round(target), trim: this.control.trim,
        rate: this.outRate, trimmed: 0, stretched: 0, skipped: this.skipped, skips: this.skips,
      });
      this.lvMin = Infinity; this.lvMax = 0; this.lvSum = 0; this.lvN = 0;
    }
    return true;
  }

  fadeOut(L, R, from, to) {
    for (let i = from; i < to; i++) {
      this.lastL *= 0.9; this.lastR *= 0.9;
      L[i] = this.lastL; R[i] = this.lastR;
    }
  }
}

export const RESAMPLER_NAME = 'doc-host-audio-rs';

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
  globalThis.registerProcessor(RESAMPLER_NAME, ResamplingAudioProcessor);
}
