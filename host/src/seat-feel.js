// seat-feel.js: what the player feels on their own seat (input timing).
// Pure helpers shared by the page, the hub worker and the board workers.
// No network code. Nothing here reaches guest state except the joypad mask
// the seat board already reads once per retro_run.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Input word layout (SharedArrayBuffer, Int32 x INPUT_WORDS):
//   [0..3]  live joypad mask of ports 0..3 (what is held now)
//   [4..7]  pressed since the board last latched (sticky bits): a tap that
//           starts and ends between two latches is still seen for one frame
// The page writes on every key or pad change (writeInputMask), not once per
// animation frame; the seat board takes live | sticky right before each
// retro_run (takeInputMask) and clears the sticky bits it took.
//
// Pace clock (SharedArrayBuffer, BigInt64 x PACE_WORDS), written by the hub:
//   [0] schedule origin t0 in microseconds of absolute time (timeOrigin +
//       now, the same scale in every worker), 0 while unpaced
//   [1] pacing period in microseconds
//   [2 + seat] how late that seat reached the vblank barrier of the last
//       round, in microseconds after the round's release time (0 when the
//       hub did not have to wait for it)
// Round r is released no earlier than t0 + r * period (lb-hub-worker.js).
// The seat board uses it to latch input as late as it can (createLateLatch).

export const INPUT_PORTS = 4;
export const INPUT_WORDS = 8;
export const PACE_SEAT_WORDS = 16;
export const PACE_WORDS = 2 + PACE_SEAT_WORDS;

export const absNowMs = () => performance.timeOrigin + performance.now();

export function allocateInputBuffer() {
  return new SharedArrayBuffer(INPUT_WORDS * 4);
}

// Page side: the port's live mask; bits that were not held before become
// sticky until the board takes them (held keys never linger after release).
export function writeInputMask(i32, port, mask) {
  if (port < 0 || port >= INPUT_PORTS) return;
  const prev = Atomics.exchange(i32, port, mask);
  const newly = mask & ~prev;
  if (newly && i32.length >= INPUT_WORDS) Atomics.or(i32, INPUT_PORTS + port, newly);
}

// Board side: live | sticky, clearing the sticky bits (an older 4-word
// buffer has no sticky bits).
export function takeInputMask(i32, port) {
  const live = Atomics.load(i32, port);
  return i32.length >= INPUT_WORDS ? live | Atomics.exchange(i32, INPUT_PORTS + port, 0) : live;
}

export function clearInput(i32) {
  for (let i = 0; i < i32.length; i++) Atomics.store(i32, i, 0);
}

export function writePaceClock(i64, t0Ms, periodUs) {
  Atomics.store(i64, 0, BigInt(Math.round(t0Ms * 1000)));
  Atomics.store(i64, 1, BigInt(Math.round(periodUs)));
}

// { t0Ms, periodMs } or null while unpaced.
export function readPaceClock(i64) {
  const t0 = Number(Atomics.load(i64, 0));
  const p = Number(Atomics.load(i64, 1));
  return t0 > 0 && p > 0 ? { t0Ms: t0 / 1000, periodMs: p / 1000 } : null;
}

export function writeSeatLate(i64, seat, lateMs) {
  if (seat >= 0 && seat < PACE_SEAT_WORDS) Atomics.store(i64, 2 + seat, BigInt(Math.max(0, Math.round(lateMs * 1000))));
}

export function readSeatLate(i64, seat) {
  return seat >= 0 && seat < PACE_SEAT_WORDS ? Number(Atomics.load(i64, 2 + seat)) / 1000 : 0;
}

// Late latch for the player's seat. The seat board's retro_run starts, takes
// the input, runs to the guest vblank and then waits at the vblank barrier
// until the hub releases that round; on a fast machine most of a frame is
// spent waiting there, so the input it took is up to a frame old by the time
// the game reads it. Starting the run `lead` ms before the round's release
// time instead keeps that wait short and the input fresh.
// The lead comes from the run's own work before the barrier (preMs: run
// start to barrier entry, measured every run): a high percentile of the
// recent runs plus a margin. A run that still reached the barrier after the
// release (lateMs > 0) adds that much again, given back slowly. Guest state
// never sees any of this: the board runs the same frames with the same
// inputs, only the wall-clock moment of the latch moves. A machine that
// cannot keep up drives the lead to its cap, which is the old behaviour
// (start at once).
//   nextStart(dueMs) -> the absolute ms to start the next run
//   update({ preMs, lateMs }) after the run (missing or NaN: no news)
export function createLateLatch({ minLeadMs = 2, maxLeadMs = 17, startLeadMs = 12, marginMs = 1.5, window = 120, quantile = 0.98, penaltyDecayMs = 0.25 } = {}) {
  const pre = new Float64Array(Math.max(8, window | 0));
  let n = 0;
  let idx = 0;
  let base = startLeadMs;
  let penalty = 0;
  const stats = { runs: 0, late: 0, waits: 0, waitMs: 0 };
  const clamp = (v) => Math.min(maxLeadMs, Math.max(minLeadMs, v));
  return {
    get leadMs() { return clamp(base + penalty); },
    stats,
    nextStart(dueMs) {
      return dueMs - clamp(base + penalty);
    },
    update({ preMs, lateMs } = {}) {
      stats.runs++;
      if (preMs >= 0 && preMs < 1000) {
        pre[idx] = preMs;
        idx = (idx + 1) % pre.length;
        if (n < pre.length) n++;
        if (n >= 8) {
          const sorted = Array.from(pre.subarray(0, n)).sort((a, b) => a - b);
          base = sorted[Math.min(n - 1, Math.floor(quantile * n))] + marginMs;
        }
      }
      if (lateMs > 0.25) {
        stats.late++;
        penalty = Math.min(maxLeadMs, penalty + lateMs);
      } else {
        penalty = Math.max(0, penalty - penaltyDecayMs);
      }
    },
  };
}
