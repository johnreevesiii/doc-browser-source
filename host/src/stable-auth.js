// stable-auth.js: the signed-in member's session token for the stable's
// browser card routes (they need it as well as the game session).
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// The game page is served on the stable's own origin (the browser_cards
// flag's game_path), where the member is already signed in with Clerk. The
// page gets a token the same way the stable's lobby does
// (doc-arcade lib/clerkClient): a Clerk object already on the page, or
// clerk-js v5 loaded from the same CDN with the publishable key the
// deployment puts in <meta name="doc-clerk-publishable-key">. Only used
// when a hand-off from the stable is present; the dev page never loads it.
// No key is in this file.
//
// The script is pinned to one exact version with a Subresource Integrity
// hash and crossorigin=anonymous (the CDN sends CORS and
// Cross-Origin-Resource-Policy: cross-origin, which COEP require-corp
// needs). Limits, stated plainly: clerk-js later loads its own UI chunks
// from the same CDN by version-pinned file names, which SRI does not cover;
// and the live Clerk under COOP/COEP has NOT been verified (an open pilot
// condition). To move to a new version, update both constants together and
// recompute the hash from the exact file:
//   curl -s <url> | openssl dgst -sha384 -binary | openssl base64 -A

export const CLERK_JS_VERSION = '5.128.1';
export const CLERK_JS_URL = 'https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5.128.1/dist/clerk.browser.js';
export const CLERK_JS_INTEGRITY = 'sha384-GpRJv2HyaO/k/gGXDuz7JGje1Fi8IlJziMrg39G2mi5Bw6Foi6mBC3iIxYVDsLmA';
const PK_RE = /^pk_(live|test)_[A-Za-z0-9+/=_-]{10,200}$/;

function waitForClerk(win, doc, pk, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    setTimeout(() => finish(null), timeoutMs);
    if (win.Clerk) { finish(win.Clerk); return; }
    if (!pk) { finish(null); return; }
    const s = doc.createElement('script');
    s.src = CLERK_JS_URL;
    s.integrity = CLERK_JS_INTEGRITY;
    s.crossOrigin = 'anonymous';
    s.async = true;
    s.setAttribute('data-clerk-publishable-key', pk);
    s.onload = () => finish(win.Clerk || null);
    s.onerror = () => finish(null);
    doc.head.appendChild(s);
  });
}

/** Returns () => Promise<string|null>. */
export async function createTokenProvider({ win = globalThis.window, doc = globalThis.document, timeoutMs = 15000 } = {}) {
  const meta = doc && doc.querySelector ? doc.querySelector('meta[name="doc-clerk-publishable-key"]') : null;
  const pk = meta && PK_RE.test(meta.content || '') ? meta.content : null;
  const clerk = await waitForClerk(win, doc, pk, timeoutMs);
  if (!clerk) return async () => null;
  try { if (typeof clerk.load === 'function' && !clerk.loaded) await clerk.load(); } catch { return async () => null; }
  return async () => {
    try { return clerk.session ? await clerk.session.getToken() : null; } catch { return null; }
  };
}
