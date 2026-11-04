// race-pair.js: shows the two halves of the race screen together.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// The race screen is two boards: the master (board0) draws the left half and
// its graphics partner (BoardId 1) the right half. Their game state is in
// lockstep (the snapshot multiboard barrier, four syncs per guest vblank),
// but each board used to commit its own page canvas, so one half could show
// a frame or more after the other. Now each of the two board workers renders
// into its own OffscreenCanvas and posts every rendered frame as an
// ImageBitmap with its sync index; the page keeps a short queue per side
// and, once per animation frame, shows the newest pair with the same guest
// vblank number. Nothing here waits on or talks back to a board, so the
// emulation never slows for the display.
//
// Guest vblank number: each worker reads its board's own sync index from its
// log header in the cabinet buffer after a rendered frame (the count of sync
// points passed, four per vblank, multiboard.cpp BaseSyncCycles). The
// master's first sync point only starts the partner (multiboard.cpp
// syncWait), so at the same guest moment the master's count is one less than
// the partner's. vblankNumber() puts both on the partner's scale.
//
// Both boards draw every second vblank during play. Usually they draw on the
// same vblank (equal numbers); after one of them misses a vblank they can
// draw on alternate ones for a while, and then no frame of one side has an
// equal number on the other. The nearest one (one vblank, 16.7 ms of game
// time, apart) is shown with it then, which is what the two boards drew.

import { CABINET_TOTAL_BYTES } from './lb-lockstep.js';

export const MASTER = 0;
export const PARTNER = 1;
// Multiboard sync points per guest vblank (multiboard.cpp: "4 times per frame").
export const SYNCS_PER_VBLANK = 4;
// The master's sync count trails the partner's by one at the same moment.
export const MASTER_SYNC_LAG = 1;
// A pair may be this many vblanks apart when no exact pair exists.
export const PAIR_TOLERANCE = 1;
// MultiboardSnapshotLayout (linkbus.h): one log region per board after the live layout,
// each a 16-byte header (i32 entries, sync index, AND mask, OR mask) then 0x80000 entries of 8 bytes.
const SNAPSHOT_LOG_BYTES = 16 + 0x80000 * 8;

// Byte offset of a board's snapshot log header in the cabinet buffer; the
// sync index is the Int32 at offset + 4.
export function syncHeaderOffset(boardId) {
  return CABINET_TOTAL_BYTES + boardId * SNAPSHOT_LOG_BYTES;
}

// The guest vblank number of a frame from its board's sync count (see the
// header), or the board's own frame count when there is no sync count
// (live bank): then the two sides are not comparable and only show alone.
export function vblankNumber(side, syncs) {
  if (!Number.isFinite(syncs) || syncs < 0) return -1;
  return Math.round((side === MASTER ? syncs + MASTER_SYNC_LAG : syncs) / SYNCS_PER_VBLANK);
}

