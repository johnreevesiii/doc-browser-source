// edition-b.js: Edition B ("Rev C Rebalanced", doc-ops D-072) built in the
// player's browser from the player's own stock Rev C game file.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// A JavaScript port of the reviewed TypeScript patcher (doc-ops
// research/engine-bible/browser/editionb/ts/src/editionPatch.ts,
// parseEditionSpec and patchedImage), with its own small zip reader and
// writer so the page needs no library:
// - The spec (edition-b-spec.js) carries no ROM bytes. Each edit is a new
//   word written by IHA or a copy of a word from the player's own SOURCE
//   image (never from the partly patched one).
// - The source program image is checked by size, CRC32 and SHA-256 before
//   any edit, and the result by SHA-256 after (the reviewed output pin), so
//   a wrong file or a wrong spec can never give an image.
// - The game zip is rebuilt in memory: every other member keeps its stored
//   (compressed) bytes as they are, the program member is replaced by the
//   patched image, stored uncompressed under the zip's own spelling of its
//   name. The zip keeps its file name, so the core finds the same game.
// - Nothing is written anywhere: the built zip lives in page memory only,
//   for the boards of this game. No network code (test/policy.test.mjs).
//
// Editions never mix (D-059, D-062): the link carries the edition tag and a
// session tag made from the hash of the locally built image (join hash), so
// boards running different images never share a link.

import { EDITION_B_SPEC_JSON } from './edition-b-spec.js';
import { EDITION_REGISTRY, editionDef, isBuildable } from './editions.js';

// Player-facing names for every registered edition (editions.js). The
// internal ids stay 'A', 'B', and so on.
export const EDITION_NAMES = Object.freeze(Object.fromEntries(EDITION_REGISTRY.map((e) => [e.id, e.name])));
// The LinkBus edition tag (linkbus/linkbus.h enum Edition) of each edition
// this build can run: 1 = A, 2 = B. Reserved tags of editions not yet
// buildable are left out, so no page builds link tags the core refuses.
export const LINK_EDITION = Object.freeze(Object.fromEntries(EDITION_REGISTRY.filter((e) => e.buildable).map((e) => [e.id, e.linkTag])));

export class EditionSpecError extends Error {}
export class EditionImageError extends Error {}
/**
 * This browser lacks what the build needs (Web Crypto's SHA-256, or DecompressionStream with 'deflate-raw'). Kept
 * apart from EditionImageError so the player is told to change browser, never that his files are wrong.
 */
export class EditionBrowserError extends Error {}

/**
 * Why this browser can't build Rev C Rebalanced, or null when it can. Checks what editionFiles uses: crypto.subtle
 * (absent outside a secure context and in old browsers), Blob streams, and DecompressionStream that accepts
 * 'deflate-raw' (older browsers have the constructor but reject that format).
 */
export function editionBrowserProblem(g = globalThis) {
  if (!g.crypto || !g.crypto.subtle || typeof g.crypto.subtle.digest !== 'function') return 'no Web Crypto';
  if (typeof g.DecompressionStream !== 'function') return 'no DecompressionStream';
  try { new g.DecompressionStream('deflate-raw'); } catch { return 'no deflate-raw'; }
  if (typeof g.Blob !== 'function' || typeof g.Blob.prototype.stream !== 'function') return 'no Blob streams';
  return null;
}

const TOP_KEYS = new Set(['format', 'edition', 'manifest', 'fixes', 'member', 'base', 'source_size',
  'source_crc32', 'source_sha256', 'output_sha256', 'relocated_words', 'edits']);
const EDIT_KEYS = new Set(['fix', 'address', 'new_word', 'copy_from']);
const HEX4 = /^[0-9A-F]{4}$/;
const HEX8 = /^[0-9A-F]{8}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const FIX_ID = /^Q[0-9]{2}$/;
const MEMBER = /^[A-Za-z0-9._-]+$/;

const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
function fail(message) { throw new EditionSpecError(message); }

