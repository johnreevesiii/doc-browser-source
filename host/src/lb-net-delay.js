// lb-net-delay.js: LAB ONLY. A delay and jitter model for the in-page LinkBus
// hub, to estimate how much link delay the game tolerates when seat boards
// run in remote browsers and the master pair, the hub and filler seats run on
// a server. No network code: every board is still a worker in one page on
// one PC; the hub only holds frames back as if they crossed a network.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Model (a star through the hub, as a server hub would be):
//   - seat j's slot frame reaches the hub upMs(j) + jitter after it was
//     published, and the hub's frame for seat t reaches t downMs(t) + jitter
//     after the hub sent it. So a frame from j is visible to t after
//     up(j) + down(t) (+ jitter), 0 for two server boards.
//   - Delivery per (source, target) pair is in order (a stream, as an
//     ordered network transport would be): a frame never arrives before the
//     one sent before it, so jitter delays but never reorders.
//   - Jitter is uniform in [0, jitterMs] per frame and direction, from a
//     seeded generator, so a run can be repeated.
//
// Two hub modes use it (lb-hub-worker.js runNet):
//   strict:  the vblank barrier as today, but every round waits for each
//            delayed seat's report (up) and its release (down). Measures the
//            vblank rate a per-frame barrier reaches over a link.
//   relaxed: no cross-board barrier. Each seat is released one vblank per hub
//            tick by a clock (real time when paced; unpaced, a tick waits for
//            every present seat, so the clock is virtual: tick * 1000 / 60 ms).
//            Each target gets, per tick, the newest frame of every source
//            that has arrived by then. This is what the game's own link
//            (NaomiM3Comm::vblank takes the latest packet) would see.

export const VBLANK_MS = 1000 / 60;

// Small seeded generator (mulberry32), so jitter repeats across runs.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// cfg: { up: [ms per node], down: [ms per node], jitter: [ms per node] }.
// A node with up = down = jitter = 0 is a server board.
export function normalizeNet(n, cfg = {}) {
  const arr = (a) => Array.from({ length: n }, (_, i) => Math.max(0, Number((a && a[i]) || 0)));
  return { up: arr(cfg.up), down: arr(cfg.down), jitter: arr(cfg.jitter) };
}

// Delay lines from every source to every target. push(j, frame, now) records
// the frame seat j published (bytes) at time now (ms). take(t, now) returns,
// for every source j, the newest frame that has reached target t by now
// (or null if none yet), and whether any of them is new since the last take
// for t. Frames older than the newest one taken by every target are dropped.
export function createDelayNet(n, cfg, seed = 1) {
  let net = normalizeNet(n, cfg);
  const rand = rng(seed);
  const jit = (ms) => (ms > 0 ? rand() * ms : 0);
  // hist[j]: frames of source j in send order: { seq, sent, hubAt, bytes }.
  const hist = Array.from({ length: n }, () => []);
  let seq = 0;
  // Per (target, source): index into hist[j] of the next frame not yet
  // arrived, the arrival time of that frame (once drawn), the last arrival
  // (order), and the frame currently held.
  const pair = Array.from({ length: n }, () => Array.from({ length: n }, () => ({ nextSeq: 0, nextAt: -1, lastAt: -Infinity, held: null })));
  const stats = { pushed: 0, delivered: 0, ageSumMs: 0, ageMaxMs: 0 };

  function push(j, bytes, now) {
    const hubAt = now + net.up[j] + jit(net.jitter[j]);
    const h = hist[j];
    // In order to the hub too.
    const prev = h.length ? h[h.length - 1].hubAt : -Infinity;
    h.push({ seq: seq++, sent: now, hubAt: Math.max(hubAt, prev), bytes });
    stats.pushed++;
  }

  function take(t, now) {
    let fresh = false;
    const out = new Array(n);
    for (let j = 0; j < n; j++) {
      const p = pair[t][j];
      const h = hist[j];
      for (;;) {
        const k = h.findIndex((e) => e.seq >= p.nextSeq);
        if (k < 0) break;
        const e = h[k];
        if (p.nextAt < 0 || p.nextSeq !== e.seq) {
          p.nextSeq = e.seq;
          p.nextAt = Math.max(e.hubAt + net.down[t] + jit(net.jitter[t]), p.lastAt);
        }
        if (p.nextAt > now) break;
        p.lastAt = p.nextAt;
        p.held = e;
        p.nextSeq = e.seq + 1;
        p.nextAt = -1;
        fresh = true;
        const age = now - e.sent;
        stats.delivered++;
        stats.ageSumMs += age;
        if (age > stats.ageMaxMs) stats.ageMaxMs = age;
      }
      out[j] = p.held;
    }
    return { frames: out, fresh };
  }

  // Drop history every target has moved past.
  function trim() {
    for (let j = 0; j < n; j++) {
      let minSeq = Infinity;
      for (let t = 0; t < n; t++) minSeq = Math.min(minSeq, pair[t][j].held ? pair[t][j].held.seq : -1);
      const h = hist[j];
      let drop = 0;
      while (drop < h.length - 1 && h[drop].seq < minSeq) drop++;
      if (drop) h.splice(0, drop);
    }
  }

  // Forget a source's frames (its board was stopped): what is in flight is lost.
  function dropSource(j) {
    hist[j].length = 0;
    for (let t = 0; t < n; t++) { const p = pair[t][j]; p.nextAt = -1; p.held = null; p.nextSeq = seq; }
  }

  return {
    push, take, trim, dropSource, stats,
    set(cfgNew) { net = normalizeNet(n, cfgNew); },
    config: () => net,
    backlog: () => hist.map((h) => h.length),
  };
}

// Strict barrier timing for one round: given when each seat reached the
// barrier (ms, -1 for an absent seat), when the hub may assemble (every
// report in) and when each seat is released (its down delay after that).
export function strictRound(reachedAt, net, rand) {
  const n = reachedAt.length;
  const j = (ms) => (ms > 0 ? rand() * ms : 0);
  let assembleAt = 0;
  for (let i = 0; i < n; i++) if (reachedAt[i] >= 0) assembleAt = Math.max(assembleAt, reachedAt[i] + net.up[i] + j(net.jitter[i]));
  const releaseAt = reachedAt.map((r, i) => (r >= 0 ? assembleAt + net.down[i] + j(net.jitter[i]) : -1));
  return { assembleAt, releaseAt };
}
