// lb-cabinet.js: the single-page five-board DOC cabinet (doc-wasm/linkbus2).
// Creates the shared buffers, the hub worker, five board workers (master
// plus four satellites) and the master's graphics partner worker, and
// exposes the run state as window.cabinet for tools/linked-run.mjs.
// No network code: the player's own files come from the file picker.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later

import { MB, MB_TOTAL_BYTES, CABINET_TOTAL_BYTES, CABINET_SNAPSHOT_BYTES, EDITION_A } from './lb-lockstep.js';
import { MASTER, PARTNER, vblankNumber, createFramePairer } from './race-pair.js';

// The race screen's two page canvases (board0 left, partner right) show the
// frames the two boards post, a matched pair per animation frame
// (race-pair.js). onPair(info), when given, sees every shown pair:
// { t, paired, a: { f, s, key, t, aw, ab }, b: likewise } (f: the board's
// own frame count, s: its sync count, key: the guest vblank number, t: when
// the frame reached the page, aw: its audio ring's write index after the
// frame's audio, or -1, ab: audio batches since its last frame; a side is
// null when it was shown alone).
function createRacePresenter(left, right, onPair) {
  const ctx = [left.getContext('bitmaprenderer'), right.getContext('bitmaprenderer')];
  const canv = [left, right];
  const pairer = createFramePairer({ onDrop: (fr) => { try { fr.bmp.close(); } catch { /* gone */ } } });
  let on = true;
  const show = (side, fr) => {
    const c = canv[side];
    if (c.width !== fr.bmp.width || c.height !== fr.bmp.height) { c.width = fr.bmp.width; c.height = fr.bmp.height; }
    ctx[side].transferFromImageBitmap(fr.bmp);
  };
  const info = (fr) => (fr ? { f: fr.f, s: fr.s, key: fr.key, t: fr.t, aw: fr.aw, ab: fr.ab } : null);
  let showErrors = 0;
  const closeQuietly = (fr) => { try { if (fr && fr.bmp) fr.bmp.close(); } catch { /* gone */ } };
  const tick = (now) => {
    if (!on) return;
    // Next frame first: a throw below (a lost context, a closed bitmap) costs
    // one update, never the display loop.
    requestAnimationFrame(tick);
    let p = null;
    try {
      p = pairer.take(now);
      if (p && p.a) show(MASTER, p.a);
      if (p && p.b) show(PARTNER, p.b);
    } catch {
      showErrors++;
      if (p) { closeQuietly(p.a); closeQuietly(p.b); }
      return;
    }
    if (p && onPair) { try { onPair({ t: now, paired: p.paired, a: info(p.a), b: info(p.b) }); } catch { /* diagnostics only */ } }
  };
  requestAnimationFrame(tick);
  return {
    push(side, m) {
      if (!on) { closeQuietly(m); return; }
      try {
        pairer.push(side, { key: vblankNumber(side, m.s), t: performance.now(), f: m.f, s: m.s, aw: m.aw, ab: m.ab, bmp: m.bmp });
      } catch {
        showErrors++;
        closeQuietly(m);
      }
    },
    stats: () => ({ ...pairer.stats, pushed: [...pairer.stats.pushed], queued: pairer.queued(), showErrors }),
    stop() { on = false; pairer.clear(); },
  };
}

const HUB_WORDS = 64;
export const SESSION_TAG = 0x4c425332; // "LBS2"

// Board table: index, label, boardId, ring seat, ActAsServer, MultiboardSlaves.
export const BOARDS = Object.freeze([
  { index: 0, label: 'board0', boardId: 0, seat: 0, actAsServer: true, multiboardSlaves: 2, cabinet: true },
  { index: 1, label: 'board1', boardId: 0, seat: 1, actAsServer: false, multiboardSlaves: 1, cabinet: false },
  { index: 2, label: 'board2', boardId: 0, seat: 2, actAsServer: false, multiboardSlaves: 1, cabinet: false },
  { index: 3, label: 'board3', boardId: 0, seat: 3, actAsServer: false, multiboardSlaves: 1, cabinet: false },
  { index: 4, label: 'board4', boardId: 0, seat: 4, actAsServer: false, multiboardSlaves: 1, cabinet: false },
  { index: 5, label: 'partner', boardId: 1, seat: -1, actAsServer: true, multiboardSlaves: 2, cabinet: true },
]);

