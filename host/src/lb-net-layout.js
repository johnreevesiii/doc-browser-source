// lb-net-layout.js: LAB ONLY. Shared word layout of the net delay experiment
// (lb-net-delay.js, lb-hub-worker.js runNet, lb-cabinet.js net option).
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later

// Control words (Int32, the cabinet's ctl SharedArrayBuffer) beyond [0] stop,
// [1] pacing period in microseconds and [2] catch-up limit in ms.
export const NET_CTL = Object.freeze({
  mode: 3, // 0 off (the normal hub), 1 strict barrier with delay, 2 relaxed (no cross-board barrier)
  gen: 4, // bumped by the page after it changes the delay words
  seed: 5, // jitter generator seed
  up: 16, down: 32, jitter: 48, // microseconds, one word per ring node (16 nodes)
  absent: 64, // nonzero: that seat's board is stopped (rejoin test), one word per node
  words: 80,
});

// Net status words (Int32, netStatus SharedArrayBuffer): single words, then
// 16 per ring node for each per-node counter.
export const NET_STATUS = Object.freeze({
  tick: 0, mode: 1, running: 2, waitingSeat: 3, ageAvgUs: 4, ageMaxUs: 5, slotSize: 6, lateResets: 7, gen: 8,
  txFrames: 16, txBytes: 32, changedBytes: 48, deltaBytes: 64, deliveries: 80, rxBytes: 96, released: 112, absentSeen: 128,
  backlog: 144, words: 160,
});

export const NET_MODES = Object.freeze({ off: 0, strict: 1, relaxed: 2 });

// The lab page's net mode from its query: 'strict' or 'relaxed' only on a
// loopback lab server (tools/serve.mjs binds 127.0.0.1), the same gate as the
// player page's ?seats=8 (cabinet-game.js playerPageSeats); null anywhere
// else, so no other URL can turn the delay injector on.
const LAB_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
export function labNetMode(search, hostname) {
  const asked = new URLSearchParams(search || '').get('net');
  if (asked !== 'strict' && asked !== 'relaxed') return null;
  return LAB_HOSTS.has(String(hostname || '').toLowerCase()) ? asked : null;
}
