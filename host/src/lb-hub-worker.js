// lb-hub-worker.js: runs the LinkBus hub (lb-lockstep.js) of the
// single-page cabinet in its own worker, so it can block with Atomics.wait.
// No network code: the seats are workers in the same page.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// init message: { n (ring nodes: 5 for four seats, 9 for eight), mailboxes: [SharedArrayBuffer], sessionTag, edition,
//   status: SharedArrayBuffer (Int32 HUB_STATUS words), ctl: SharedArrayBuffer
//   (Int32: [0] stop, [1] pacing period in microseconds, 0 = unpaced,
//   [2] catch-up limit in ms, 0 = 250),
//   (frameCounts is passed but not used by the hub) }
//
// Vblank sync. Every seat's core runs a vblank barrier
// (linkbus_install_vblank_barrier): at its k-th guest vblank it stores k in
// its mailbox (vblankCount) and waits for hubRound >= k before the comm
// board's take and publish for that vblank. Round k waits until every seat
// has reached vblank k, assembles from each seat's newest slot frame (the
// one it published at vblank k - 1), delivers it to every seat, then stores
// hubRound = k in every mailbox. So every seat advances exactly one guest
// vblank per round, which is the native model (each board 60 vblanks a
// second, one hub tick per vblank) without its timing, and no delivery can
// land between two vblanks of a seat. The core's mailbox take() never
// blocks. A board's retro_run may span more than one vblank (a frame ends
// at a rendered frame or the render timeout); that does not matter here.
//
// With a pacing period the hub releases round k no earlier than
// start + k * period, which paces the linked boards to real time. When the
// boards fall behind by more than the catch-up limit, the schedule moves
// (lateResets, lateMs) instead of running fast to catch up, so a slow
// stretch costs real time once and never comes back as a burst. Guest time
// is unaffected: it counts rounds, not milliseconds.

import { createLockstepHub, mailboxViews, readTx, deliver, MB, HUB_STATUS, SLOT_HEADER_BYTES } from './lb-lockstep.js';
import { createDelayNet, strictRound, rng, VBLANK_MS } from './lb-net-delay.js';
import { NET_CTL, NET_STATUS } from './lb-net-layout.js';
import { absNowMs, writePaceClock, writeSeatLate } from './seat-feel.js';

export { HUB_STATUS };

// pace (optional SharedArrayBuffer, seat-feel.js PACE_WORDS): the schedule
// (origin and period) and how late each seat reached the last round's
// barrier, for the player's seat's late input latch. Timing only.
function run({ n, mailboxes, sessionTag, edition, status, ctl, pace = null }) {
  if (!(n >= 2 && n <= HUB_STATUS.maxNodes)) throw new Error(`ring of ${n} nodes: the status words hold at most ${HUB_STATUS.maxNodes}`);
  const st = new Int32Array(status);
  const c = new Int32Array(ctl);
  const views = mailboxes.map(mailboxViews);
  const hub = createLockstepHub({ n, edition, sessionTag, checkLocalFrame: false });
  const VB = MB.vblankCount >> 2;
  const HR = MB.hubRound >> 2;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(st, HUB_STATUS.running, 1);
  let t0 = 0;
  let busy = 0;
  let lateResets = 0;
  let lateMs = 0;
  const pace64 = pace ? new BigInt64Array(pace) : null;
  const arrive = new Float64Array(n);
  let paceT0 = -1;
  let pacePeriod = -1;
  for (;;) {
    const r = hub.round() + 1; // the round being assembled: vblank r
    const periodNow = Atomics.load(c, 1);
    // This round's release time on the schedule so far (performance.now()
    // scale), or 0 while unpaced or before the first paced round.
    const dueNow = periodNow > 0 && t0 > 0 ? t0 + (r * periodNow) / 1000 : 0;
    for (let i = 0; i < n; i++) {
      arrive[i] = 0;
      for (;;) {
        if (Atomics.load(c, 0)) { Atomics.store(st, HUB_STATUS.running, 0); return; }
        const reached = Atomics.load(views[i].i32, VB);
        if (reached >= r) {
          if (reached > r) Atomics.add(st, HUB_STATUS.overruns, 1); // passed a barrier without its round (timeout)
          break;
        }
        Atomics.store(st, HUB_STATUS.waitingSeat, i);
        Atomics.wait(views[i].i32, VB, reached, 200);
        arrive[i] = performance.now(); // this seat kept the hub waiting
      }
    }
    if (pace64) for (let i = 0; i < n; i++) writeSeatLate(pace64, i, dueNow > 0 && arrive[i] > 0 ? arrive[i] - dueNow : 0);
    Atomics.store(st, HUB_STATUS.waitingSeat, -1);
    const ta = performance.now();
    const frames = views.map((v, i) => {
      const t = readTx(v);
      Atomics.store(st, HUB_STATUS.txSeq + i, t.txSeq);
      return t.txSeq ? t.bytes : new Uint8Array(0);
    });
    const out = hub.step(frames);
    const periodUs = Atomics.load(c, 1);
    if (periodUs > 0) {
      if (t0 === 0) t0 = performance.now() - ((r - 1) * periodUs) / 1000;
      let due = t0 + (r * periodUs) / 1000;
      const limit = Atomics.load(c, 2) || 250;
      const behind = performance.now() - due;
      if (behind > limit) {
        t0 += behind;
        due += behind;
        lateResets++;
        lateMs += behind;
        Atomics.store(st, HUB_STATUS.lateResets, lateResets);
        Atomics.store(st, HUB_STATUS.lateMs, Math.round(lateMs));
      }
      if (pace64 && (t0 !== paceT0 || periodUs !== pacePeriod)) {
        paceT0 = t0; pacePeriod = periodUs;
        writePaceClock(pace64, t0 + (absNowMs() - performance.now()), periodUs);
      }
      for (let left = due - performance.now(); left > 0.05; left = due - performance.now()) Atomics.wait(sleeper, 0, 0, left);
    } else {
      t0 = 0;
      if (pace64 && paceT0 !== 0) { paceT0 = 0; writePaceClock(pace64, 0, 0); }
    }
    for (let t = 0; t < n; t++) deliver(views[t], out[t]);
    for (let t = 0; t < n; t++) {
      Atomics.store(views[t].i32, HR, r);
      Atomics.notify(views[t].i32, HR);
    }
    busy += performance.now() - ta;
    Atomics.store(st, HUB_STATUS.round, hub.round());
    Atomics.notify(st, HUB_STATUS.round);
    Atomics.store(st, HUB_STATUS.emptyRounds, hub.stats.emptyRounds);
    Atomics.store(st, HUB_STATUS.busyMs, Math.round(busy));
    for (let i = 0; i < n; i++) {
      Atomics.store(st, HUB_STATUS.refused + i, hub.stats.refused[i]);
      Atomics.store(st, HUB_STATUS.sizeMismatch + i, hub.stats.sizeMismatch[i]);
      Atomics.store(st, HUB_STATUS.unsized + i, hub.stats.unsized[i]);
    }
  }
}

