// audio-output.js: main thread side of audio. Creates the AudioContext and
// the worklet node(s), and hands the core a push function. GPL-2.0-or-later.
//
// One source (the default): one ring and one worklet node straight to the
// speakers. Several sources (options.sources, the cabinet): one ring and one
// worklet node per source, each into the gain node of its group, the groups
// summed at the destination. The cabinet uses the groups 'seat' (the
// player's seat board) and 'race' (the race screen boards), so the player
// can set the race audio and the seat sounds apart (audio-mix.js).

import { AudioRing, allocateRingBuffer } from './audio-ring.js';
import { PROCESSOR_NAME } from './audio-worklet.js';

// Flycast's libretro core reports 44100 Hz.
export const CORE_SAMPLE_RATE = 44100;

// About 100 ms of buffer at 44.1 kHz.
export const DEFAULT_CAPACITY_FRAMES = 4096;

// Must be called from a user gesture (click) so the context may start.
// options.sources: { sourceName: groupName or { group, primeFrames,
// maxBufferedFrames, targetFrames, reportEveryFrames } } (insertion order
// kept); the first source is also .ring and .push. options.primeFrames,
// options.maxBufferedFrames and options.reportEveryFrames: the worklet's
// jitter buffer (audio-worklet.js), for sources that set none.
// With sources, the groups meet in a master bus with a safety limiter (a
// DynamicsCompressorNode near full scale), so several boards at full level
// can't clip.
export async function createAudioOutput(options = {}) {
  const Ctx = options.AudioContext || globalThis.AudioContext;
  if (!Ctx) throw new Error('Web Audio is not available');
  const sampleRate = options.sampleRate || CORE_SAMPLE_RATE;
  const capacityFrames = options.capacityFrames || DEFAULT_CAPACITY_FRAMES;
  const ctx = new Ctx({ sampleRate, latencyHint: 'interactive' });
  const moduleUrl = options.moduleUrl || new URL('./audio-worklet.js', import.meta.url);
  await ctx.audioWorklet.addModule(moduleUrl);
  const Node = options.AudioWorkletNode || globalThis.AudioWorkletNode;
  const sourceGroups = options.sources || null;
  const groups = new Map(); // group name -> GainNode
  const sources = new Map(); // source name -> { buffer, ring, stats }
  const names = sourceGroups ? Object.keys(sourceGroups) : ['main'];
  let bus = null;
  if (sourceGroups) {
    bus = ctx.destination;
    if (typeof ctx.createDynamicsCompressor === 'function') {
      const lim = ctx.createDynamicsCompressor();
      const set = (param, v) => { if (param) param.value = v; };
      set(lim.threshold, -3); set(lim.knee, 0); set(lim.ratio, 20); set(lim.attack, 0.003); set(lim.release, 0.1);
      lim.connect(ctx.destination);
      bus = lim;
    }
  }
  for (const name of names) {
    const spec = sourceGroups && typeof sourceGroups[name] === 'object' ? sourceGroups[name] : { group: sourceGroups ? sourceGroups[name] : null };
    const prime = spec.primeFrames ?? options.primeFrames ?? 0;
    const cap = spec.maxBufferedFrames ?? options.maxBufferedFrames ?? 0;
    const target = spec.targetFrames ?? 0;
    const reportEveryFrames = spec.reportEveryFrames ?? options.reportEveryFrames ?? 0;
    const buffer = allocateRingBuffer(capacityFrames);
    const ring = new AudioRing(buffer, capacityFrames);
    const node = new Node(ctx, PROCESSOR_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { buffer, capacityFrames, maxBufferedFrames: cap, primeFrames: prime, targetFrames: target, reportEveryFrames },
    });
    const src = { buffer, ring, group: spec.group ?? null, stats: { underruns: 0, buffered: 0, trimmed: 0, stretched: 0, skipped: 0, low: 0, high: 0, avg: 0 } };
    if (node.port) node.port.onmessage = (e) => { if (e && e.data) Object.assign(src.stats, e.data); };
    if (sourceGroups) {
      const group = spec.group;
      if (!groups.has(group)) {
        const g = ctx.createGain();
        g.connect(bus);
        groups.set(group, g);
      }
      node.connect(groups.get(group));
    } else {
      node.connect(ctx.destination);
    }
    sources.set(name, src);
  }
  if (ctx.state === 'suspended') await ctx.resume();
  const first = sources.get(names[0]);
  return {
    context: ctx,
    ring: first.ring,
    // For retro_audio_sample_batch: Int16Array of interleaved frames.
    push: (samples, frames) => first.ring.push(samples, frames),
    // The shared ring of one source, for a board worker: { buffer, capacityFrames }.
    source: (name) => (sources.has(name) ? { buffer: sources.get(name).buffer, capacityFrames } : null),
    // Level of one group, 0 to 1 (a short ramp, no click).
    setLevel(group, v) {
      const g = groups.get(group);
      if (!g) return;
      const level = Math.min(1, Math.max(0, Number(v) || 0));
      try { g.gain.setTargetAtTime(level, ctx.currentTime, 0.02); } catch { g.gain.value = level; }
    },
    // Per source: underruns and frames buffered (the worklet's last report:
    // buffered now, and low, high and avg over the report period), with the
    // source's group.
    stats: () => Object.fromEntries([...sources].map(([k, s]) => [k, { group: s.group, ...s.stats }])),
    // The context's own delay to the speakers, in seconds (0 where the
    // browser does not say).
    latency: () => ({ base: Number(ctx.baseLatency) || 0, output: Number(ctx.outputLatency) || 0 }),
    close: () => ctx.close(),
  };
}
