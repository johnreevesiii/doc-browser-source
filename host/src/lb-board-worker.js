// lb-board-worker.js: one DOC board of the single-page cabinet, in a module
// worker (doc-wasm/linkbus2). Loads the core, sets the board's link role,
// installs the LinkBus mailbox (seats, frame sync) and the SAB multiboard
// backend (master pair), then runs frames. No network code.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Board settings follow the native lab (lab_config.py, start_lab.ps1):
//   board 0, seat 0:  NetworkEnable, ActAsServer, MultiboardSlaves 2, SAB multiboard
//   partner:          BoardId 1 (graphics board of the master pair), same options,
//                     SAB multiboard, no ring; started only when board 0
//                     posts linkbus-start-partners (multiboard.cpp startSlave)
//   boards 1..4:      seats 1..4, NetworkEnable, ActAsServer off, MultiboardSlaves 1
//
// The core is the linkbus2 link output, served at ./core/ by tools/serve.mjs.

import createFlycastCore from './core/flycast_libretro.js';
import { FS_PATHS, DEFAULT_CORE_OPTIONS, mountRom } from './core-bridge.js';
import { mountCard, createCardWatcher } from './card-store.js';
import { AudioRing } from './audio-ring.js';
import { syncHeaderOffset } from './race-pair.js';

// Game state words watched every frame (addresses from tools/probe-page.mjs
// WATCH, Rev C): only changes are reported, as [frame, name, value].
const WATCH = [['scene', 0x0C21A0F0], ['state', 0x0C21A2A8], ['role', 0x0C21A134], ['race_on', 0x0C3C12B8],
  ['recv_state', 0x0C21A2AC], ['phase', 0x0C21A284], ['done_mask', 0x0C21A278], ['rec_104', 0x0C21A610]];

const BIOS = new Set(['naomi.zip', 'naomi2.zip', 'awbios.zip', 'dc_boot.bin', 'dc_flash.bin']);
const hex32 = (v) => (v >>> 0).toString(16).padStart(8, '0');
const hex16 = (v) => (v >>> 0).toString(16).padStart(4, '0');
const RING_STAT_NAMES = ['published', 'taken', 'stale', 'dropped', 'badEdition', 'badSize', 'badHeader', 'staleTick'];

let cfg = null;
const hasCabinet = () => !!(cfg && cfg.cabinet);
let initDone = null;
let Module = null;
let buf = 0;
const logs = [];
// Card seat (stable game): the card file watcher; its writes go to the page.
let cardWatch = null;
// Race screen board (msg.present): { canvas, sync } and whether the last
// retro_run drew a new frame (the core's video refresh with a valid frame).
let present = null;
let rendered = false;
// This board's audio ring (msg.audio), or null. A posted race frame carries
// the ring's write index (aw) and the audio batches since the last frame
// (ab), so the page can line the picture up with its sound (diagnostics).
let audioRing = null;
let audioBatches = 0;

// After a retro_run on a race screen board: a newly drawn frame goes to the
// page with its frame count and sync index; nothing is posted for a run
// that drew nothing (the canvas would hand over an empty buffer). A failure
// here (a lost GPU context, say) drops that frame only: the board keeps
// emulating, failures are counted (present.failed) and the page gets one
// log line.
function postFrame(n) {
  if (!rendered) return;
  rendered = false;
  try {
    const bmp = present.canvas.transferToImageBitmap();
    const s = present.sync ? present.sync[1] + 1 : -1;
    const aw = audioRing ? audioRing.load(1) : -1;
    const ab = audioBatches;
    audioBatches = 0;
    self.postMessage({ type: 'frame', board: cfg.label, f: n, s, aw, ab, bmp }, [bmp]);
  } catch (err) {
    if (present.failed++ === 0) post('log', { text: `[board] a race frame was not handed over (frame ${n}); the board goes on: ${err && err.message ? err.message : err}` });
  }
}

function post(type, data = {}) {
  self.postMessage({ type, board: cfg ? cfg.label : '?', ...data });
}

