// cabinet-game.js: a stable game on the single-page five-board cabinet
// (doc-wasm/linkbus2). The player's horse races on satellite 1 (board1) of
// a linked cabinet: the master (board0) runs the race, board1 to board4 are
// the four seats, and the master's graphics partner runs beside it. One
// race needs the master, so a lone board would sit at NO LINK.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// - Card: only board1 gets a card, the one the CardSource inserted. Its
//   writes come back from the board worker in game order and go to
//   source.write; no other seat has a card or can write one.
// - Input: the player's keyboard and gamepad reach board1 only, through a
//   shared Int32 word per port. Seats 2 to 4 have no card and no input, as
//   in the lab's linked race; the master and partner have no input either.
// - Audio: the player's seat (seat sounds) and the race screen boards, board0
//   and its partner (race audio), each through a shared ring and an
//   AudioWorklet node, mixed in one AudioContext with a level per group
//   (AUDIO_SOURCES). Optional: without it the game runs silent.
// - Race screen: board0 and the partner hand their frames to the page,
//   which shows both halves of the same vblank together (race-pair.js).
// - Pacing: the hub releases one round per 1/60 s, so every board runs 60
//   guest vblanks a second (the vblank barrier, lb-hub-worker.js).
// - Time: every board's clock is pinned to the same second (the cabinet's
//   start), as in the lab's deterministic runs.
// - Race entry (doc-arcade D-068): when the player's seat enters a race,
//   source.raceEntered() tells the stable, so a game left mid-race is
//   recorded as no result. See raceEntrySignal.
// No network code: the game files come in as bytes the page already read.

import { startCabinet, BOARDS } from './lb-cabinet.js';
import { LeaseLostError } from './card-stable.js';
import { createAudioOutput } from './audio-output.js';

export const PLAYER_BOARD = 'board1';
export const CABINET_PACE_HZ = 60;
export const BOARD_LABELS = Object.freeze(BOARDS.map((b) => b.label));

// Race entry, from the watched words (lb-board-worker.js WATCH, Rev C).
// Source: doc-ops research/claude/a04-link-timing/boundary/CLAIM.md K1 (a
// static decode, not yet confirmed on a live run). A satellite seat's scene
// (table S): 3 attract, 13 entry check, 15 registered and waiting, 17 race
// view, 19 results wait, 21 payout, 23 post-race; even scenes last one
// frame. The master's phase: 1 lobby, 2 lobby end with entrants, 3 paddock,
// 4 paddock end, 5 intro, 6 race running, 7 goal, 8 results, 0 back to the
// lobby. In Rev C a registered seat goes to the race view when the lobby
// begins, before the master's race exists, and the card is written after
// the results (payout or post-race). So the horse counts as entered from
// the race view or the results wait, or from registered-and-waiting once
// the master has closed its lobby with entrants.
export const SEAT_SCENE = Object.freeze({ registered: 15, raceView: 17, resultsWait: 19 });
export const MASTER_PHASE = Object.freeze({ lobbyEnd: 2, goal: 7 });

export function raceEntrySignal(phase, scene) {
  if (scene === SEAT_SCENE.raceView || scene === SEAT_SCENE.resultsWait) return true;
  return scene === SEAT_SCENE.registered && Number.isInteger(phase)
    && phase >= MASTER_PHASE.lobbyEnd && phase <= MASTER_PHASE.goal;
}

// The cabinet's card write hand-off: only the player's seat, and only while
// the cabinet runs. A write a stopped cabinet's worker posts late (Restart
// cabinet, Finish) never reaches the stable.
export function cardWriteHandler({ isRunning, source, log = () => {} }) {
  return (label, bytes) => {
    if (!isRunning() || label !== PLAYER_BOARD) return false;
    Promise.resolve(source.write(bytes)).catch((err) => log(`[cabinet] card write failed: ${err && err.message ? err.message : err}`));
    return true;
  };
}

// One race check from the watched words: updates the tracker and reports an
// entry to the source when one is due. Returns whether the seat is in a race.
export function raceCheck({ tracker, phase, scene, source, log = () => {} }) {
  if (tracker.update(phase, scene) && source && typeof source.raceEntered === 'function') {
    log(`[cabinet] race entry (phase ${phase}, seat scene ${scene})`);
    Promise.resolve(source.raceEntered()).catch(() => {});
  }
  return tracker.inRace();
}

// One report per race: on the step into a race, never again until the seat
// has left the race scenes. tracker.update(phase, scene) returns true when
// a report is due.
export function createRaceTracker() {
  let inRace = false;
  return {
    update(phase, scene) {
      const now = raceEntrySignal(phase, scene);
      const due = now && !inRace;
      inRace = now;
      return due;
    },
    inRace: () => inRace,
  };
}

