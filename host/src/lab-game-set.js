// lab-game-set.js: which game set and link tag the lab cabinet page
// (multiboard.html) runs for an edition. Lab only; the player pages keep
// their own setup checks (rom-setup.js). Everything comes from the edition
// registry (editions.js), never from a lab list: the game file is the
// edition's release set (`<release>.zip`) and the link tag is its linkTag.
// Flycast picks the ROM table entry from the zip's file name, so the page
// must load the game under its own set name (a Rev D zip renamed to
// drbyocwc.zip would be looked up as Rev C and fail).
// The lab page runs every registered edition, buildable or not, so a core
// and link lane can probe an edition before the player game offers it.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later

import { EDITION_REGISTRY, editionDef } from './editions.js';

/** The registry row's lab game set: { edition, game, release, linkTag, build }, or null. */
export function labGameSet(edition) {
  const d = editionDef(edition);
  if (!d) return null;
  return Object.freeze({ edition: d.id, game: `${d.release}.zip`, release: d.release, linkTag: d.linkTag, build: d.build });
}

/**
 * names: the picked file names. Returns the edition's set when its game file
 * is among them, or { error } with a plain message. Extra game files are
 * ignored; the edition decides which one runs.
 */
export function pickLabGameSet(names, edition = 'A') {
  const set = labGameSet(edition);
  if (!set) return { error: `Unknown edition ${edition}. Editions: ${EDITION_REGISTRY.map((e) => e.id).join(', ')}.` };
  const have = new Set(names.map((n) => String(n).toLowerCase()));
  if (!have.has(set.game)) return { error: `Need ${set.game} and naomi.zip for edition ${set.edition}.` };
  return set;
}

/**
 * The edition a lab runner uses for a game file when none is named: the
 * registry's stock edition of that release (drbyocwc.zip is A, never B).
 * null when no registered release has that file name.
 */
export function stockEditionForGame(fileName) {
  const n = String(fileName).toLowerCase();
  const d = EDITION_REGISTRY.find((e) => e.build === 'stock' && `${e.release}.zip` === n);
  return d ? d.id : null;
}

/**
 * Lab only: `?mixtag=<board label>:<tag>` gives one board a different link
 * edition tag, to check that the link refuses mixed editions. Returns
 * { [label]: tag } or {} (absent or malformed: no mixing).
 */
export function parseMixTag(v) {
  const m = /^(board[0-9]|partner):([0-9]{1,3})$/.exec(String(v || ''));
  if (!m) return {};
  const tag = Number(m[2]);
  return tag > 255 ? {} : { [m[1]]: tag };
}