function mkdirp(FS, path) {
  let cur = '';
  for (const part of path.split('/').filter(Boolean)) {
    cur += `/${part}`;
    try { FS.mkdir(cur); } catch { /* exists */ }
  }
}

function yieldTask() {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });
}

function words(n) {
  return Array.from(Module.HEAPU32.subarray(buf >> 2, (buf >> 2) + n));
}

function stateHash() {
  if (!Module._shim_dbg_state_hash(buf)) return null;
  const w = words(8);
  return { ram: hex32(w[1]) + hex32(w[0]), regs: hex32(w[3]) + hex32(w[2]), pc: hex32(w[4]), cycles: w[7] * 4294967296 + w[6] };
}

function linkStatus() {
  Module._shim_lb_status(buf);
  const s = words(8);
  const out = { comm1: hex16(s[0]), comm2: hex16(s[1]), boardId: s[2], net: s[3], server: s[4], mbSlaves: s[5], multiboard: s[6], slave: s[7] };
  const k = Module._linkbus_ring_stats(buf);
  if (k > 0) {
    const r = words(k);
    out.ring = Object.fromEntries(RING_STAT_NAMES.map((name, i) => [name, r[i]]));
  }
  Module._linkbus_mb_stats(buf);
  const m = words(10);
  out.mb = { vblanks: m[0], vblankTimeout: m[1], vblankReleased: m[2], firstTimeout: m[3], secondTimeout: m[4],
    syncMismatch: m[5], nondeterministic: m[6] };
  if (hasCabinet()) out.bank = { syncs: m[7], hash: hex32(m[9]) + hex32(m[8]) };
  return out;
}