/** Validate an untrusted spec object. Unknown keys are refused, so a private spec (with stock words) never loads. */
export function parseEditionSpec(value) {
  if (!isRecord(value)) fail('edition spec must be an object');
  for (const key of Object.keys(value)) if (!TOP_KEYS.has(key)) fail(`edition spec key ${key} is not allowed`);
  for (const key of TOP_KEYS) if (!(key in value)) fail(`edition spec lacks ${key}`);
  const v = value;
  if (v.format !== 'doc-edition-spec/1') fail('unsupported edition spec format');
  if (v.edition !== 'B') fail('edition spec must be edition B');
  if (typeof v.manifest !== 'string' || v.manifest === '') fail('manifest must be a name');
  if (typeof v.member !== 'string' || !MEMBER.test(v.member) || v.member === '.' || v.member === '..')
    fail('member must be a plain file name (no path separators, not . or ..)');
  if (typeof v.base !== 'string' || !HEX8.test(v.base)) fail('base must be 8 upper hex digits');
  if (typeof v.source_size !== 'number' || !Number.isSafeInteger(v.source_size) || v.source_size <= 0)
    fail('source_size must be a positive integer');
  if (typeof v.source_crc32 !== 'string' || !HEX8.test(v.source_crc32)) fail('source_crc32 must be 8 upper hex');
  for (const key of ['source_sha256', 'output_sha256']) {
    if (typeof v[key] !== 'string' || !HEX64.test(v[key])) fail(`${key} must be 64 lower hex digits`);
  }
  if (v.relocated_words !== 'copy' && v.relocated_words !== 'literal') fail('relocated_words must be copy or literal');
  if (!Array.isArray(v.fixes) || v.fixes.length === 0 || !v.fixes.every((f) => typeof f === 'string' && FIX_ID.test(f))
    || new Set(v.fixes).size !== v.fixes.length) fail('fixes must be distinct quirk ids');
  const fixes = new Set(v.fixes);
  if (!Array.isArray(v.edits) || v.edits.length === 0) fail('edits must be a non-empty list');
  const base = parseInt(v.base, 16);
  const size = v.source_size;
  const inRange = (address) => address % 2 === 0 && address >= base && address - base + 2 <= size;
  const seen = new Set();
  const edits = [];
  v.edits.forEach((edit, index) => {
    if (!isRecord(edit)) fail(`edit ${index} must be an object`);
    for (const key of Object.keys(edit)) if (!EDIT_KEYS.has(key)) fail(`edit ${index} key ${key} is not allowed`);
    const { fix, address, new_word: newWord, copy_from: copyFrom } = edit;
    if (typeof fix !== 'string' || !fixes.has(fix)) fail(`edit ${index} names a fix not in fixes`);
    if (typeof address !== 'string' || !HEX8.test(address)) fail(`edit ${index} address must be 8 upper hex`);
    const at = parseInt(address, 16);
    if (!inRange(at)) fail(`edit ${index} address ${address} is odd or outside the image`);
    if (seen.has(at)) fail(`edit ${index} repeats address ${address}`);
    seen.add(at);
    if ((newWord === undefined) === (copyFrom === undefined)) fail(`edit ${index} needs exactly one of new_word, copy_from`);
    if (newWord !== undefined && (typeof newWord !== 'string' || !HEX4.test(newWord)))
      fail(`edit ${index} new_word must be 4 upper hex`);
    if (copyFrom !== undefined) {
      if (typeof copyFrom !== 'string' || !HEX8.test(copyFrom)) fail(`edit ${index} copy_from must be 8 upper hex`);
      const from = parseInt(copyFrom, 16);
      if (!inRange(from) || from === at) fail(`edit ${index} copy_from ${copyFrom} is odd, outside or itself`);
    }
    edits.push(newWord !== undefined ? { fix, address, new_word: newWord } : { fix, address, copy_from: copyFrom });
  });
  if (v.relocated_words === 'literal' && edits.some((e) => e.copy_from !== undefined))
    fail('a literal-mode spec must not carry copy_from');
  return Object.freeze({
    format: v.format, edition: v.edition, manifest: v.manifest, fixes: Object.freeze([...v.fixes]), member: v.member,
    base: v.base, source_size: size, source_crc32: v.source_crc32, source_sha256: v.source_sha256,
    output_sha256: v.output_sha256, relocated_words: v.relocated_words, edits: Object.freeze(edits),
  });
}

/** The spec this page ships, parsed and checked once. */
let shipped = null;
export function shippedSpec() {
  if (!shipped) shipped = parseEditionSpec(JSON.parse(EDITION_B_SPEC_JSON));
  return shipped;
}

