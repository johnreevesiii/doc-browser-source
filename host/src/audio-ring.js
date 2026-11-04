// audio-ring.js: single producer, single consumer stereo sample ring.
// GPL-2.0-or-later.
//
// The core (main thread or a worker) pushes libretro audio: interleaved
// signed 16 bit stereo frames from retro_audio_sample_batch. The
// AudioWorklet pulls float frames on the audio thread. Backed by a
// SharedArrayBuffer when the page is cross-origin isolated, else by a
// plain ArrayBuffer (then producer and consumer must share a thread, which
// is only useful for tests).
//
// Layout: Int32 header [readIndex, writeIndex] then Int16 data, capacity
// frames x 2 channels. Indices count frames and wrap at capacity * 2 so
// full and empty can be told apart.

const HEADER_INTS = 2;
const READ = 0;
const WRITE = 1;

export function ringByteLength(capacityFrames) {
  return HEADER_INTS * 4 + capacityFrames * 2 * 2;
}

export function allocateRingBuffer(capacityFrames) {
  if (!Number.isInteger(capacityFrames) || capacityFrames < 2) {
    throw new Error('capacity must be an integer >= 2');
  }
  const len = ringByteLength(capacityFrames);
  return typeof SharedArrayBuffer === 'function'
    ? new SharedArrayBuffer(len)
    : new ArrayBuffer(len);
}

export class AudioRing {
  constructor(buffer, capacityFrames) {
    if (buffer.byteLength !== ringByteLength(capacityFrames)) {
      throw new Error('buffer size does not match capacity');
    }
    this.capacity = capacityFrames;
    this.header = new Int32Array(buffer, 0, HEADER_INTS);
    this.data = new Int16Array(buffer, HEADER_INTS * 4, capacityFrames * 2);
    this.shared = typeof SharedArrayBuffer === 'function' && buffer instanceof SharedArrayBuffer;
    this.dropped = 0;
    this.underruns = 0;
  }

  load(i) { return this.shared ? Atomics.load(this.header, i) : this.header[i]; }
  store(i, v) { if (this.shared) Atomics.store(this.header, i, v); else this.header[i] = v; }

  available() {
    const w = this.load(WRITE);
    const r = this.load(READ);
    return (w - r + 2 * this.capacity) % (2 * this.capacity);
  }

  free() { return this.capacity - this.available(); }

  // samples: Int16Array, interleaved L R. Returns frames written; frames
  // that do not fit are dropped (counted in .dropped) so the core never
  // blocks on audio.
  push(samples, frames = samples.length >> 1) {
    const n = Math.min(frames, this.free());
    let w = this.load(WRITE);
    for (let f = 0; f < n; f++) {
      const slot = (w % this.capacity) * 2;
      this.data[slot] = samples[f * 2];
      this.data[slot + 1] = samples[f * 2 + 1];
      w = (w + 1) % (2 * this.capacity);
    }
    this.store(WRITE, w);
    this.dropped += frames - n;
    return n;
  }

  // Consumer only: drops up to frames of the oldest unplayed audio. Returns
  // frames dropped.
  skip(frames) {
    const n = Math.max(0, Math.min(frames, this.available()));
    this.store(READ, (this.load(READ) + n) % (2 * this.capacity));
    return n;
  }

  // Fills two Float32Arrays (one per channel). Missing frames are silence
  // and counted in .underruns (once per short pull). Returns frames read.
  pull(left, right) {
    const want = left.length;
    const n = Math.min(want, this.available());
    let r = this.load(READ);
    for (let f = 0; f < n; f++) {
      const slot = (r % this.capacity) * 2;
      left[f] = this.data[slot] / 32768;
      right[f] = this.data[slot + 1] / 32768;
      r = (r + 1) % (2 * this.capacity);
    }
    this.store(READ, r);
    if (n < want) {
      left.fill(0, n);
      right.fill(0, n);
      this.underruns++;
    }
    return n;
  }
}
