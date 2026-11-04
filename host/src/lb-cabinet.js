// lb-cabinet.js: the single-page linked DOC cabinet (doc-wasm/linkbus2),
// four seats (five boards plus the graphics partner, the default) or eight
// seats (nine plus the partner, linkbus/EIGHT_SEATS.md). Creates the shared
// buffers, the hub worker, one board worker per ring node (master plus the
// satellites) and the master's graphics partner worker, and exposes the run
// state as window.cabinet for tools/linked-run.mjs.
// No network code: the player's own files come from the file picker.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later

import { MB, MB_TOTAL_BYTES, CABINET_TOTAL_BYTES, CABINET_SNAPSHOT_BYTES, EDITION_A, HUB_STATUS } from './lb-lockstep.js';
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

export const SESSION_TAG = 0x4c425332; // "LBS2"

// Satellite counts the cabinet supports. The ring is the master plus the
// satellites (n = seats + 1); the core sets the game's EEPROM link bytes
// from n (naomi_network.cpp SetNaomiNetworkConfig: byte 0x4e low bits
// n - 2, so 3 for four seats and 7 for eight), as the native master does
// from the satellites that joined. Native eight-seat cabinets use the same
// per-board settings as four-seat ones (master ActAsServer, MultiboardSlaves
// 2; satellites MultiboardSlaves 1); only the number of satellites differs.
export const SEAT_COUNTS = Object.freeze([4, 8]);

// Board table for a cabinet with `seats` satellites: index, label, boardId,
// ring seat, ActAsServer, MultiboardSlaves. board0 is the master (ring seat
// 0), board1..board<seats> the satellites (ring seats 1..seats), and the
// partner (the master's graphics board, BoardId 1, no ring seat) is last,
// at index seats + 1.
export function cabinetBoards(seats = 4) {
  if (!SEAT_COUNTS.includes(seats)) throw new Error(`seats must be one of ${SEAT_COUNTS.join(', ')}`);
  const out = [{ index: 0, label: 'board0', boardId: 0, seat: 0, actAsServer: true, multiboardSlaves: 2, cabinet: true }];
  for (let i = 1; i <= seats; i++) out.push({ index: i, label: `board${i}`, boardId: 0, seat: i, actAsServer: false, multiboardSlaves: 1, cabinet: false });
  out.push({ index: seats + 1, label: 'partner', boardId: 1, seat: -1, actAsServer: true, multiboardSlaves: 2, cabinet: true });
  return Object.freeze(out.map((b) => Object.freeze(b)));
}

// The four-seat table (the pilot's cabinet).
export const BOARDS = cabinetBoards(4);

// comm_status2 of a linked board is (satellites << 8) | node id
// (naomi_m3comm.cpp connectedState); the board worker reports it as hex.
export const isLinkedStatus = (comm2, seats = 4) => typeof comm2 === 'string' && comm2 !== '' && parseInt(comm2, 16) >> 8 === seats;