// Player seat options (the stable game, cabinet-game.js):
//   input:       SharedArrayBuffer (Int32 x 4, joypad masks of ports 0..3)
//   inputBoard:  the board label that reads it (default board1)
//   audio:       { buffer, capacityFrames } AudioRing for audioBoard (default board1)
//   audioBoards: { label: { buffer, capacityFrames } }, an AudioRing for each
//                board that is heard (the seat and the race screen boards)
//   watchCards:  board labels whose card file is watched; each change calls
//                onCardWrite(label, Uint8Array) in game order
//   onEvent:     (label, message) for every worker message (status UI),
//                except the race frames
//   presentRace: board0 and the partner hand their frames to the page, which
//                shows the two halves together (race-pair.js); default on
//   onRacePair:  diagnostics, every race pair shown (createRacePresenter)
// Pacing: paceHz paces the hub (every seat one vblank per round, so 60 is
// 60 guest vblanks a second per board); the boards themselves never sleep.
export function startCabinet({ files, game, canvases, frames = 3000, hashEvery = 60, pinTime = 1767225600,
  jitDet = 1, preserve = false, paceHz = 0, catchUpMs = 250, presses = {}, cards = {}, bank = 'snapshot', dynarec = 1, barrierTimeoutMs = 10000, yieldEvery = 1, verbose = false, log = () => {},
  input = null, inputBoard = 'board1', audio = null, audioBoard = 'board1', audioBoards = null, watchCards = [], onCardWrite = () => {}, onEvent = () => {}, watchCap = 0,
  presentRace = true, onRacePair = null }) {
  const n = 5;
  // Audio rings by board label: audioBoards ({ label: { buffer, capacityFrames } },
  // e.g. the seat and the race board), or the single audio/audioBoard pair.
  const rings = { ...(audio ? { [audioBoard]: audio } : {}), ...(audioBoards || {}) };
  // Race screen (race-pair.js): board0 and its partner post their frames and
  // the page shows both halves together. presentRace false: each draws into
  // its own page canvas as before.
  const raceSide = (label) => (label === 'board0' ? MASTER : label === 'partner' ? PARTNER : -1);
  const race = presentRace ? createRacePresenter(canvases[0], canvases[5], onRacePair) : null;
  const mailboxes = Array.from({ length: n }, () => new SharedArrayBuffer(MB_TOTAL_BYTES));
  const cabinet = new SharedArrayBuffer(bank === 'live' ? CABINET_TOTAL_BYTES : CABINET_SNAPSHOT_BYTES);
  const ctl = new SharedArrayBuffer(16);
  const hubStatus = new SharedArrayBuffer(HUB_WORDS * 4);
  const frameCounts = new SharedArrayBuffer(4 * BOARDS.length);
  const state = {
    started: performance.now(),
    boards: BOARDS.map((b) => ({ label: b.label, ready: false, loaded: false, done: null, samples: [], errors: [], logs: [], startedAt: 0, watch: [] })),
    hub: { stopped: false, error: null },
    partnerStartAt: null,
  };
  new Int32Array(ctl)[1] = paceHz > 0 ? Math.round(1e6 / paceHz) : 0;
  new Int32Array(ctl)[2] = catchUpMs;
  const finalWaits = new Map();

  const hub = new Worker(new URL('./lb-hub-worker.js', import.meta.url), { type: 'module' });
  hub.onmessage = (e) => {
    if (e.data.type === 'hub-error') { state.hub.error = e.data.message; log(`[hub] ${e.data.message}`); }
    if (e.data.type === 'hub-stopped') state.hub.stopped = true;
  };
  hub.postMessage({ type: 'init', n, mailboxes, sessionTag: SESSION_TAG, edition: EDITION_A, status: hubStatus, ctl, frameCounts });

  const workers = BOARDS.map((b) => {
    const w = new Worker(new URL('./lb-board-worker.js', import.meta.url), { type: 'module' });
    const side = race ? raceSide(b.label) : -1;
    const off = side < 0 ? canvases[b.index].transferControlToOffscreen() : null;
    const st = state.boards[b.index];
    w.onmessage = (e) => {
      const m = e.data;
      // Race frames go to the presenter only (never kept in state or passed on).
      if (m.type === 'frame') { if (race) race.push(side, m); else if (m.bmp) m.bmp.close(); return; }
      switch (m.type) {
        case 'ready': st.ready = true; st.readyStatus = m.status; break;
        case 'loaded': st.loaded = true; st.loadedAt = performance.now() - state.started; st.loadStatus = m.status; break;
        case 'sample': st.samples.push({ f: m.f, hash: m.hash, status: m.status, runMs: m.runMs, wallMs: m.wallMs }); break;
        case 'done': st.done = { f: m.f, hash: m.hash, status: m.status, runMs: m.runMs, wallMs: m.wallMs }; break;
        case 'stopped': st.stopped = m.status; break;
        case 'watch': st.watch.push(...m.changes); if (watchCap > 0 && st.watch.length > watchCap) st.watch.splice(0, st.watch.length - watchCap); break;
        case 'card-write': onCardWrite(b.label, new Uint8Array(m.bytes)); break;
        case 'card-final': { const r = finalWaits.get(b.label); if (r) { finalWaits.delete(b.label); r(m); } break; }
        case 'error': st.errors.push(m.message); st.logs.push(...(m.logs || [])); log(`[${b.label}] ERROR ${m.message}`); break;
        case 'log': st.logs.push(m.text); if (st.logs.length > 400) st.logs.shift(); break;
        case 'start-partners':
          // Native: the master's first multiboard sync spawns the partner.
          state.partnerStartAt = performance.now() - state.started;
          log(`[cabinet] board0 asks for ${m.slaves} partner(s)`);
          workers[5].postMessage({ type: 'go' });
          break;
        default: break;
      }
      try { onEvent(b.label, m); } catch { /* UI only */ }
    };
    w.onerror = (e) => { st.errors.push(`worker error: ${e.message}`); log(`[${b.label}] worker error ${e.message}`); };
    const fileCopies = files.map(([name, bytes]) => [name, bytes.slice(0)]);
    w.postMessage({
      type: 'init', label: b.label, index: b.index, boardId: b.boardId, seat: b.seat, n,
      actAsServer: b.actAsServer, multiboardSlaves: b.multiboardSlaves, edition: EDITION_A, sessionTag: SESSION_TAG,
      mailbox: b.seat >= 0 ? mailboxes[b.seat] : null, cabinet: b.cabinet ? cabinet : null,
      canvas: off, files: fileCopies, game, frames, hashEvery, pinTime, jitDet, preserve, bank, dynarec, barrierTimeoutMs,
      ctl, frameCounts, hubStatus, autoStart: b.boardId === 0, realtimeHz: 0, presses: presses[b.label] || [], yieldEvery, verbose,
      card: cards[b.label] ? cards[b.label].slice(0) : null, watchCard: watchCards.includes(b.label),
      input: input && b.label === inputBoard ? input : null,
      audio: rings[b.label] || null,
      present: side >= 0 ? { width: canvases[b.index].width, height: canvases[b.index].height } : null,
    }, [...(off ? [off] : []), ...fileCopies.map(([, a]) => a)]);
    return w;
  });

  const hubI32 = new Int32Array(hubStatus);
  const counts = new Int32Array(frameCounts);
  return {
    state,
    hubStatus() {
      const g = (i) => Atomics.load(hubI32, i);
      const per = (base) => Array.from({ length: n }, (_, i) => g(base + i));
      return { round: g(0), waitingSeat: g(1), running: g(2), emptyRounds: g(3), overruns: g(4), busyMs: g(5), lateResets: g(6), lateMs: g(7),
        txSeq: per(8), refused: per(16), sizeMismatch: per(24), unsized: per(32) };
    },
    frameCounts: () => Array.from(counts),
    // Guest vblanks each seat has reached (its vblank barrier count).
    vblankCounts: () => mailboxes.map((mb) => Atomics.load(new Int32Array(mb, 0, MB.headerBytes >> 2), MB.vblankCount >> 2)),
    // Asks a watched card board for one last look at its card file. Resolves
    // with { changed, writes } after any card-write that look produced, or
    // null after timeoutMs (default: the barrier timeout plus 2 s, so a
    // board held at a stalled barrier still answers).
    finalCard(label, timeoutMs = barrierTimeoutMs + 2000) {
      const w = workers[BOARDS.findIndex((x) => x.label === label)];
      if (!w) return Promise.resolve(null);
      return new Promise((resolve) => {
        const t = setTimeout(() => { finalWaits.delete(label); resolve(null); }, timeoutMs);
        finalWaits.set(label, (m) => { clearTimeout(t); resolve(m); });
        w.postMessage({ type: 'card-final' });
      });
    },
    // stop() and then end every worker (frees each core and its memory FS,
    // the card copy included).
    terminate() {
      this.stop();
      for (const w of workers) w.terminate();
      hub.terminate();
      if (race) race.stop();
    },
    // Race screen presentation counts (race-pair.js), or null.
    raceStats: () => (race ? race.stats() : null),
    setPace(hz) { Atomics.store(new Int32Array(ctl), 1, hz > 0 ? Math.round(1e6 / hz) : 0); },
    // Stop: the board loops end, the vblank barriers are released, and the
    // partner is asked to exit at its next multiboard barrier.
    stop() {
      Atomics.store(new Int32Array(ctl), 0, 1);
      for (const mb of mailboxes) {
        const i32 = new Int32Array(mb, 0, MB.headerBytes >> 2);
        Atomics.store(i32, MB.barrierStop >> 2, 1);
        Atomics.notify(i32, MB.hubRound >> 2);
      }
      const cab = new Int32Array(cabinet, 0, 16);
      Atomics.store(cab, 1, 1); // MultiboardSabLayout::exit
      Atomics.notify(cab, 2); // generation
    },
    workers,
  };
}