// createFramePairer({ depth, soloAfterMs, aloneWaitMs, tolerance, nearWaitMs, onDrop })
//   push(side, frame)  frame: { key, t (arrival, ms), ... }; keys only grow
//                      per side (a smaller or equal key replaces the queue's
//                      tail, keeping the older arrival time); a negative key
//                      never pairs
//   take(now)          the newest pair with equal keys, or at most tolerance
//                      apart (see find): { a, b, paired: true }. Else a
//                      side's newest frame on its own { a, b, paired: false }
//                      when due (see alone: no key or a stuck key, boot, the
//                      other side not drawing). Else null. Frames
//                      older than the ones returned go to onDrop.
//   clear()            drops everything queued
export function createFramePairer({ depth = 8, soloAfterMs = 100, aloneWaitMs = 20, tolerance = PAIR_TOLERANCE, nearWaitMs = 12, onDrop = () => {} } = {}) {
  const q = [[], []];
  const lastShown = [-Infinity, -Infinity]; // key of each side's last shown frame
  let lastPair = 0; // when a pair was last shown (the clock of take(now))
  const stats = { pushed: [0, 0], paired: 0, exact: 0, near: 0, solo: 0, dropped: 0, lastKey: -1 };
  const drop = (fr) => { stats.dropped++; try { onDrop(fr); } catch { /* display only */ } };

  function push(side, frame) {
    const list = q[side];
    stats.pushed[side]++;
    // A replaced frame keeps its arrival time, so a side whose key stops
    // growing (a stuck sync count, or none) still ages into being shown.
    let t = frame.t;
    while (list.length && list[list.length - 1].key >= frame.key) {
      const old = list.pop();
      if (old.t < t) t = old.t;
      drop(old);
    }
    list.push(t === frame.t ? frame : { ...frame, t });
    while (list.length > depth) drop(list.shift());
  }

  function takeUpTo(side, i) {
    const list = q[side];
    const fr = list[i];
    for (let k = 0; k < i; k++) drop(list[k]);
    list.splice(0, i + 1);
    return fr;
  }

  // The pair to show now. Equal keys always may; keys up to tolerance apart
  // may once the newer frame's equal partner can no longer come (the other
  // side has passed its key) or it has waited nearWaitMs. Choice: the newest
  // master frame, then an equal pair, then the same offset as the last near
  // pair (boards on alternate vblanks keep one pairing, so neither side
  // skips a frame by the pairing flipping between the frame before and the
  // frame after), then the newest partner frame.
  let lastOffset = 0;
  function find(now) {
    const [A, B] = q;
    let best = null;
    for (let i = 0; i < A.length; i++) {
      for (let j = 0; j < B.length; j++) {
        const ka = A[i].key;
        const kb = B[j].key;
        if (ka < 0 || kb < 0) continue;
        const d = ka - kb;
        if (d > tolerance || d < -tolerance) continue;
        if (d !== 0) {
          const newer = d > 0 ? A[i] : B[j];
          const other = d > 0 ? B : A;
          const passed = other.length > 0 && other[other.length - 1].key > newer.key;
          if (!passed && !(now - newer.t >= nearWaitMs)) continue;
        }
        const rank = [ka, d === 0 ? 1 : 0, d === lastOffset ? 1 : 0, kb];
        if (!best || better(rank, best.rank)) best = { i, j, rank, d };
      }
    }
    if (best && best.d !== 0) lastOffset = best.d;
    return best;
  }
  const better = (x, y) => {
    for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) return x[k] > y[k];
    return false;
  };

  // A frame that can never pair: no key (no sync count), or a key that did
  // not grow past what its side already showed (a stuck sync count).
  const unpairable = (side, fr) => fr.key < 0 || fr.key <= lastShown[side];
  const shown = (side, fr) => { if (fr && fr.key > lastShown[side]) lastShown[side] = fr.key; return fr; };

  function take(now) {
    const hit = find(now);
    if (hit) {
      const a = shown(MASTER, takeUpTo(MASTER, hit.i));
      const b = shown(PARTNER, takeUpTo(PARTNER, hit.j));
      lastPair = now;
      stats.paired++;
      if (hit.d === 0) stats.exact++;
      else stats.near++;
      stats.lastKey = a.key;
      return { a, b, paired: true };
    }
    // Alone, a side's newest frame: at once when it can never pair; when the
    // side's oldest queued frame has found no partner in soloAfterMs (the
    // other side is not drawing: boot, a screen change); or, once no pair
    // has been shown for soloAfterMs, when its oldest queued frame has waited
    // aloneWaitMs (so a lone side keeps its frame rate, while two drawing
    // sides, a few ms apart, still meet).
    const alone = (side) => {
      const list = q[side];
      if (!list.length) return null;
      const newest = list[list.length - 1];
      const due = unpairable(side, newest) || now - list[0].t >= soloAfterMs
        || (now - lastPair >= soloAfterMs && now - list[0].t >= aloneWaitMs);
      return due ? shown(side, takeUpTo(side, list.length - 1)) : null;
    };
    const a = alone(MASTER);
    const b = alone(PARTNER);
    if (!a && !b) return null;
    stats.solo++;
    return { a, b, paired: false };
  }

  function clear() {
    for (const list of q) while (list.length) drop(list.shift());
  }

  return { push, take, clear, stats, queued: () => [q[0].length, q[1].length] };
}