// Jitter buffer per source (audio-worklet.js). A race board hands over its
// audio in one batch per drawn frame, about 1470 frames every second vblank,
// so its buffer saws up and down by about 33 ms. The race sources run in
// set point mode: the worklet nudges the playback rate (at most one frame in
// 128, either way) so the buffer's low point stays near
// RACE_AUDIO_TARGET_FRAMES (about 17 ms: room for a hand-over one vblank
// late, which is common; at about 9 ms there were 9 gaps in 110 s of a
// local run, at 17 ms 1), which keeps the race sound a short, steady time
// behind the race screens instead of drifting up to the cap
// (the boards make a little more audio than the sound card plays: the hub
// paces 60 vblanks a second, a little faster than the guest's own rate).
// It starts at about 35 ms; its top can pass the cap, which in this mode
// only sets the skip back to the cap after a long gap (more than twice the
// cap, as after the mute). The seat draws every vblank
// and hands over about 735 frames at a time; its buffer keeps the plain cap
// (about 23 ms to start, at most about 35 ms behind), which plays well.
export const AUDIO_PRIME_FRAMES = 1536;
export const AUDIO_MAX_BUFFERED_FRAMES = 2304;
export const RACE_AUDIO_TARGET_FRAMES = 768;
export const SEAT_AUDIO_PRIME_FRAMES = 1024;
export const SEAT_AUDIO_MAX_BUFFERED_FRAMES = 1536;
// The worklets report their buffer to the page about five times a second.
export const AUDIO_REPORT_FRAMES = 8820;

// Sound sources by board label, their mixer group and buffer
// (audio-output.js): the player's seat makes the seat sounds; the race
// screen boards make the race audio. In a local run of the attract the
// partner played the music and the master only the BIOS start-up sound
// (the same sound as the partner, at the same moment, so it plays twice for
// a few seconds at boot). The master is kept in the race group in case it
// has race sounds of its own (a linked race with entrants was not checked);
// the master bus limiter (audio-output.js) keeps any doubling from clipping.
export const AUDIO_SOURCES = Object.freeze({
  [PLAYER_BOARD]: Object.freeze({ group: 'seat', primeFrames: SEAT_AUDIO_PRIME_FRAMES, maxBufferedFrames: SEAT_AUDIO_MAX_BUFFERED_FRAMES, reportEveryFrames: AUDIO_REPORT_FRAMES }),
  board0: Object.freeze({ group: 'race', primeFrames: AUDIO_PRIME_FRAMES, maxBufferedFrames: AUDIO_MAX_BUFFERED_FRAMES, targetFrames: RACE_AUDIO_TARGET_FRAMES, reportEveryFrames: AUDIO_REPORT_FRAMES }),
  partner: Object.freeze({ group: 'race', primeFrames: AUDIO_PRIME_FRAMES, maxBufferedFrames: AUDIO_MAX_BUFFERED_FRAMES, targetFrames: RACE_AUDIO_TARGET_FRAMES, reportEveryFrames: AUDIO_REPORT_FRAMES }),
});

// Must be called from the Start click (the AudioContext needs a user
// gesture); the context is created before the first await inside.
export function openCabinetAudio() {
  return createAudioOutput({
    capacityFrames: 8192, sources: AUDIO_SOURCES,

  }).catch(() => null);
}

// The ring of each heard board, for startCabinet's audioBoards.
export function cabinetAudioBoards(audio) {
  if (!audio || typeof audio.source !== 'function') return null;
  const out = {};
  for (const label of Object.keys(AUDIO_SOURCES)) {
    const ring = audio.source(label);
    if (ring) out[label] = ring;
  }
  return out;
}

