// page-start.js: page start-up order for main.js.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// The ROM list and the "Ready" status must not wait on
// navigator.storage.persist(): headless Firefox never settles that promise,
// which used to leave the page at "Starting...". Persistence is requested in
// the background and only refines the status text if nothing else has
// written to it since.

export const READY = 'Ready.';

// startPage({ store, mountPicker, status: { get, set }, persistTimeoutMs })
// Returns null when OPFS is missing, else { picker, persistence } where
// persistence is a promise for the persist() answer (true, false or null).
export async function startPage({ store, mountPicker, status, persistTimeoutMs = 3000 }) {
  if (!(await store.isAvailable())) {
    status.set('This browser has no Origin Private File System, so ROMs cannot be stored.');
    return null;
  }
  const picker = mountPicker();
  await picker.refresh();
  status.set(READY);
  const persistence = store.requestPersistence({ timeoutMs: persistTimeoutMs }).then((persisted) => {
    if (status.get() === READY) {
      status.set(persisted ? 'Ready. Storage is persistent.' : 'Ready. Storage may be cleared by the browser.');
    }
    return persisted;
  });
  return { picker, persistence };
}

// The pilot build of this page (doc-arcade /pilot) marks itself with
// <meta name="doc-build" content="pilot">, added by the route that serves it.
export function isPilotBuild(doc = globalThis.document) {
  const m = doc && doc.querySelector ? doc.querySelector('meta[name="doc-build"]') : null;
  return !!m && m.content === 'pilot';
}

// Which page to show. A hand-off from the stable means a stable game
// ('stable'). Without one, the lab ROM and card pickers ('lab') are a
// dev-only switch for this page served on the machine's loopback address;
// the pilot build never offers them, even on loopback. Everything else
// ('none') only sends the player back to the stable and starts nothing.
export function pageMode({ handoff, pilot, loopback }) {
  if (handoff) return 'stable';
  if (!pilot && loopback) return 'lab';
  return 'none';
}