let crcTable = null;
export function crc32(data) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function defaultSubtle() {
  const s = globalThis.crypto && globalThis.crypto.subtle;
  if (!s) throw new EditionBrowserError('this browser cannot check files (no Web Crypto)');
  return s;
}

export async function sha256Hex(data, subtle = defaultSubtle()) {
  const d = new Uint8Array(await subtle.digest('SHA-256', data));
  let s = '';
  for (const b of d) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Build the edition B program image from the player's own stock image. Throws EditionImageError on any mismatch. */
export async function patchedImage(spec, source, subtle = defaultSubtle()) {
  if (source.length !== spec.source_size) throw new EditionImageError('source image size does not match');
  if (crc32(source).toString(16).toUpperCase().padStart(8, '0') !== spec.source_crc32)
    throw new EditionImageError('source image CRC32 does not match');
  if ((await sha256Hex(source, subtle)) !== spec.source_sha256) throw new EditionImageError('source image SHA-256 does not match');
  const base = parseInt(spec.base, 16);
  const image = new Uint8Array(source);
  const seen = new Set();
  for (const edit of spec.edits) {
    const offset = parseInt(edit.address, 16) - base;
    if (offset < 0 || offset % 2 !== 0 || offset + 2 > image.length || seen.has(offset))
      throw new EditionImageError(`invalid or repeated address ${edit.address}`);
    seen.add(offset);
    let lo;
    let hi;
    if (edit.copy_from !== undefined) {
      const from = parseInt(edit.copy_from, 16) - base;
      if (from < 0 || from % 2 !== 0 || from + 2 > source.length) throw new EditionImageError(`invalid copy_from ${edit.copy_from}`);
      lo = source[from];
      hi = source[from + 1];
    } else {
      const word = parseInt(edit.new_word, 16);
      lo = word & 0xff;
      hi = word >>> 8;
    }
    image[offset] = lo;
    image[offset + 1] = hi;
  }
  if ((await sha256Hex(image, subtle)) !== spec.output_sha256) throw new EditionImageError('patched image SHA-256 does not match');
  return image;
}

// ---------------------------------------------------------------------------
// Zip: read the central directory, inflate one member, write a new zip.
// Plain zips only (no zip64, no encryption, one disk), which is what a game
// set is. Anything else is refused, never guessed at.
// ---------------------------------------------------------------------------

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;

function zipFail(why) { throw new EditionImageError(`game zip ${why}`); }

/** The members of a zip, from its central directory. */
export function readZip(zip) {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === SIG_END) { end = i; break; }
  }
  if (end < 0) zipFail('cannot be read');
  const disk = dv.getUint16(end + 4, true), cdDisk = dv.getUint16(end + 6, true);
  const countHere = dv.getUint16(end + 8, true), count = dv.getUint16(end + 10, true);
  const cdSize = dv.getUint32(end + 12, true), cdOffset = dv.getUint32(end + 16, true);
  if (disk !== 0 || cdDisk !== 0 || countHere !== count) zipFail('spans disks');
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) zipFail('is a zip64 file');
  if (cdOffset + cdSize > end) zipFail('cannot be read');
  const entries = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > end || dv.getUint32(p, true) !== SIG_CENTRAL) zipFail('cannot be read');
    const flags = dv.getUint16(p + 8, true);
    const e = {
      versionMade: dv.getUint16(p + 4, true), versionNeeded: dv.getUint16(p + 6, true), flags,
      method: dv.getUint16(p + 10, true), time: dv.getUint16(p + 12, true), date: dv.getUint16(p + 14, true),
      crc: dv.getUint32(p + 16, true), csize: dv.getUint32(p + 20, true), usize: dv.getUint32(p + 24, true),
      internalAttr: dv.getUint16(p + 36, true), externalAttr: dv.getUint32(p + 38, true),
      localOffset: dv.getUint32(p + 42, true),
    };
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    e.nameBytes = zip.subarray(p + 46, p + 46 + nlen);
    e.name = new TextDecoder().decode(e.nameBytes);
    if (flags & 1) zipFail('is encrypted');
    if (e.csize === 0xffffffff || e.usize === 0xffffffff || e.localOffset === 0xffffffff) zipFail('is a zip64 file');
    const lo = e.localOffset;
    if (lo + 30 > cdOffset || dv.getUint32(lo, true) !== SIG_LOCAL) zipFail('cannot be read');
    const dataStart = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
    if (dataStart + e.csize > cdOffset) zipFail('cannot be read');
    e.data = zip.subarray(dataStart, dataStart + e.csize);
    entries.push(e);
    p += 46 + nlen + elen + clen;
  }
  return entries;
}