// seats: 4 (default) or 8. canvases: one per board in cabinetBoards(seats)
// order; a seat whose canvas is missing (null) draws into a worker canvas
// that is never shown (a server running empty seats, say).
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
//   edition, sessionTag: the link's edition tag (1 = A, 2 = B) and session tag;
//                every board and the hub get the same pair (edition-b.js linkTags)
// Pacing: paceHz paces the hub (every seat one vblank per round, so 60 is
// 60 guest vblanks a second per board); the boards themselves never sleep.
export function startCabinet({ files, game, canvases, seats = 4, frames = 3000, hashEvery = 60, pinTime = 1767225600,
  jitDet = 1, preserve = false, paceHz = 0, catchUpMs = 250, presses = {}, cards = {}, bank = 'snapshot', dynarec = 1, barrierTimeoutMs = 10000, yieldEvery = 1, verbose = false, log = () => {},
  input = null, inputBoard = 'board1', audio = null, audioBoard = 'board1', audioBoards = null, watchCards = [], onCardWrite = () => {}, onEvent = () => {}, watchCap = 0,
  presentRace = true, onRacePair = null, edition = EDITION_A, sessionTag = SESSION_TAG }) {
  const boards = cabinetBoards(seats);
  const n = seats + 1; // ring nodes: the master and the satellites
  const partnerIndex = boards.length - 1;
  // Audio rings by board label: audioBoards ({ label: { buffer, capacityFrames } },
  // e.g. the seat and the race board), or the single audio/audioBoard pair.
  const rings = { ...(audio ? { [audioBoard]: audio } : {}), ...(audioBoards || {}) };
  // Race screen (race-pair.js): board0 and its partner post their frames and
  // the page shows both halves together. presentRace false: each draws into
  // its own page canvas as before.
  const raceSide = (label) => (label === 'board0' ? MASTER : label === 'partner' ? PARTNER : -1);
  const race = presentRace ? createRacePresenter(canvases[0], canvases[partnerIndex], onRacePair) : null;
  const mailboxes = Array.from({ length: n }, () => new SharedArrayBuffer(MB_TOTAL_BYTES));
  const cabinet = new SharedArrayBuffer(bank === 'live' ? CABINET_TOTAL_BYTES : CABINET_SNAPSHOT_BYTES);
  const ctl = new SharedArrayBuffer(16);
  const hubStatus = new SharedArrayBuffer(HUB_STATUS.words * 4);
  const frameCounts = new SharedArrayBuffer(4 * boards.length);
  const state = {
    started: performance.now(),
    seats,
    boards: boards.map((b) => ({ label: b.label, ready: false, loaded: false, done: null, samples: [], errors: [], logs: [], startedAt: 0, watch: [] })),
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
  hub.postMessage({ type: 'init', n, mailboxes, sessionTag, edition, status: hubStatus, ctl, frameCounts });

  const workers = boards.map((b) => {
    const w = new Worker(new URL('./lb-board-worker.js', import.meta.url), { type: 'module' });
    const side = race ? raceSide(b.label) : -1;
    const pageCanvas = canvases[b.index] || null;
    const off = side < 0 && pageCanvas ? pageCanvas.transferControlToOffscreen() : null;
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
          workers[partnerIndex].postMessage({ type: 'go' });
          break;
        default: break;
      }
      try { onEvent(b.label, m); } catch { /* UI only */ }
    };
    w.onerror = (e) => { st.errors.push(`worker error: ${e.message}`); log(`[${b.label}] worker error ${e.message}`); };
    const fileCopies = files.map(([name, bytes]) => [name, bytes.slice(0)]);
    w.postMessage({
      type: 'init', label: b.label, index: b.index, boardId: b.boardId, seat: b.seat, n,
      actAsServer: b.actAsServer, multiboardSlaves: b.multiboardSlaves, edition, sessionTag,
      mailbox: b.seat >= 0 ? mailboxes[b.seat] : null, cabinet: b.cabinet ? cabinet : null,
      canvas: off, files: fileCopies, game, frames, hashEvery, pinTime, jitDet, preserve, bank, dynarec, barrierTimeoutMs,
      ctl, frameCounts, hubStatus, autoStart: b.boardId === 0, realtimeHz: 0, presses: presses[b.label] || [], yieldEvery, verbose,
      card: cards[b.label] ? cards[b.label].slice(0) : null, watchCard: watchCards.includes(b.label),
      input: input && b.label === inputBoard ? input : null,
      audio: rings[b.label] || null,
      present: side >= 0 ? { width: pageCanvas ? pageCanvas.width : 640, height: pageCanvas ? pageCanvas.height : 480 } : null,
      // Not a race screen board and no page canvas: the worker draws into a
      // canvas of its own that is never shown.
      hidden: side < 0 && !pageCanvas,
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
      const H = HUB_STATUS;
      return { round: g(H.round), waitingSeat: g(H.waitingSeat), running: g(H.running), emptyRounds: g(H.emptyRounds), overruns: g(H.overruns),
        busyMs: g(H.busyMs), lateResets: g(H.lateResets), lateMs: g(H.lateMs),
        txSeq: per(H.txSeq), refused: per(H.refused), sizeMismatch: per(H.sizeMismatch), unsized: per(H.unsized) };
    },
    frameCounts: () => Array.from(counts),
    // Guest vblanks each seat has reached (its vblank barrier count).
    vblankCounts: () => mailboxes.map((mb) => Atomics.load(new Int32Array(mb, 0, MB.headerBytes >> 2), MB.vblankCount >> 2)),
    // Asks a watched card board for one last look at its card file. Resolves
    // with { changed, writes } after any card-write that look produced, or
    // null after timeoutMs (default: the barrier timeout plus 2 s, so a
    // board held at a stalled barrier still answers).
    finalCard(label, timeoutMs = barrierTimeoutMs + 2000) {
      const w = workers[boards.findIndex((x) => x.label === label)];
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
    seats,
    boards,
  };
}
