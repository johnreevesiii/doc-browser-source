// card-store.js: lab horse cards for the Sanwa CRP-1231 card reader that
// Flycast emulates for Derby Owners Club (core/hw/naomi/card_reader.cpp).
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// A card is the reader's three magnetic tracks, 3 x 0x45 = 207 bytes. The
// core reads and writes it as <save>/reicast/<game file name>.card: it
// loads the file when the insert button goes down (CardReaderWriter::
// insertCard) and rewrites it after every CARD_WRITE command. This module
// keeps the player's picked card in the browser's Origin Private File
// System (folder "cards"), copies it into the core's file system before
// boot, and saves the card the game wrote back into the same OPFS folder.
// Nothing here uses the network (test/policy.test.mjs).

export const CARD_DIR_NAME = 'cards';
export const CARD_TRACK_BYTES = 0x45;
export const CARD_BYTES = CARD_TRACK_BYTES * 3; // 207
export const CARD_EXTENSION = '.card';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;

// Returns null when the name is acceptable, or a short reason string.
export function checkCardName(name) {
  if (typeof name !== 'string' || name.length === 0) return 'empty name';
  if (name.includes('/') || name.includes('\\')) return 'path separators not allowed';
  if (name.includes('..')) return 'dot segments not allowed';
  if (!NAME_RE.test(name)) return 'unsupported characters';
  if (!name.toLowerCase().endsWith(CARD_EXTENSION)) return 'not a .card file';
  return null;
}

export function checkCardSize(size) {
  if (size !== CARD_BYTES) return `a card file is ${CARD_BYTES} bytes, this one is ${size}`;
  return null;
}

// Where the core looks for the card: Flycast's libretro build sets the
// arcade flash base to <save dir>/reicast/<content file name> (extension
// kept), and the card reader appends ".card".
export function coreCardPath(saveDir, gameFileName) {
  if (typeof gameFileName !== 'string' || gameFileName.includes('/') || gameFileName.includes('..')) {
    throw new Error('bad game file name');
  }
  return `${saveDir}/reicast/${gameFileName}${CARD_EXTENSION}`;
}

function mkdirp(FS, path) {
  let cur = '';
  for (const part of path.split('/').filter(Boolean)) {
    cur += `/${part}`;
    try { FS.mkdir(cur); } catch { /* exists */ }
  }
}

// Copies card bytes into the core's in-memory FS (Emscripten Module.FS).
export function mountCard(FS, saveDir, gameFileName, bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('card bytes must be a Uint8Array');
  const sizeErr = checkCardSize(bytes.length);
  if (sizeErr) throw new Error(sizeErr);
  const path = coreCardPath(saveDir, gameFileName);
  mkdirp(FS, path.slice(0, path.lastIndexOf('/')));
  FS.writeFile(path, bytes);
  return path;
}

// Reads the card file back from the core's FS; null when there is none.
export function readCoreCard(FS, path) {
  try {
    return FS.readFile(path);
  } catch {
    return null;
  }
}

export function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Watches the core's card file and calls onChange(bytes) once per change.
// poll() is cheap (one 207-byte MEMFS read) and is called every few frames.
export function createCardWatcher(FS, path, initial, onChange) {
  let last = initial ? new Uint8Array(initial) : null;
  let changes = 0;
  return {
    poll() {
      const now = readCoreCard(FS, path);
      if (!now || sameBytes(now, last)) return false;
      last = new Uint8Array(now);
      changes++;
      onChange(last);
      return true;
    },
    changes: () => changes,
    current: () => (last ? new Uint8Array(last) : null),
  };
}

function defaultGetRoot() {
  const nav = globalThis.navigator;
  if (!nav || !nav.storage || typeof nav.storage.getDirectory !== 'function') {
    throw new Error('OPFS is not available in this browser');
  }
  return nav.storage.getDirectory();
}

// createCardStore({ getRoot }): OPFS folder "cards". Same shape as the ROM
// store, but cards are small and are written back by the page.
export function createCardStore(options = {}) {
  const getRoot = options.getRoot || defaultGetRoot;

  async function dir() {
    const root = await getRoot();
    return root.getDirectoryHandle(CARD_DIR_NAME, { create: true });
  }

  async function write(name, bytes) {
    const nameErr = checkCardName(name);
    if (nameErr) throw new Error(`rejected ${name}: ${nameErr}`);
    const sizeErr = checkCardSize(bytes.length);
    if (sizeErr) throw new Error(`rejected ${name}: ${sizeErr}`);
    const d = await dir();
    const handle = await d.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(bytes);
      await writable.close();
    } catch (err) {
      if (typeof writable.abort === 'function') await writable.abort();
      throw err;
    }
    return { name, size: bytes.length };
  }

  // file: a File or Blob with .name and .size, from <input type=file>.
  async function save(file) {
    if (!file) throw new Error('no file');
    const nameErr = checkCardName(file.name);
    if (nameErr) throw new Error(`rejected ${file.name}: ${nameErr}`);
    const sizeErr = checkCardSize(file.size);
    if (sizeErr) throw new Error(`rejected ${file.name}: ${sizeErr}`);
    return write(file.name, new Uint8Array(await file.arrayBuffer()));
  }

  async function list() {
    const d = await dir();
    const out = [];
    for await (const [name, handle] of d.entries()) {
      if (handle.kind !== 'file' || checkCardName(name)) continue;
      const f = await handle.getFile();
      out.push({ name, size: f.size });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  async function read(name) {
    const nameErr = checkCardName(name);
    if (nameErr) throw new Error(`bad name ${name}: ${nameErr}`);
    const d = await dir();
    const f = await (await d.getFileHandle(name)).getFile();
    return new Uint8Array(await f.arrayBuffer());
  }

  async function remove(name) {
    const nameErr = checkCardName(name);
    if (nameErr) throw new Error(`bad name ${name}: ${nameErr}`);
    await (await dir()).removeEntry(name);
  }

  return { save, write, list, read, remove };
}

// CardSource: where the host's card reader gets its card and where the
// game's card writes go. The host only calls this interface:
//   insert(): Promise<Uint8Array>  the 207-byte card to put in the reader
//   write(bytes): Promise<void>     called after every card write by the game
//   eject(): Promise<void>          the card leaves the reader
// Only LocalLabCardSource exists now (dev only: a lab card the developer
// stored in this browser; writes stay in browser storage). A later
// StableCardSource will load and save cards through the stable management
// service, so nothing here assumes a file picker, and the page never offers
// card bytes for download.
export function createLocalLabCardSource({ store, name }) {
  const nameErr = checkCardName(name);
  if (nameErr) throw new Error(`bad card name ${name}: ${nameErr}`);
  let saving = Promise.resolve();
  return {
    kind: 'local-lab',
    name,
    async insert() {
      const bytes = await store.read(name);
      const sizeErr = checkCardSize(bytes.length);
      if (sizeErr) throw new Error(sizeErr);
      return bytes;
    },
    // Writes run one after another, so the last write always wins.
    write(bytes) {
      const copy = new Uint8Array(bytes);
      saving = saving.then(() => store.write(name, copy));
      return saving;
    },
    async eject() { await saving; },
  };
}