/** Inflate a raw deflate stream (zip method 8) with the browser's own DecompressionStream. */
export async function inflateRaw(data, expectedSize) {
  if (typeof DecompressionStream !== 'function') throw new EditionBrowserError('this browser cannot read zip files');
  let ds;
  try { ds = new DecompressionStream('deflate-raw'); } catch { throw new EditionBrowserError('this browser cannot read zip files (no deflate-raw)'); }
  const out = new Uint8Array(expectedSize);
  let at = 0;
  const reader = new Blob([data]).stream().pipeThrough(ds).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (at + value.length > expectedSize) throw new EditionImageError('game zip member is larger than it says');
      out.set(value, at);
      at += value.length;
    }
  } catch (err) {
    if (err instanceof EditionImageError) throw err;
    throw new EditionImageError('game zip member cannot be read');
  }
  if (at !== expectedSize) throw new EditionImageError('game zip member is smaller than it says');
  return out;
}

async function memberBytes(e) {
  if (e.method === 0) return e.data.slice();
  if (e.method === 8) return inflateRaw(e.data, e.usize);
  throw new EditionImageError('game zip uses a compression this page cannot read');
}

/** Write a zip from entries ({ name bytes, method, time, date, crc, csize, usize, data, attrs }). */
export function writeZip(entries) {
  let total = 22;
  for (const e of entries) total += 30 + e.nameBytes.length + e.data.length + 46 + e.nameBytes.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let p = 0;
  const offsets = [];
  for (const e of entries) {
    offsets.push(p);
    dv.setUint32(p, SIG_LOCAL, true);
    dv.setUint16(p + 4, e.versionNeeded, true);
    dv.setUint16(p + 6, e.flags, true);
    dv.setUint16(p + 8, e.method, true);
    dv.setUint16(p + 10, e.time, true);
    dv.setUint16(p + 12, e.date, true);
    dv.setUint32(p + 14, e.crc, true);
    dv.setUint32(p + 18, e.csize, true);
    dv.setUint32(p + 22, e.usize, true);
    dv.setUint16(p + 26, e.nameBytes.length, true);
    dv.setUint16(p + 28, 0, true);
    out.set(e.nameBytes, p + 30);
    out.set(e.data, p + 30 + e.nameBytes.length);
    p += 30 + e.nameBytes.length + e.data.length;
  }
  const cdStart = p;
  entries.forEach((e, i) => {
    dv.setUint32(p, SIG_CENTRAL, true);
    dv.setUint16(p + 4, e.versionMade, true);
    dv.setUint16(p + 6, e.versionNeeded, true);
    dv.setUint16(p + 8, e.flags, true);
    dv.setUint16(p + 10, e.method, true);
    dv.setUint16(p + 12, e.time, true);
    dv.setUint16(p + 14, e.date, true);
    dv.setUint32(p + 16, e.crc, true);
    dv.setUint32(p + 20, e.csize, true);
    dv.setUint32(p + 24, e.usize, true);
    dv.setUint16(p + 28, e.nameBytes.length, true);
    dv.setUint16(p + 30, 0, true);
    dv.setUint16(p + 32, 0, true);
    dv.setUint16(p + 34, 0, true);
    dv.setUint16(p + 36, e.internalAttr, true);
    dv.setUint32(p + 38, e.externalAttr, true);
    dv.setUint32(p + 42, offsets[i], true);
    out.set(e.nameBytes, p + 46);
    p += 46 + e.nameBytes.length;
  });
  dv.setUint32(p, SIG_END, true);
  dv.setUint16(p + 8, entries.length, true);
  dv.setUint16(p + 10, entries.length, true);
  dv.setUint32(p + 12, p - cdStart, true);
  dv.setUint32(p + 16, cdStart, true);
  return out;
}

