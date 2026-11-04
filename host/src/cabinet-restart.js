// cabinet-restart.js: the panel's "Restart cabinet", for a game that hangs.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// The same stable session carries on (no new Play from the stable): the old
// cabinet gets one last look at its card file (any write it made goes to the
// stable first), every board stops, the stable source reads the head again
// (card-stable.js reinsert(), one /checkout, checked the way the first start
// checks it) and a new cabinet boots with that card.
//
// Fairness (doc-arcade D-068): a restart is refused while a race is owed,
// that is from the moment the seat enters a race until the card write after
// it is judged, and while a race report or a card write is still on its way.
// Restarting mid-race would otherwise hand the game the pre-race card again
// (a save-scum loop). The service enforces the same rule (a second checkout
// with a race owed ends the session as an abandon, the race as no result);
// the page refuses first, with a plain message, so the only way out of a race
// is the Finish button, whose warning already says it counts as an
// unfinished game. Before the race is entered nothing about its result is
// known, so a restart then dodges nothing.

import { RestartRefusedError } from './card-stable.js';

export const RESTART_MESSAGES = Object.freeze({
  confirm: "Restart the cabinet? Every board stops and starts again with your horse's last saved card. Use this only if the game has stopped responding.",
  race: "A race is still running, so the cabinet can't restart now. Wait for the results to save, then try again. Press Finish to leave instead: that counts as an unfinished game.",
  saving: 'Your horse is saving. Try again in a moment.',
  busy: 'The cabinet is already restarting.',
  not_running: "The cabinet isn't running yet.",
  not_ready: "The cabinet can't restart now. Return to your stable and press Play in browser again.",
  limit: "The cabinet can't restart again in this game. Press Finish to return to your stable, then press Play in browser again.",
  stopping: 'Restarting the cabinet: stopping every board.',
  reading: "Restarting the cabinet: reading your horse's card from your stable.",
  stoppedRace: "The cabinet stopped, but a race is still owed, so it can't start again. Press Finish to return to your stable: that counts as an unfinished game.",
  stoppedOther: "The cabinet stopped and could not start again. Your stable keeps the last card it saved. Press Finish to return to your stable.",
});

// Why a restart can't start now, or null. cab: the running cabinet
// (cabinet-game.js), busy: a restart or finish is already under way.
export function restartBlocker({ source, cab, busy = false }) {
  if (busy) return 'busy';
  if (!cab) return 'not_running';
  if (typeof cab.inRace === 'function' && cab.inRace()) return 'race';
  if (!source || typeof source.restartBlocker !== 'function') return 'not_ready';
  return source.restartBlocker();
}

// restartCabinet({ source, cab, boot, say }) -> { ok: true, cab } with the
// new cabinet, or { ok: false, reason, stopped, error }. boot(card) starts
// the new cabinet and returns it; the card bytes are cleared afterwards.
// stopped: the old cabinet was stopped (the page then offers only Finish).
// One race check now (cabinet-game.js checkRace, the 1 s tracker's check):
// a race entered since the last tick is reported, and counts as owed.
const raceNow = (cab) => {
  try { return typeof cab.checkRace === 'function' ? !!cab.checkRace() : false; } catch { return false; }
};

export async function restartCabinet({ source, cab, boot, say = () => {}, busy = false }) {
  if (cab && !busy) raceNow(cab);
  const why = restartBlocker({ source, cab, busy });
  if (why) return { ok: false, reason: why, stopped: false };
  say(RESTART_MESSAGES.stopping);
  // A last look at the card file: a write the game made in its last moments
  // goes to the stable first. A hung board answers null after its timeout.
  try { await cab.finish(); } catch { /* the board is gone; the source keeps the last write */ }
  // The finish can take seconds: one more race check just before the stop,
  // so an entry in that time is reported and the restart refused, the game
  // left running.
  if (raceNow(cab) || (typeof source.restartBlocker === 'function' && source.restartBlocker() === 'race')) {
    return { ok: false, reason: 'race', stopped: false };
  }
  try { cab.stop({ keepAudio: true }); } catch { /* already stopped */ }
  say(RESTART_MESSAGES.reading);
  let card;
  try {
    card = await source.reinsert();
  } catch (err) {
    if (err instanceof RestartRefusedError) return { ok: false, reason: err.reason, stopped: true, error: err };
    return { ok: false, reason: 'error', stopped: true, error: err };
  }
  try {
    const next = await boot(card);
    return { ok: true, cab: next };
  } catch (err) {
    return { ok: false, reason: 'error', stopped: true, error: err };
  } finally {
    card.fill(0);
  }
}
