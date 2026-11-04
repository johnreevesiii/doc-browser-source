// libretro-host.js: drives the C shim (shim/libretro_shim.c) from the page.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// The core module comes from loadCoreFactory (core-bridge.js). This file
// only calls exported shim_* functions; it has no network code.

import { FS_PATHS, mountRom } from './core-bridge.js';
import { mountCard, createCardWatcher } from './card-store.js';

// NAOMI and Atomiswave BIOS archives go in <system>/dc/, where Flycast's
// libretro build looks for them. Everything else is content.
export const BIOS_NAMES = Object.freeze(['naomi.zip', 'naomi2.zip', 'awbios.zip', 'dc_boot.bin', 'dc_flash.bin']);

export function isBiosName(name) {
  return BIOS_NAMES.includes(String(name).toLowerCase());
}

function mkdirp(FS, path) {
  let cur = '';
  for (const part of path.split('/').filter(Boolean)) {
    cur += `/${part}`;
    try { FS.mkdir(cur); } catch { /* exists */ }
  }
}

// Writes the BIOS into <system>/dc/ and returns its path.
export function mountBios(FS, name, bytes) {
  if (!isBiosName(name)) throw new Error(`not a BIOS file: ${name}`);
  const dir = `${FS_PATHS.system}/dc`;
  mkdirp(FS, dir);
  const path = `${dir}/${name}`;
  FS.writeFile(path, bytes);
  return path;
}

// Frame statistics from the core's video callback.
export function createFrameStats(now = () => performance.now()) {
  const s = { total: 0, valid: 0, dupe: 0, width: 0, height: 0, windowStart: now(), windowValid: 0, fps: 0 };
  return {
    onFrame(valid, w, h) {
      s.total++;
      if (valid) { s.valid++; s.windowValid++; } else s.dupe++;
      if (w && h) { s.width = w; s.height = h; }
      const t = now();
      if (t - s.windowStart >= 1000) {
        s.fps = (s.windowValid * 1000) / (t - s.windowStart);
        s.windowValid = 0;
        s.windowStart = t;
      }
    },
    snapshot: () => ({ ...s }),
  };
}