async function init(msg) {
  cfg = msg;
  // Race screen boards (msg.present, race-pair.js): the core draws into an
  // OffscreenCanvas of this worker, and every rendered frame goes to the page
  // as an ImageBitmap, which shows the two halves together. Other boards draw
  // into the page canvas they were handed (transferControlToOffscreen).
  const canvas = msg.present ? new OffscreenCanvas(msg.present.width || 640, msg.present.height || 480) : msg.canvas;
  if (msg.present) {
    present = { canvas, sync: null, failed: 0 };
    // The board's own sync index in the snapshot bank (race-pair.js frame key).
    if (msg.cabinet && msg.bank !== 'live') present.sync = new Int32Array(msg.cabinet, syncHeaderOffset(msg.boardId), 4);
  }
  Module = await createFlycastCore({
    canvas,
    print: (t) => { logs.push(t); if (cfg.verbose) post('log', { text: t }); },
    printErr: (t) => { logs.push(t); if (cfg.verbose) post('log', { text: t }); },
    onCoreLog: (level, t) => { logs.push(t); if (cfg.verbose || level >= 3) post('log', { text: t }); },
    onRetroFrame: (valid) => { if (valid) rendered = true; },
  });
  Module.specialHTMLTargets['#screen'] = canvas;
  // No AudioContext in a worker: the core's worklet glue (audiostream.cpp
  // fly_worklet_push) then falls back to the libretro audio callback.
  // Its samples are dropped except on the player's seat (msg.audio, below).
  // Audio never feeds guest state.
  Module._flyAud = { failed: true };
  // The player's seat (msg.audio): the libretro audio callback pushes into a
  // shared ring that the page's AudioWorklet plays. Other seats are silent.
  if (msg.audio && msg.audio.buffer) {
    const ring = new AudioRing(msg.audio.buffer, msg.audio.capacityFrames);
    audioRing = ring;
    Module.onAudioBatch = (ptr, frames) => { audioBatches++; ring.push(Module.HEAP16.subarray(ptr >> 1, (ptr >> 1) + frames * 2), frames); };
  }
  Module.linkbus = {
    mailbox: msg.mailbox || undefined,
    cabinet: msg.cabinet || undefined,
    // The core posts linkbus-tx after every slot frame; only the partner
    // start request matters to the page.
    post: (m) => { if (m && m.type === 'linkbus-start-partners') post('start-partners', { slaves: m.slaves }); },
  };
  for (const [name, bytes] of msg.files) {
    const u8 = new Uint8Array(bytes);
    if (BIOS.has(name.toLowerCase())) {
      const dir = `${FS_PATHS.system}/dc`;
      mkdirp(Module.FS, dir);
      Module.FS.writeFile(`${dir}/${name}`, u8);
    } else {
      mountRom(Module.FS, name, u8);
    }
  }
  const call = (name, ret, types, args) => Module.ccall(name, ret, types, args);
  for (const [k, v] of Object.entries(DEFAULT_CORE_OPTIONS)) call('shim_set_option', 'number', ['string', 'string'], [k, v]);
  for (const [k, v] of Object.entries(msg.options || {})) call('shim_set_option', 'number', ['string', 'string'], [k, v]);
  call('shim_set_dirs', null, ['string', 'string'], [FS_PATHS.system, FS_PATHS.save]);
  call('shim_set_gl_preserve', null, ['number'], [msg.preserve ? 1 : 0]);
  call('shim_init', 'number', [], []);
  Module._shim_set_lockstep(1);
  // dynarec 0: interpreter (no JIT modules; for browsers that cannot hold
  // six JIT cores, see tools/linked-run.mjs --dynarec).
  if (msg.dynarec === 0) Module._shim_set_dynarec(0);
  if (msg.pinTime !== undefined) Module._shim_dbg_pin_time(1, msg.pinTime);
  Module._shim_dbg_set_jit_det(msg.jitDet === undefined ? 1 : msg.jitDet);
  buf = Module._malloc(4096);
  if (msg.card) {
    const bytes = new Uint8Array(msg.card);
    const p = mountCard(Module.FS, FS_PATHS.save, msg.game, bytes);
    post('log', { text: `[board] card mounted at ${p}` });
    // watchCard: every change of the core's card file (a CARD_WRITE by the
    // game) goes to the page in game order, as a copy in memory. The page
    // hands it to the CardSource; nothing here stores it.
    if (msg.watchCard) {
      cardWatch = createCardWatcher(Module.FS, p, bytes, (b) => {
        const copy = new Uint8Array(b);
        self.postMessage({ type: 'card-write', board: cfg.label, bytes: copy.buffer }, [copy.buffer]);
      });
    }
  }
  Module._shim_lb_configure(msg.boardId, 1, msg.actAsServer ? 1 : 0, msg.multiboardSlaves);
  if (msg.seat >= 0) {
    // Vblank sync: plain mailbox (take() never waits) plus the core's vblank
    // barrier, so every seat advances one guest vblank per hub round
    // (lb-hub-worker.js). Installed before the game loads, so it runs before
    // the comm board's own vblank listener.
    let rc = Module._linkbus_install_mailbox(msg.seat, msg.n, msg.edition, msg.sessionTag >>> 0, 0);
    if (rc !== 0) throw new Error(`linkbus_install_mailbox returned ${rc}`);
    rc = Module._linkbus_install_vblank_barrier(msg.barrierTimeoutMs || 10000);
    if (rc !== 0) throw new Error(`linkbus_install_vblank_barrier returned ${rc}`);
  }
  // Master pair: snapshot bank by default (deterministic; writes cross at
  // the sync points), or the live shared bank (bank=live, native timing).
  if (msg.cabinet && msg.bank === 'live') Module._linkbus_install_sab_multiboard();
  else if (msg.cabinet) Module._linkbus_install_sab_multiboard_snapshot();
  post('ready', { status: linkStatus() });
}

