// rom-store.js: keeps the player's own ROM files in the browser's Origin
// Private File System (OPFS). GPL-2.0-or-later.
//
// Invariant I1 (PLAN_V2 section 0): the player brings the ROM, and it never
// leaves their browser. This module therefore has no network code at all;
// test/policy.test.mjs fails the build if any network API appears here or
// in rom-picker.js.

export const ROM_DIR_NAME = 'roms';

// Containers Flycast can open. DOC is a NAOMI zip; the others let PLAN_V2
// 2.3 boot a free homebrew test target without any NAOMI data.
export const ALLOWED_EXTENSIONS = Object.freeze([
  '.zip', '.7z', '.chd', '.cdi', '.gdi', '.bin', '.elf',
]);

// Largest single file accepted (2 GiB). A GD-ROM image can be large; DOC
// zips are far smaller.
export const MAX_ROM_BYTES = 2 * 1024 * 1024 * 1024;

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;

// Returns null when the name is acceptable, or a short reason string.
export function checkRomName(name) {
  if (typeof name !== 'string' || name.length === 0) return 'empty name';
  if (name.includes('/') || name.includes('\\')) return 'path separators not allowed';
  if (name === '.' || name === '..' || name.includes('..')) return 'dot segments not allowed';
  if (!NAME_RE.test(name)) return 'unsupported characters';
  const lower = name.toLowerCase();
  const ok = ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext));
  if (!ok) return 'unsupported file type';
  return null;
}

export function checkRomSize(size) {
  if (!Number.isFinite(size) || size <= 0) return 'empty file';
  if (size > MAX_ROM_BYTES) return 'file too large';
  return null;
}

function defaultGetRoot() {
  const nav = globalThis.navigator;
  if (!nav || !nav.storage || typeof nav.storage.getDirectory !== 'function') {
    throw new Error('OPFS is not available in this browser');
  }
  return nav.storage.getDirectory();
}

// createRomStore({ getRoot, storage }): getRoot returns the OPFS root
// directory handle (injectable for tests); storage is navigator.storage.
export function createRomStore(options = {}) {
  const getRoot = options.getRoot || defaultGetRoot;
  const storage = options.storage !== undefined
    ? options.storage
    : (globalThis.navigator && globalThis.navigator.storage) || null;

  async function dir() {
    const root = await getRoot();
    return root.getDirectoryHandle(ROM_DIR_NAME, { create: true });
  }

  async function isAvailable() {
    try {
      await getRoot();
      return true;
    } catch {
      return false;
    }
  }

  // Ask the browser not to evict the ROM folder under storage pressure.
  // Returns true, false, or null when the API is missing or the browser has
  // not answered within timeoutMs (headless Firefox never settles the
  // persist() promise; a real browser may sit on a permission prompt).
  async function requestPersistence({ timeoutMs = 3000 } = {}) {
    if (!storage || typeof storage.persist !== 'function') return null;
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
    try {
      const asked = Promise.resolve().then(() => storage.persist()).then(Boolean, () => false);
      return await Promise.race([asked, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // file: a File or Blob with .name and .size (from <input type=file>).
  // Copies it into OPFS by streaming; nothing is sent anywhere.
  async function save(file) {
    if (!file) throw new Error('no file');
    const nameErr = checkRomName(file.name);
    if (nameErr) throw new Error(`rejected ${file.name}: ${nameErr}`);
    const sizeErr = checkRomSize(file.size);
    if (sizeErr) throw new Error(`rejected ${file.name}: ${sizeErr}`);
    const d = await dir();
    const handle = await d.getFileHandle(file.name, { create: true });
    const writable = await handle.createWritable();
    try {
      if (typeof file.stream === 'function' && typeof writable.getWriter === 'function') {
        const reader = file.stream().getReader();
        const writer = writable.getWriter();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            await writer.write(value);
          }
        } finally {
          writer.releaseLock();
        }
      } else {
        await writable.write(new Uint8Array(await file.arrayBuffer()));
      }
      await writable.close();
    } catch (err) {
      if (typeof writable.abort === 'function') await writable.abort();
      throw err;
    }
    return { name: file.name, size: file.size };
  }

  async function list() {
    const d = await dir();
    const out = [];
    for await (const [name, handle] of d.entries()) {
      if (handle.kind !== 'file') continue;
      if (checkRomName(name)) continue;
      const f = await handle.getFile();
      out.push({ name, size: f.size });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  // Returns the ROM bytes as a Uint8Array, for copying into the core's
  // in-memory file system (core-bridge.js). Never leaves the page.
  async function read(name) {
    const nameErr = checkRomName(name);
    if (nameErr) throw new Error(`bad name ${name}: ${nameErr}`);
    const d = await dir();
    const handle = await d.getFileHandle(name);
    const f = await handle.getFile();
    return new Uint8Array(await f.arrayBuffer());
  }

  async function remove(name) {
    const nameErr = checkRomName(name);
    if (nameErr) throw new Error(`bad name ${name}: ${nameErr}`);
    const d = await dir();
    await d.removeEntry(name);
  }

  return { isAvailable, requestPersistence, save, list, read, remove };
}