// Starts the core: options, directories, files, load, then a frame loop on
// requestAnimationFrame. Returns a handle with stats and stop().
//
// probe (determinism runs, PLAN_V2 2.5): { pinTime } pins the core's time()
// to that Unix time before load, turns on lockstep (one emu.render() per
// frame, no wall-clock pacing) and skips the rAF loop. The caller then
// drives frames with handle.step() and reads hashes with handle.stateHash().
//
// jitDet (default 1): rec-wasm deterministic mode, required for linked play
// (DECISIONS.md D-062 item 6); see jitDetMode in core-bridge.js for the
// values. The page turns it off only with ?jitdet=0, for diagnostics. In
// probe mode the probe's own jitDet setting is used instead.
//
// perf (default false): records per-tick wall-clock timings (rAF time, time
// spent in retro_run, JIT compile ms and compiled block count) for
// tools/perf-run.mjs. Read them with handle.perf(from).
//
// cardSource (optional): a CardSource (card-store.js: insert, write,
// eject). Its insert() card is put where the core's card reader looks for
// it before the game loads; the insert button (joypad L, NAOMI Button 6 in
// the libretro build when a card reader is present) loads it into the
// reader. Every card write by the game goes to cardSource.write(bytes).
// handle.card() returns the current bytes, handle.cardWrites() the change
// count, handle.ejectCard() calls cardSource.eject().
export async function startCore({ factory, canvas, files, game, options, input, log, preserve = false, dynarec, probe, jitDet = 1, perf = false, cardSource }) {
  const say = log || (() => {});
  const stats = createFrameStats();
  const logs = [];
  const Module = await factory({
    canvas,
    print: (t) => { logs.push(t); say(t); },
    printErr: (t) => { logs.push(t); say(t); },
    onCoreLog: (level, t) => { logs.push(t); say(t); },
    onRetroFrame: (valid, w, h) => stats.onFrame(valid, w, h),
  });
  for (const [name, bytes] of files) {
    if (isBiosName(name)) mountBios(Module.FS, name, bytes);
    else mountRom(Module.FS, name, bytes);
  }
  const call = (name, ret, types, args) => Module.ccall(name, ret, types, args);
  for (const [k, v] of options.entries()) call('shim_set_option', 'number', ['string', 'string'], [k, v]);
  call('shim_set_dirs', null, ['string', 'string'], [FS_PATHS.system, FS_PATHS.save]);
  call('shim_set_gl_preserve', null, ['number'], [preserve ? 1 : 0]);
  call('shim_init', 'number', [], []);
  if (probe) {
    call('shim_set_lockstep', null, ['number'], [1]);
    if (probe.pinTime !== undefined) call('shim_dbg_pin_time', null, ['number', 'number'], [1, probe.pinTime]);
    if (probe.jitDet) call('shim_dbg_set_jit_det', null, ['number'], [Number(probe.jitDet)]);
    say(`[host] probe mode: lockstep on, jit det ${probe.jitDet ? `mode ${Number(probe.jitDet)}` : 'off'}, time ${probe.pinTime === undefined ? 'unpinned' : `pinned to ${probe.pinTime}`}`);
  } else {
    call('shim_dbg_set_jit_det', null, ['number'], [Number(jitDet)]);
    say(`[host] jit det mode ${Number(jitDet)}`);
  }
  // undefined keeps the core default (JIT on); false picks the interpreter.
  if (dynarec !== undefined) call('shim_set_dynarec', null, ['number'], [dynarec ? 1 : 0]);
  say(`[host] dynarec ${call('shim_get_dynarec', 'number', [], [])}`);
  let cardWatch = null;
  if (cardSource) {
    const bytes = await cardSource.insert();
    const cardPath = mountCard(Module.FS, FS_PATHS.save, game, bytes);
    cardWatch = createCardWatcher(Module.FS, cardPath, bytes, (b) => {
      Promise.resolve(cardSource.write(b)).catch((err) => say(`[host] card write failed: ${err && err.message ? err.message : err}`));
    });
    say(`[host] card from ${cardSource.kind || 'source'} mounted at ${cardPath} (${bytes.length} bytes)`);
  }
  const cardApi = {
    card: () => (cardWatch ? cardWatch.current() : null),
    cardWrites: () => (cardWatch ? cardWatch.changes() : 0),
    pollCard: () => (cardWatch ? cardWatch.poll() : false),
    ejectCard: () => (cardSource ? cardSource.eject() : Promise.resolve()),
  };
  const gamePath = `${FS_PATHS.roms}/${game}`;
  const loaded = call('shim_load_game', 'number', ['string', 'string'], [gamePath, `#${canvas.id}`]);
  if (loaded !== 1) {
    return { ok: false, loaded, logs, stats, Module, stop() {} };
  }
  let running = true;
  let ticks = 0;
  const run = Module._shim_run_frame;
  const setInput = Module._shim_set_input;
  if (probe) return { ok: true, loaded, logs, stats, Module, ...cardApi, ...probeApi(Module, () => ticks, (n) => { ticks += n; }, cardApi.pollCard) };
  const rec = perf ? createPerfRecorder(Module) : null;
  function tick(rafT) {
    if (!running) return;
    if (input) for (let p = 0; p < 4; p++) setInput(p, input.mask(p));
    try {
      if (rec) {
        const c0 = rec.compileMs();
        const t0 = performance.now();
        run();
        rec.push(rafT, performance.now() - t0, rec.compileMs() - c0);
      } else {
        run();
      }
    } catch (err) {
      running = false;
      logs.push(`retro_run threw: ${err && err.stack ? err.stack : err}`);
      say(`retro_run threw: ${err && err.message ? err.message : err}`);
      return;
    }
    ticks++;
    if (cardWatch && ticks % 30 === 0) cardWatch.poll();
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  return {
    ok: true,
    loaded,
    logs,
    stats,
    Module,
    ...cardApi,
    ticks: () => ticks,
    // Count of JIT-compiled wasm blocks (rec-wasm glue), 0 if the JIT is idle.
    jitBlocks: () => Module._jitNextIdx || 0,
    running: () => running,
    perf: (from = 0) => (rec ? rec.read(from) : null),
    stop() { running = false; },
  };
}

// Per-tick timing records for perf mode. Fixed capacity (about 16 minutes
// at 60 Hz); later ticks are dropped and counted.
export function createPerfRecorder(Module, capacity = 60000) {
  const raf = new Float64Array(capacity);
  const runMs = new Float32Array(capacity);
  const compMs = new Float32Array(capacity);
  const blocks = new Uint32Array(capacity);
  const frames = new Uint32Array(capacity);
  let n = 0;
  let dropped = 0;
  return {
    compileMs: () => (Module._prof && Module._prof.compileMs) || 0,
    push(rafT, ms, cms) {
      if (n >= capacity) { dropped++; return; }
      raf[n] = rafT;
      runMs[n] = ms;
      compMs[n] = cms;
      blocks[n] = Module._jitNextIdx || 0;
      frames[n] = Module._shim_frames_valid ? Module._shim_frames_valid() : 0;
      n++;
    },
    read(from = 0) {
      const a = Math.max(0, Math.min(from, n));
      return {
        from: a,
        count: n,
        dropped,
        raf: Array.from(raf.subarray(a, n)),
        runMs: Array.from(runMs.subarray(a, n)),
        compileMs: Array.from(compMs.subarray(a, n)),
        blocks: Array.from(blocks.subarray(a, n)),
        frames: Array.from(frames.subarray(a, n)),
      };
    },
  };
}

// Yields to the event loop without timer clamping, so async work the core
// queued (for example JIT module compiles) can settle between frames.
function yieldTask() {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });
}

