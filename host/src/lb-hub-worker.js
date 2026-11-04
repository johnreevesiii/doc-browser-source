// lb-hub-worker.js: runs the LinkBus hub (lb-lockstep.js) of the
// single-page cabinet in its own worker, so it can block with Atomics.wait.
// No network code: the seats are workers in the same page.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// init message: { n, mailboxes: [SharedArrayBuffer], sessionTag, edition,
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

import { createLockstepHub, mailboxViews, readTx, deliver, MB } from './lb-lockstep.js';

export const HUB_STATUS = Object.freeze({
  round: 0, waitingSeat: 1, running: 2, emptyRounds: 3, overruns: 4, busyMs: 5, lateResets: 6, lateMs: 7,
  txSeq: 8, refused: 16, sizeMismatch: 24, unsized: 32, words: 64,
});

function run({ n, mailboxes, sessionTag, edition, status, ctl }) {
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
  for (;;) {
    const r = hub.round() + 1; // the round being assembled: vblank r
    for (let i = 0; i < n; i++) {
      for (;;) {
        if (Atomics.load(c, 0)) { Atomics.store(st, HUB_STATUS.running, 0); return; }
        const reached = Atomics.load(views[i].i32, VB);
        if (reached >= r) {
          if (reached > r) Atomics.add(st, HUB_STATUS.overruns, 1); // passed a barrier without its round (timeout)
          break;
        }
        Atomics.store(st, HUB_STATUS.waitingSeat, i);
        Atomics.wait(views[i].i32, VB, reached, 200);
      }
    }
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
      for (let left = due - performance.now(); left > 0.05; left = due - performance.now()) Atomics.wait(sleeper, 0, 0, left);
    } else {
      t0 = 0;
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

if (typeof self !== 'undefined' && typeof window === 'undefined') {
  self.onmessage = (e) => {
    if (e.data && e.data.type === 'init') {
      try {
        run(e.data);
        self.postMessage({ type: 'hub-stopped' });
      } catch (err) {
        self.postMessage({ type: 'hub-error', message: String(err && err.stack ? err.stack : err) });
      }
    }
  };
}