async function runBoard() {
  const msg = cfg;
  const loaded = Module.ccall('shim_load_game', 'number', ['string', 'string'], [`${FS_PATHS.roms}/${msg.game}`, '#screen']);
  if (loaded !== 1) { post('error', { message: `shim_load_game returned ${loaded}`, logs: logs.slice(-40) }); return; }
  post('loaded', { status: linkStatus() });
  const ctl = new Int32Array(msg.ctl);
  const frameCounts = new Int32Array(msg.frameCounts);
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const presses = msg.presses || [];
  // Live input (the player's seat): Int32 joypad masks for ports 0..3, written by the page.
  const live = msg.input ? new Int32Array(msg.input) : null;
  const yieldEvery = Math.max(1, msg.yieldEvery || 1);
  let runMs = 0;
  const tStart = performance.now();
  let nextDue = 0;
  const prev = WATCH.map(() => null);
  let changes = [];
  // Seats: guest vblank count (vblank barrier), recorded with each watched change.
  const vbI32 = msg.mailbox ? new Int32Array(msg.mailbox, 0, 16) : null;
  for (let f = 0; ; f++) {
    if (Atomics.load(ctl, 0)) break;
    let mask = 0;
    for (const [from, to, m] of presses) if (f >= from && f < to) mask |= m;
    if (live) mask |= Atomics.load(live, 0);
    Module._shim_set_input(0, mask);
    for (let p = 1; p < 4; p++) Module._shim_set_input(p, live ? Atomics.load(live, p) : 0);
    const t0 = performance.now();
    try {
      Module._shim_run_frame();
    } catch (err) {
      // On stop the page releases the barriers and asks the partner to
      // exit (multiboard "Slave exit"): not an error.
      if (Atomics.load(ctl, 0)) break;
      post('error', { message: `retro_run threw at frame ${f}: ${err && err.stack ? err.stack : err}`, logs: logs.slice(-40) });
      return;
    }
    runMs += performance.now() - t0;
    if (present) postFrame(f + 1);
    if (cardWatch && (f + 1) % 30 === 0) cardWatch.poll();
    Atomics.store(frameCounts, msg.index, f + 1);
    Atomics.notify(frameCounts, msg.index);
    const n = f + 1;
    for (let k = 0; k < WATCH.length; k++) {
      const v = Module._shim_dbg_ram_word(WATCH[k][1] & 0x1ffffff) >>> 0;
      if (v !== prev[k]) { prev[k] = v; changes.push([n, WATCH[k][0], v, vbI32 ? Atomics.load(vbI32, 8) : null]); }
    }
    if (changes.length && (n % 60 === 0 || changes.length > 200)) { post('watch', { changes }); changes = []; }
    if (n <= msg.frames && (n % msg.hashEvery === 0 || n === msg.frames)) {
      post('sample', { f: n, hash: stateHash(), status: linkStatus(), runMs, wallMs: performance.now() - tStart });
    }
    if (n === msg.frames) post('done', { f: n, hash: stateHash(), status: linkStatus(), runMs, wallMs: performance.now() - tStart });
    if (msg.realtimeHz > 0) {
      // Unlinked boards pace themselves; linked boards are paced by the hub.
      const period = 1000 / msg.realtimeHz;
      if (nextDue === 0) nextDue = performance.now();
      nextDue += period;
      const left = nextDue - performance.now();
      if (left > 0.05) Atomics.wait(sleeper, 0, 0, left);
      else if (left < -100) nextDue = performance.now();
    }
    if (n % yieldEvery === 0) await yieldTask(); // lets the OffscreenCanvas commit
  }
  post('stopped', { status: linkStatus() });
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      initDone = init(m);
      await initDone;
      if (m.autoStart) await runBoard();
    } else if (m.type === 'go') {
      // The partner's go can arrive while its init is still awaiting the core.
      if (!initDone) throw new Error('go before init');
      await initDone;
      await runBoard();
    } else if (m.type === 'card-final') {
      // Before the page ejects: one last look at the card file, then a reply
      // (after any card-write it caused, so the page sees them in order).
      const changed = cardWatch ? cardWatch.poll() : false;
      post('card-final', { changed, writes: cardWatch ? cardWatch.changes() : 0 });
    } else if (m.type === 'shot') {
      post('shot', { status: linkStatus() });
    }
  } catch (err) {
    post('error', { message: String(err && err.stack ? err.stack : err), logs: logs.slice(-40) });
  }
};