const hex32 = (v) => (v >>> 0).toString(16).padStart(8, '0');

// Frame stepping and guest state hashes for probe mode. Hashes come from
// shim/debug_state_shim.cpp; RAM bytes never leave the core.
function probeApi(Module, getTicks, addTicks, pollCard = () => false) {
  const buf = Module._malloc(4096);
  const words = (n) => Array.from(Module.HEAPU32.subarray(buf >> 2, (buf >> 2) + n));
  const ramMask = 0x1ffffff;
  const hashNow = () => {
    if (!Module._shim_dbg_state_hash(buf)) return null;
    const w = words(8);
    return hex32(w[1]) + hex32(w[0]) + hex32(w[3]) + hex32(w[2]);
  };
  return {
    ticks: getTicks,
    running: () => true,
    stop() {},
    jitBlocks: () => Module._jitNextIdx || 0,
    // Runs n frames. masks(frame) returns the port 0 joypad mask for the
    // absolute frame number about to run. Yields after every frame.
    // opts.hash: also returns one ram+regs hash per frame (32 hex digits,
    // ram hash then register hash). opts.watch: guest addresses (u32) read
    // after every frame; only changes are returned, as [frame, index, value].
    async step(n, masks, opts) {
      const hashes = opts && opts.hash ? [] : null;
      const watch = opts && opts.watch ? opts.watch.map((a) => a & ramMask) : null;
      const prev = watch ? (opts.prev || watch.map(() => null)) : null;
      const changes = watch ? [] : null;
      const cardAt = [];
      for (let i = 0; i < n; i++) {
        const f = getTicks();
        Module._shim_set_input(0, masks ? masks(f) : 0);
        for (let p = 1; p < 4; p++) Module._shim_set_input(p, 0);
        Module._shim_run_frame();
        addTicks(1);
        if (pollCard()) cardAt.push(f);
        if (hashes) hashes.push(hashNow());
        if (watch) {
          for (let k = 0; k < watch.length; k++) {
            const v = Module._shim_dbg_ram_word(watch[k]) >>> 0;
            if (v !== prev[k]) { prev[k] = v; changes.push([f, k, v]); }
          }
        }
        await yieldTask();
      }
      if (!opts) return getTicks();
      return { f: getTicks(), hashes, changes, prev, cardAt };
    },
    stateHash() {
      if (!Module._shim_dbg_state_hash(buf)) return null;
      const w = words(8);
      return {
        ram: hex32(w[1]) + hex32(w[0]),
        regs: hex32(w[3]) + hex32(w[2]),
        pc: hex32(w[4]),
        ramSize: w[5],
        cycles: w[7] * 4294967296 + w[6],
      };
    },
    ramChunks(k) {
      const n = Module._shim_dbg_ram_chunks(buf, k);
      return words(n).map(hex32);
    },
    regs() {
      const n = Module._shim_dbg_regs(buf);
      return words(n).map(hex32);
    },
    ramWord: (off) => hex32(Module._shim_dbg_ram_word(off)),
    frames: () => ({ total: Module._shim_frames_total(), valid: Module._shim_frames_valid(), dupe: Module._shim_frames_dupe() }),
  };
}