// startStableCabinet({ files, game, card, input, canvases, source, audio,
//   say, onStats, onFailure }): files = [[name, ArrayBuffer]] read once from
// OPFS; card = the Uint8Array from source.insert(); canvases = six canvas
// elements in BOARDS order. Returns { cabinet, inRace(), checkRace(), finish(), stop() }.
export function startStableCabinet({ files, game, card, input, canvases, source, audio = null, say = () => {}, onStats = () => {}, onFailure = () => {}, log = () => {} }) {
  // The session can end while the page waits (the checkout, the sound): a
  // lost session never starts a cabinet that could not save.
  if (source && typeof source.state === 'function' && source.state() !== 'ready') {
    throw new LeaseLostError(typeof source.lostReason === 'function' ? source.lostReason() || 'lost' : 'lost');
  }
  if (!globalThis.crossOriginIsolated) throw new Error('not cross-origin isolated');
  const inputSab = new SharedArrayBuffer(16);
  const inputI32 = new Int32Array(inputSab);
  let running = true;
  const pump = () => {
    if (!running) return;
    for (let p = 0; p < 4; p++) Atomics.store(inputI32, p, input.mask(p));
    requestAnimationFrame(pump);
  };
  requestAnimationFrame(pump);
  const onBlur = () => { for (let p = 0; p < 4; p++) Atomics.store(inputI32, p, 0); };
  addEventListener('blur', onBlur);

  let failed = false;
  const fail = (why) => {
    if (failed) return;
    failed = true;
    onFailure(why);
  };
  const cabinet = startCabinet({
    files, game, canvases,
    frames: 2e9, hashEvery: 300,
    pinTime: Math.floor(Date.now() / 1000), jitDet: 1, bank: 'snapshot', dynarec: 1,
    paceHz: CABINET_PACE_HZ, barrierTimeoutMs: 10000,
    cards: { [PLAYER_BOARD]: card.slice().buffer },
    watchCards: [PLAYER_BOARD], watchCap: 5000,
    onCardWrite: cardWriteHandler({ isRunning: () => running, source, log }),
    input: inputSab, inputBoard: PLAYER_BOARD,
    audioBoards: cabinetAudioBoards(audio),
    log,
    onEvent: (label, m) => {
      if (m.type === 'error') fail(`${label}: ${m.message}`);
      if (m.type === 'sample' && m.status && m.status.mb && m.status.mb.nondeterministic) log(`[cabinet] ${label}: a barrier timed out`);
    },
  });

  // Status once a second: guest vblanks per second on the player's seat,
  // the link state of that seat, and the race phase from the master.
  const seat = BOARDS.findIndex((b) => b.label === PLAYER_BOARD);
  const ring = BOARDS[seat].seat;
  let lastV = 0;
  let lastT = performance.now();
  const race = createRaceTracker();
  const watchVal = (board, name) => {
    const w = cabinet.state.boards[board].watch;
    for (let i = w.length - 1; i >= 0; i--) if (w[i][1] === name) return w[i][2];
    return null;
  };
  // The race check the timer makes, also run once more on demand (Restart
  // cabinet, just before the stop): an entry in the last second is reported.
  const checkRace = () => raceCheck({ tracker: race, phase: watchVal(0, 'phase'), scene: watchVal(seat, 'scene'), source, log });
  const timer = setInterval(() => {
    const now = performance.now();
    const v = cabinet.vblankCounts()[ring] || 0;
    const fps = ((v - lastV) * 1000) / (now - lastT);
    lastV = v; lastT = now;
    const st = cabinet.state;
    const b1 = st.boards[seat];
    const last = b1.samples.length ? b1.samples[b1.samples.length - 1].status : null;
    const loaded = st.boards.filter((b) => b.loaded).length;
    const phase = watchVal(0, 'phase');
    const scene = watchVal(seat, 'scene');
    checkRace();
    onStats({
      fps, vblanks: v, loaded, boards: st.boards.length,
      linked: !!(last && /^04/.test(last.comm2)),
      phase, scene, inRace: race.inRace(),
      hub: cabinet.hubStatus(),
    });
    if (st.hub.error) fail(`hub: ${st.hub.error}`);
  }, 1000);

  // stop({ keepAudio: true }) (Restart cabinet): the sound context stays
  // open for the next cabinet, which writes into the same rings.
  const stop = ({ keepAudio = false } = {}) => {
    running = false;
    clearInterval(timer);
    removeEventListener('blur', onBlur);
    for (let p = 0; p < 4; p++) Atomics.store(inputI32, p, 0);
    try { cabinet.terminate(); } catch { /* already gone */ }
    if (audio && !keepAudio) { try { audio.close(); } catch { /* closed */ } }
  };
  return {
    cabinet,
    // The player's seat is in a race (entered and not yet out of the race
    // scenes), as this page sees it: a restart is refused meanwhile.
    inRace: () => race.inRace(),
    // One race check now (the timer's check): true when the seat is in a race.
    checkRace: () => (running ? checkRace() : race.inRace()),
    // The joypad word the player's seat reads for one port (tests: a key
    // being bound never reaches the game).
    inputWord: (port) => Atomics.load(inputI32, port),
    // One last look at the card file (a write the 30-frame poll has not
    // seen yet goes to the source first), then the cabinet keeps running
    // until stop().
    finish: () => cabinet.finalCard(PLAYER_BOARD),
    stop,
  };
}
