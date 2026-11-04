// rom-setup.js: the game page's check of the ROM set up on this device by
// the stable page (doc-arcade components/BrowserRomSetup, lib/browserRomSetup).
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// The stable page verifies the player's own files by SHA-256 against the
// expected set and copies them into this origin's OPFS folder "roms" (the
// same folder rom-store.js uses), with a record "doc-setup.json":
//   { v: 1, files: [{ name, role: "game" | "bios", sha256, size }],
//     editions: ["A", ...], set_at }
// Before a stable game starts, this module hashes the stored files again
// and compares them with the record, so a file swapped after setup is
// caught. Nothing here uses the network (test/policy.test.mjs). The record
// holds hashes of the player's own files, on the player's device only.
//
// The game page ALWAYS requires a setup record: with no doc-setup.json it
// refuses to start ("missing"). The stable page only writes that record
// when the flag's `rom` list is non-empty; with an empty list the stable
// skips the setup step and Play does not wait for it (doc-arcade
// CLAUDE.md), so every stable game would then be refused here. A pilot
// therefore needs a non-empty flag `rom` list. An empty list is not a way
// to run the game without the check.

import { ROM_DIR_NAME, checkRomName } from './rom-store.js';

export const SETUP_FILE = 'doc-setup.json';
const HEX64 = /^[0-9a-f]{64}$/;

// Editions this build of the game can run. Edition A is the stock Rev C
// set as stored. Edition B ("Rev C Rebalanced", doc-ops D-072) is built in
// the player's browser from that same stock set (edition-b.js), so a device
// set up for A can run B too; the build itself refuses any file that is not
// the stock set. Editions never mix (D-059, D-062).
export const BUILDABLE_EDITIONS = Object.freeze(['A', 'B']);

// The editions a device's stored game file can run. B is only ever built
// in this browser from the stock set (D-072: never from a prebuilt B file),
// so a record that holds the stock set (A) runs both, and any other record
// runs neither.
export function deviceEditions(setup) {
  const own = setup && Array.isArray(setup.editions) ? setup.editions : [];
  return own.includes('A') ? ['A', 'B'] : [];
}

// The edition this page runs for a hand-off: the hand-off's edition when
// this build can run it, else the first buildable one (and the card source
// then refuses the horse as the other edition). The server's own record of
// the horse's edition is checked against this at every checkout.
export function pageEdition(handoff) {
  const e = handoff && handoff.edition;
  return BUILDABLE_EDITIONS.includes(e) ? e : BUILDABLE_EDITIONS[0];
}

export function parseSetup(raw) {
  let r;
  try { r = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  if (!r || r.v !== 1 || !Array.isArray(r.files) || !Array.isArray(r.editions)) return null;
  const files = [];
  for (const f of r.files) {
    if (!f || checkRomName(f.name) || !HEX64.test(String(f.sha256)) || !(f.role === 'game' || f.role === 'bios')) return null;
    if (!Number.isFinite(f.size) || f.size <= 0) return null;
    files.push({ name: f.name, role: f.role, sha256: f.sha256, size: f.size });
  }
  if (files.filter((f) => f.role === 'game').length !== 1) return null;
  const editions = r.editions.filter((e) => e === 'A' || e === 'B');
  if (!editions.length) return null;
  return { files, editions };
}

export async function sha256Hex(bytes, subtle = globalThis.crypto && globalThis.crypto.subtle) {
  if (!subtle) throw new Error('this browser cannot check files (no Web Crypto)');
  const d = new Uint8Array(await subtle.digest('SHA-256', bytes));
  let s = '';
  for (const b of d) s += b.toString(16).padStart(2, '0');
  return s;
}

function defaultGetRoot() {
  const nav = globalThis.navigator;
  if (!nav || !nav.storage || typeof nav.storage.getDirectory !== 'function') {
    throw new Error('OPFS is not available in this browser');
  }
  return nav.storage.getDirectory();
}

/**
 * Check this device's setup. Returns { ok: true, setup, game } or
 * { ok: false, reason } with plain wording for the player.
 * expected: the flag's current expected hashes, passed by the stable page in
 * the hand-off (rom_sha256). When given, every stored file must still be on
 * that list, so a file the flag no longer lists is refused even though it
 * matches the device's own record. An empty `expected` (an old hand-off)
 * falls back to the record alone; the record was written by the stable page
 * after checking the flag's list at setup time. The record itself is always
 * required: an empty flag `rom` list means no record is ever written, so
 * the game refuses to start (see the header). The pilot needs a non-empty
 * flag `rom` list.
 */
export async function verifySetup({ getRoot = defaultGetRoot, subtle, expected = [] } = {}) {
  let dir;
  try { dir = await (await getRoot()).getDirectoryHandle(ROM_DIR_NAME, { create: false }); } catch { dir = null; }
  if (!dir) return { ok: false, reason: 'missing' };
  let setup = null;
  try {
    const f = await (await dir.getFileHandle(SETUP_FILE)).getFile();
    setup = parseSetup(await f.text());
  } catch { setup = null; }
  if (!setup) return { ok: false, reason: 'missing' };
  const listed = new Set((expected || []).filter((h) => HEX64.test(String(h))));
  if (listed.size && setup.files.some((f) => !listed.has(f.sha256))) return { ok: false, reason: 'changed' };
  for (const spec of setup.files) {
    let bytes;
    try { bytes = new Uint8Array(await (await (await dir.getFileHandle(spec.name)).getFile()).arrayBuffer()); } catch { return { ok: false, reason: 'missing' }; }
    if (bytes.length !== spec.size || (await sha256Hex(bytes, subtle)) !== spec.sha256) return { ok: false, reason: 'changed' };
  }
  return { ok: true, setup, game: setup.files.find((f) => f.role === 'game').name };
}

/** Why this device can't run a horse of `edition` (null = it can). */
export function editionProblem(edition, setup) {
  if (!BUILDABLE_EDITIONS.includes(edition)) return 'not-built';
  if (!setup || !deviceEditions(setup).includes(edition)) return 'not-set-up';
  return null;
}

export const SETUP_MESSAGES = Object.freeze({
  missing: 'This device has no game files set up yet. Go back to your stable and set up your game files first.',
  changed: 'The game files on this device changed since they were checked. Go back to your stable and set them up again.',
  'not-built': 'The browser game cannot run the edition of this horse yet. Editions never mix, so it stays in your stable for now.',
  'not-set-up': 'The game files on this device are not for the edition of this horse. Editions never mix. Go back to your stable and set up the right files.',
});