/**
 * Replace the program member of the player's game zip with its edition B image. The member is matched ignoring case
 * (player zips differ), the zip's spelling is kept, and two members that differ only in case are refused. Every
 * other member keeps its stored bytes. The result is the same for the same input (no clock is read).
 */
export async function editionZip(spec, zip, subtle = defaultSubtle()) {
  const entries = readZip(zip);
  const wanted = spec.member.toLowerCase();
  const matches = entries.filter((e) => e.name.toLowerCase() === wanted);
  if (matches.length === 0) throw new EditionImageError(`game zip lacks ${spec.member}`);
  if (matches.length > 1) throw new EditionImageError(`game zip has more than one ${spec.member} (differing in case)`);
  const member = matches[0];
  if (member.usize !== spec.source_size) throw new EditionImageError('source image size does not match');
  const source = await memberBytes(member);
  const patched = await patchedImage(spec, source, subtle);
  const out = entries.map((e) => {
    // Bit 3 (sizes in a trailing data descriptor) is cleared: the new local header carries the sizes itself.
    const base = { ...e, flags: e.flags & ~0x0008 };
    if (e !== member) return base;
    return { ...base, method: 0, crc: crc32(patched), csize: patched.length, usize: patched.length, data: patched,
      versionNeeded: Math.max(10, Math.min(e.versionNeeded, 20)) };
  });
  return writeZip(out);
}

/**
 * The game files for one edition, read once: [[name, Uint8Array]] in setup order, the game file's name, and the
 * join hash (the SHA-256 of the game file the boards will run). A: the stored files as they are. B: the game file
 * is rebuilt in memory by editionZip; any mismatch throws EditionImageError and nothing runs.
 * read(name) returns the stored file's bytes (rom-store.js read).
 */
export async function editionFiles({ edition, setup, read, spec = null, subtle = defaultSubtle() }) {
  if (!isBuildable(edition)) throw new EditionImageError('unknown edition');
  const rebuilt = editionDef(edition).build === 'edition-b';
  const game = setup.files.find((f) => f.role === 'game');
  if (!game) throw new EditionImageError('no game file is set up');
  const files = [];
  let joinHash = rebuilt ? null : game.sha256;
  for (const f of setup.files) {
    let bytes = await read(f.name);
    if (rebuilt && f.role === 'game') {
      bytes = await editionZip(spec || shippedSpec(), bytes, subtle);
      joinHash = await sha256Hex(bytes, subtle);
    }
    files.push([f.name, bytes]);
  }
  return { files, game: game.name, joinHash };
}

const SESSION_BASE = 0x4c425332; // "LBS2", the lab's fixed tag (lb-cabinet.js SESSION_TAG)

/**
 * The link tags for a game: the LinkBus edition tag and a session tag made from the join hash, so boards that run
 * a different image (the other edition, or a changed file) never share a link (D-062 item 5).
 */
export function linkTags(edition, joinHash) {
  const code = LINK_EDITION[edition];
  if (!code) throw new EditionImageError('unknown edition');
  if (typeof joinHash !== 'string' || !HEX64.test(joinHash)) throw new EditionImageError('no join hash');
  const tag = (parseInt(joinHash.slice(0, 8), 16) ^ SESSION_BASE) >>> 0;
  return Object.freeze({ edition: code, sessionTag: tag || SESSION_BASE });
}

/** Two players may join one link only when edition and image match: null = they may, else why not. */
export function joinProblem(local, remote) {
  if (!local || !remote || !LINK_EDITION[local.edition] || !LINK_EDITION[remote.edition]) return 'unknown';
  if (local.edition !== remote.edition) return 'edition';
  if (!HEX64.test(String(local.joinHash)) || local.joinHash !== remote.joinHash) return 'image';
  return null;
}

export const EDITION_MESSAGES = Object.freeze({
  build: 'Building Rev C Rebalanced from your game files on this device.',
  browser: 'This browser can\'t build Rev C Rebalanced. Use a current version of Chrome (or Edge) and try again. Your horse and your game files are fine.',
  refused: 'Your game files on this device are not the stock Rev C set, so Rev C Rebalanced cannot be built from them. Editions never mix. Go back to your stable and set up the stock Rev C files.',
});
