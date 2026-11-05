// feel-trace.js: lab timing trace of one board's runs (feel.html,
// tools/feel-run.mjs). A Float64 ring on a SharedArrayBuffer: the board
// worker writes one record per retro_run, the page reads them. Times only;
// no guest memory. Never used on a player page.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Record fields (absolute ms = performance.timeOrigin + now, one scale for
// every thread): frame, run start, run end, first linkbus post (just after
// the vblank barrier; 0 if none), joypad mask of port 0 taken for the run,
// vblank count before the run, the next round's release time on the hub's
// schedule (0 unpaced), the late latch lead in ms (-1 off), the first
// vblank barrier entry of the run (0 if none).

export const TRACE = Object.freeze({ fields: ['f', 'start', 'end', 'post', 'mask', 'vb', 'due', 'lead', 'barrier'], width: 9, records: 4096, header: 8 });

export function allocateTrace() {
  return new SharedArrayBuffer((TRACE.header + TRACE.width * TRACE.records) * 8);
}

export function traceWrite(f64, values) {
  const n = f64[0];
  const at = TRACE.header + (n % TRACE.records) * TRACE.width;
  for (let i = 0; i < TRACE.width; i++) f64[at + i] = values[i] ?? 0;
  f64[0] = n + 1;
}

// Records written since `from` (a count), oldest first, as objects; the
// ring keeps the newest TRACE.records.
export function traceRead(f64, from = 0) {
  const n = f64[0];
  const out = [];
  for (let k = Math.max(from, n - TRACE.records); k < n; k++) {
    const at = TRACE.header + (k % TRACE.records) * TRACE.width;
    const r = {};
    TRACE.fields.forEach((name, i) => { r[name] = f64[at + i]; });
    out.push(r);
  }
  return { next: n, records: out };
}