// LAB ONLY: the hub with a delay and jitter injector (lb-net-delay.js).
// mode 1 strict: the barrier above, with each round waiting for every delayed
// seat's report (up) and release (down), in real time. mode 2 relaxed: no
// cross-board barrier; each present seat is released one vblank per tick
// (paced: a real-time clock; unpaced: a tick waits for every present seat,
// virtual time tick * 1000 / 60 ms), and each target gets the newest frame of
// every source that has reached it (frames are held back by the injector).
// Seats marked absent (ctl NET_CTL.absent) are skipped: their board was
// stopped; what they had in flight is dropped.
function runNet({ n, mailboxes, sessionTag, edition, status, ctl, netStatus }) {
  const st = new Int32Array(status);
  const ns = new Int32Array(netStatus);
  const c = new Int32Array(ctl);
  const views = mailboxes.map(mailboxViews);
  const mode = Atomics.load(c, NET_CTL.mode);
  const VB = MB.vblankCount >> 2;
  const HR = MB.hubRound >> 2;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const sleepUntil = (t) => { for (let left = t - performance.now(); left > 0.05; left = t - performance.now()) Atomics.wait(sleeper, 0, 0, left); };
  const readNet = () => ({
    up: Array.from({ length: n }, (_, i) => Atomics.load(c, NET_CTL.up + i) / 1000),
    down: Array.from({ length: n }, (_, i) => Atomics.load(c, NET_CTL.down + i) / 1000),
    jitter: Array.from({ length: n }, (_, i) => Atomics.load(c, NET_CTL.jitter + i) / 1000),
  });
  const absent = (i) => Atomics.load(c, NET_CTL.absent + i) !== 0;
  let gen = Atomics.load(c, NET_CTL.gen);
  let cfg = readNet();
  const seed = Atomics.load(c, NET_CTL.seed) || 1;
  const rand = rng(seed ^ 0x5eed);
  const net = createDelayNet(n, cfg, seed);
  Atomics.store(ns, NET_STATUS.mode, mode);
  Atomics.store(ns, NET_STATUS.running, 1);
  Atomics.store(st, HUB_STATUS.running, 1);
  const lastTx = new Array(n).fill(-1);
  const lastPayload = new Array(n).fill(null);
  const wasAbsent = new Array(n).fill(false);
  const counters = { txFrames: new Array(n).fill(0), txBytes: new Array(n).fill(0), changed: new Array(n).fill(0), delta: new Array(n).fill(0),
    deliveries: new Array(n).fill(0), rxBytes: new Array(n).fill(0), released: new Array(n).fill(0) };
  const stopped = () => Atomics.load(c, 0) !== 0;
  const checkConfig = () => {
    const g = Atomics.load(c, NET_CTL.gen);
    if (g !== gen) { gen = g; cfg = readNet(); net.set(cfg); Atomics.store(ns, NET_STATUS.gen, g); }
    for (let i = 0; i < n; i++) {
      const a = absent(i);
      if (a && !wasAbsent[i]) { net.dropSource(i); lastTx[i] = -1; lastPayload[i] = null; }
      wasAbsent[i] = a;
      Atomics.store(ns, NET_STATUS.absentSeen + i, a ? 1 : 0);
    }
  };
  // Bandwidth counters for one slot frame of seat j (count only: bytes, bytes
  // changed since its previous frame, and a run-length delta size estimate:
  // 3 bytes of offset and length per changed run plus the changed bytes).
  const countTx = (j, bytes) => {
    counters.txFrames[j]++;
    counters.txBytes[j] += bytes.length;
    const p = bytes.subarray(SLOT_HEADER_BYTES);
    const q = lastPayload[j];
    if (q && q.length === p.length) {
      let changed = 0;
      let runs = 0;
      let inRun = false;
      for (let k = 0; k < p.length; k++) {
        if (p[k] !== q[k]) { changed++; if (!inRun) { runs++; inRun = true; } } else inRun = false;
      }
      counters.changed[j] += changed;
      counters.delta[j] += changed + 3 * runs;
    } else {
      counters.changed[j] += p.length;
      counters.delta[j] += p.length;
    }
    lastPayload[j] = p.slice();
  };
  const publishStatus = (tick) => {
    Atomics.store(ns, NET_STATUS.tick, tick);
    const s = net.stats;
    Atomics.store(ns, NET_STATUS.ageAvgUs, s.delivered ? Math.round((s.ageSumMs / s.delivered) * 1000) : 0);
    Atomics.store(ns, NET_STATUS.ageMaxUs, Math.round(s.ageMaxMs * 1000));
    const bl = net.backlog();
    for (let i = 0; i < n; i++) {
      Atomics.store(ns, NET_STATUS.txFrames + i, counters.txFrames[i]);
      Atomics.store(ns, NET_STATUS.txBytes + i, counters.txBytes[i]);
      Atomics.store(ns, NET_STATUS.changedBytes + i, counters.changed[i]);
      Atomics.store(ns, NET_STATUS.deltaBytes + i, counters.delta[i]);
      Atomics.store(ns, NET_STATUS.deliveries + i, counters.deliveries[i]);
      Atomics.store(ns, NET_STATUS.rxBytes + i, counters.rxBytes[i]);
      Atomics.store(ns, NET_STATUS.released + i, counters.released[i]);
      Atomics.store(ns, NET_STATUS.backlog + i, bl[i]);
    }
  };
  const release = (i, r) => {
    Atomics.store(views[i].i32, HR, r);
    Atomics.notify(views[i].i32, HR);
    counters.released[i]++;
  };

  if (mode === 1) {
    // Strict: as run(), plus the delays.
    const hub = createLockstepHub({ n, edition, sessionTag, checkLocalFrame: false });
    let t0 = 0;
    let lateResets = 0;
    for (;;) {
      checkConfig();
      const r = hub.round() + 1;
      const reachedAt = new Array(n).fill(-1);
      for (let i = 0; i < n; i++) {
        if (absent(i)) continue;
        for (;;) {
          if (stopped()) { Atomics.store(st, HUB_STATUS.running, 0); Atomics.store(ns, NET_STATUS.running, 0); return; }
          const reached = Atomics.load(views[i].i32, VB);
          if (reached >= r) { if (reached > r) Atomics.add(st, HUB_STATUS.overruns, 1); break; }
          Atomics.store(st, HUB_STATUS.waitingSeat, i);
          Atomics.wait(views[i].i32, VB, reached, 200);
        }
        reachedAt[i] = performance.now();
      }
      Atomics.store(st, HUB_STATUS.waitingSeat, -1);
      const plan = strictRound(reachedAt, cfg, rand);
      sleepUntil(plan.assembleAt);
      const frames = views.map((v, i) => {
        if (reachedAt[i] < 0) return new Uint8Array(0);
        const t = readTx(v);
        if (t.txSeq && t.txSeq !== lastTx[i]) { lastTx[i] = t.txSeq; countTx(i, t.bytes); }
        return t.txSeq ? t.bytes : new Uint8Array(0);
      });
      const out = hub.step(frames);
      Atomics.store(ns, NET_STATUS.slotSize, hub.slotSize());
      let shift = 0;
      const periodUs = Atomics.load(c, 1);
      if (periodUs > 0) {
        if (t0 === 0) t0 = performance.now() - ((r - 1) * periodUs) / 1000;
        let due = t0 + (r * periodUs) / 1000;
        const limit = Atomics.load(c, 2) || 250;
        const behind = performance.now() - due;
        if (behind > limit) { t0 += behind; due += behind; lateResets++; Atomics.store(ns, NET_STATUS.lateResets, lateResets); }
        const before = performance.now();
        sleepUntil(due);
        shift = performance.now() - before;
      } else t0 = 0;
      const order = [...Array(n).keys()].filter((i) => plan.releaseAt[i] >= 0).sort((a, b) => plan.releaseAt[a] - plan.releaseAt[b]);
      for (const i of order) {
        sleepUntil(plan.releaseAt[i] + shift);
        deliver(views[i], out[i]);
        counters.deliveries[i]++;
        counters.rxBytes[i] += out[i].length;
        release(i, r);
      }
      Atomics.store(st, HUB_STATUS.round, hub.round());
      Atomics.notify(st, HUB_STATUS.round);
      if ((r & 15) === 0) publishStatus(r);
    }
  }

  // Relaxed. One lockstep assembler per target: each target gets its own view
  // of the sources (what has reached it), and the assembler keeps a slot's
  // previous bytes when nothing is there for it (as natively).
  const asm = Array.from({ length: n }, () => createLockstepHub({ n, edition, sessionTag, checkLocalFrame: false }));
  const empty = new Uint8Array(0);
  let t0 = performance.now();
  let lateResets = 0;
  for (let tick = 1; ; tick++) {
    checkConfig();
    if (stopped()) { Atomics.store(st, HUB_STATUS.running, 0); Atomics.store(ns, NET_STATUS.running, 0); return; }
    let now;
    const periodUs = Atomics.load(c, 1);
    if (periodUs > 0) {
      // Real-time clock: one tick per period, no waiting for any board.
      let due = t0 + (tick * periodUs) / 1000;
      const limit = Atomics.load(c, 2) || 250;
      const behind = performance.now() - due;
      if (behind > limit) { t0 += behind; due += behind; lateResets++; Atomics.store(ns, NET_STATUS.lateResets, lateResets); }
      sleepUntil(due);
      now = performance.now();
    } else {
      // Virtual clock: the tick waits until every present seat is at its barrier.
      for (let i = 0; i < n; i++) {
        for (;;) {
          if (stopped()) { Atomics.store(st, HUB_STATUS.running, 0); Atomics.store(ns, NET_STATUS.running, 0); return; }
          checkConfig();
          if (absent(i)) break;
          const reached = Atomics.load(views[i].i32, VB);
          if (reached > Atomics.load(views[i].i32, HR)) break;
          Atomics.store(ns, NET_STATUS.waitingSeat, i);
          Atomics.wait(views[i].i32, VB, reached, 200);
        }
      }
      Atomics.store(ns, NET_STATUS.waitingSeat, -1);
      now = tick * VBLANK_MS;
    }
    for (let j = 0; j < n; j++) {
      if (absent(j)) continue;
      const t = readTx(views[j]);
      if (t.txSeq && t.txSeq !== lastTx[j]) { lastTx[j] = t.txSeq; countTx(j, t.bytes); net.push(j, t.bytes, now); }
    }
    for (let t = 0; t < n; t++) {
      if (absent(t)) continue;
      const got = net.take(t, now);
      if (got.fresh) {
        const out = asm[t].step(got.frames.map((e) => (e ? e.bytes : empty)));
        deliver(views[t], out[t]);
        counters.deliveries[t]++;
        counters.rxBytes[t] += out[t].length;
        if (t === 0) Atomics.store(ns, NET_STATUS.slotSize, asm[0].slotSize());
      }
    }
    // Release: one vblank per tick for every seat waiting at its barrier.
    for (let i = 0; i < n; i++) {
      if (absent(i)) continue;
      const reached = Atomics.load(views[i].i32, VB);
      if (reached > Atomics.load(views[i].i32, HR)) release(i, reached);
    }
    net.trim();
    Atomics.store(st, HUB_STATUS.round, tick);
    Atomics.notify(st, HUB_STATUS.round);
    if ((tick & 15) === 0) publishStatus(tick);
  }
}

if (typeof self !== 'undefined' && typeof window === 'undefined') {
  self.onmessage = (e) => {
    if (e.data && e.data.type === 'init') {
      try {
        // LAB ONLY: a net mode in ctl selects the delay injector hub.
        if (e.data.netStatus && new Int32Array(e.data.ctl).length > NET_CTL.mode && new Int32Array(e.data.ctl)[NET_CTL.mode] > 0) runNet(e.data);
        else run(e.data);
        self.postMessage({ type: 'hub-stopped' });
      } catch (err) {
        self.postMessage({ type: 'hub-error', message: String(err && err.stack ? err.stack : err) });
      }
    }
  };
}
