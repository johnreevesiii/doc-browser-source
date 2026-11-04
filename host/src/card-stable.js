// card-stable.js: the StableCardSource, a CardSource (card-store.js) backed
// by the community stable's browser card service (doc-arcade
// /api/browser-cards/*, doc-ops D-065).
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Flow for one game session (the service's contract, browserCardService.ts):
//   1. The stable page opens a session and writes ONE hand-off entry under
//      sessionStorage "doc.browserSession". takeHandoff() reads it and
//      removes it in the same step; the token is kept in memory only.
//   2. startLease()                heartbeats begin at once, so the lease
//                                  holds through the ROM check and the wait
//                                  for Start.
//   3. insert()   POST /checkout   the 207 head bytes, straight into the
//                                  emulator. Edition and horse must match
//                                  the hand-off, or the session is closed.
//   4. heartbeat  POST /heartbeat  every heartbeat_s until eject.
//   5. write(b)   POST /checkin    every card write the game makes, in
//                                  order: { base_version, seq, card_b64 }.
//   6. eject()    POST /close      drains the writes, releases the lock.
//                                  { reason: 'finish' }: the check-out
//                                  finish. abandon() (page hide) sends
//                                  { reason: 'abandon' }.
//   reinsert()     POST /checkout  "Restart cabinet": the head is read again
//                                  in the same session, only with no write
//                                  in flight and no race owed (see below).
//   raceEntered()  POST /race      the player's horse entered a race
//                                  (cabinet-game.js reports it). Queued
//                                  behind the writes already made, so a
//                                  write from before the race never
//                                  counts as its result.
//
// Fairness (doc-arcade D-068, browser_cards_v2_fairness.sql): a session
// that ends without a finish after the card was inserted, or with a race
// entered and no card write after it (a tab close, Restart, Play again),
// is recorded as abandoned and the race as no result. After the day's free
// pass the horse rests a few minutes: /checkout then answers 'resting' and
// insert() throws a LeaseLostError carrying the service's plain message.
// A second /checkout while a race is owed ends the session on the server.
// A race report that can't be delivered (network errors past the lease,
// a blocked request, any refusal) ENDS the session here: saving stops, the
// player is told, and the server sees the lease run out (an abandon). So
// blocking /race is never a way to leave a race without a result. Transient
// errors are retried first, as for every request. raceOpen() tells the page
// whether leaving now would leave a race unfinished.
//
// Restart (the panel's "Restart cabinet", for a hung game): reinsert() reads
// the head again with a second /checkout in this session, exactly as
// insert() does at the start, so the game gets the card the stable holds now.
// It is refused here (RestartRefusedError, nothing sent) while a race is owed
// or its report is still on the way, and while any write is queued or in
// flight. The service holds the same rule on its side: a second /checkout
// while a race is owed ends the session as an abandon ('restart') with the
// race recorded as no result, so even a page that skipped this check could
// never hand the game the pre-race card again. The page refuses rather than
// letting that happen, so a restart never costs the player a session by
// surprise; leaving mid-race stays the Finish button's warned path.
//
// Card bytes are held in memory only: never put in any browser storage and
// never offered as a file (test/policy.test.mjs lists the APIs this module
// may not use). The only network calls are same-origin POSTs to
// /api/browser-cards/*.
//
// Retry and sequence numbers (matching the service, not changing it):
// - Each write gets the next seq once; a retry of the same write reuses its
//   seq and base, so a retry of a write the server already accepted is a
//   no-op there (same bytes, base = head or head - 1).
// - Network errors, request timeouts and 502/503/504 are retried with
//   backoff for as long as the lease could still be alive (lease_s since the
//   last successful answer). After that the lease is treated as lost. A 429
//   (the card routes' rate limit) waits for its retry_after, within the
//   same bound.
// - "stale_seq" (an earlier attempt of this write reached the server) is
//   resolved with one /checkout: if the head is our write, it was accepted;
//   otherwise the server judged it and did not keep it. A failed resync ends
//   the session.
// - "base_mismatch" ends the session: the server's head is not the one our
//   copy came from, so the source never rebases onto it. The next Play
//   reloads the signed head.
// - Writes run one at a time in the order the game made them.
// - A held write ("review") or too many rejected writes end the session on
//   the server; the source then stops sending and reports it.
// - An expired sign-in token: the service answers it with the same bare 404
//   (no code) it gives anyone not allowed (older builds: a 401). The source
//   fetches a fresh token and retries once; a 404 that persists ends the
//   session like any other refusal.
// - Signed out (no Clerk token, or a 401 that a fresh token does not fix):
//   the session stops, nothing is sent that could only fail (no /close),
//   the player is told to sign in, and the lease runs out on its own.
// - Connection trouble (no answer, or 502/503/504): the page is told at once
//   ("connection" event) and heartbeats retry every RECONNECT_MS instead of
//   every heartbeat_s. The first successful answer clears it ("reconnected")
//   and play carries on. If no answer comes for a whole lease, the session
//   ends with the connection named as the cause (MESSAGES.lostConnection).

export const STABLE_API = '/api/browser-cards';
export const HANDOFF_KEY = 'doc.browserSession';
export const DEFAULT_RETURN_PATH = '/stable/browser';
export const CARD_BYTES = 207;
export const EDITIONS = Object.freeze(['A', 'B']);
export const REQUEST_TIMEOUT_MS = 15000;
// Heartbeat retry while the connection is down (the normal beat is heartbeat_s).
export const RECONNECT_MS = 5000;
// Browser offline/online events closer together than this beat only once.
export const NUDGE_GAP_MS = 1500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[A-Za-z0-9_-]{40,64}$/;
const B64_207_RE = /^[A-Za-z0-9+/]{276}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

// Session error codes from the service that mean this session can no longer
// write (SESSION_ERRORS in browserCardService.ts).
const LOST_CODES = new Set(['no_session', 'closed', 'expired', 'lock_lost', 'not_active', 'no_horse', 'resting']);
const RETRY_STATUS = new Set([502, 503, 504]);

// Plain wording for the player. Never a rule, a limit or a number.
export const MESSAGES = Object.freeze({
  ready: 'Your horse is in the reader. Saves go to your stable.',
  saving: 'Saving to your stable.',
  saved: 'Saved to your stable.',
  retrying: 'Saving is taking longer than usual. Still trying.',
  rejected: 'This save could not be accepted. Your horse keeps its last saved state.',
  held: 'This save is held for a quick review. Your horse keeps its last saved state. Return to your stable to play again.',
  lost: 'This game session has ended, so your horse is no longer saving. Return to your stable and press Play in browser again.',
  connection: 'Connection lost, trying to reconnect.',
  reconnected: 'Connected again. Saves go to your stable.',
  lostConnection: 'The connection to your stable was lost for too long, so this game session has ended and your horse is no longer saving. Your stable keeps the last card it saved. Return to your stable and press Play in browser again.',
  raceUnreported: 'The stable could not be told about this race, so this game session has ended and your horse is no longer saving. Return to your stable.',
  signin: 'You are signed out, so your horse is not saving. Sign in on your stable page. Your horse is free to play again in a few minutes.',
  closed: 'Your horse is back in your stable.',
  error: 'Something went wrong while saving. Return to your stable and try again.',
  resting: 'This horse is resting after an unfinished game. Try again in a few minutes.',
  otherSite: "This horse can't be loaded here. It may have been made on the test site. Pick another horse.",
});

/** The service's resting wording with its wait (D-068), whole minutes. */
export function restingMessage(retryAfterS) {
  const s = Number(retryAfterS);
  if (!(s > 0)) return MESSAGES.resting;
  const m = Math.max(1, Math.ceil(s / 60));
  return `This horse is resting after an unfinished game. Try again in ${m} ${m === 1 ? 'minute' : 'minutes'}.`;
}

export class LeaseLostError extends Error {
  constructor(reason, message) {
    super(message || (reason === 'signin' ? MESSAGES.signin : reason === 'resting' ? MESSAGES.resting
      : reason === 'network' ? MESSAGES.lostConnection : MESSAGES.lost));
    this.name = 'LeaseLostError';
    this.reason = reason;
  }
}

// /checkout answered chain_broken: the stable holds this horse's card but
// could not verify it with this site's keys (browserCardService.ts openHead),
// as for a horse made on the staging site. Not a session problem; another
// horse may load.
export class CardUnavailableError extends Error {
  constructor(code = 'chain_broken') {
    super(MESSAGES.otherSite);
    this.name = 'CardUnavailableError';
    this.code = code;
  }
}

// reinsert() was refused before anything was sent: reason 'race' (a race is
// owed or being reported), 'saving' (a write is queued or in flight),
// 'not_ready' (no card in the reader, or the session ended), 'limit' (the
// service allows no more re-reads in this session).
export class RestartRefusedError extends Error {
  constructor(reason) {
    super(`restart refused: ${reason}`);
    this.name = 'RestartRefusedError';
    this.reason = reason;
  }
}

export class EditionMismatchError extends Error {
  constructor(want, got) {
    super(`This horse is Edition ${got}, and this game is Edition ${want}. Editions never mix.`);
    this.name = 'EditionMismatchError';
    this.want = want;
    this.got = got;
  }
}

/** A same-origin path only (the same rule as doc-arcade's safeGamePath). */
export function safeReturnPath(v) {
  return typeof v === 'string' && /^\/(?!\/)[A-Za-z0-9/_-]{0,80}$/.test(v) ? v : null;
}

/**
 * Read the stable's hand-off and remove it at once (doc-arcade
 * lib/browserHandoff takeBrowserHandoff, same rules). null when absent,
 * malformed or older than its lease. The token stays in memory only.
 * rom_sha256: the flag's expected game-file hashes at the moment Play was
 * pressed (rom-setup.js checks the device's files against them).
 */
export function takeHandoff({ storage = globalThis.sessionStorage, now = Date.now() } = {}) {
  let raw = null;
  try { raw = storage ? storage.getItem(HANDOFF_KEY) : null; } catch { return null; }
  try { if (storage) storage.removeItem(HANDOFF_KEY); } catch { /* storage off */ }
  if (!raw) return null;
  let h;
  try { h = JSON.parse(raw); } catch { return null; }
  if (!h || typeof h !== 'object') return null;
  if (typeof h.session_id !== 'string' || !UUID_RE.test(h.session_id)) return null;
  if (typeof h.token !== 'string' || !TOKEN_RE.test(h.token)) return null;
  if (typeof h.horse_id !== 'string' || !UUID_RE.test(h.horse_id)) return null;
  if (!EDITIONS.includes(h.edition)) return null;
  if (typeof h.issued_at !== 'number' || !(h.lease_s > 0) || !(h.heartbeat_s > 0)) return null;
  if (now - h.issued_at > h.lease_s * 1000) return null;
  const name = typeof h.horse_name === 'string' ? h.horse_name.slice(0, 40) : '';
  const rom = Array.isArray(h.rom_sha256) ? h.rom_sha256.filter((x) => typeof x === 'string' && HEX64_RE.test(x)).slice(0, 32) : [];
  return {
    session_id: h.session_id, token: h.token, horse_id: h.horse_id, edition: h.edition,
    horse_name: name, heartbeat_s: Number(h.heartbeat_s), lease_s: Number(h.lease_s), issued_at: h.issued_at,
    return_path: safeReturnPath(h.return_path) || DEFAULT_RETURN_PATH, rom_sha256: rom,
  };
}

export function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function same(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * createStableCardSource({ handoff, getAuthToken, ... })
 *   handoff        from takeHandoff()
 *   getAuthToken   () => Promise<string|null>, the signed-in member's Clerk
 *                  session token (the routes need it as well as the session)
 *   expectEdition  the edition this game build runs ('A' or 'B'); a horse of
 *                  the other edition is refused before any byte is used
 *   onEvent        ({ type, message, detail }) for the page's status line
 *   fetchImpl, setTimer, clearTimer, now, sleep, retry, timeoutMs,
 *   makeSignal: injectable for tests
 */
export function createStableCardSource({
  handoff, getAuthToken, expectEdition,
  onEvent = () => {},
  fetchImpl = globalThis.fetch ? globalThis.fetch.bind(globalThis) : null,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  retry = { baseMs: 500, maxMs: 8000 },
  timeoutMs = REQUEST_TIMEOUT_MS,
  makeSignal = (ms) => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined),
  apiBase = STABLE_API,
} = {}) {
  if (!handoff) throw new Error('no hand-off from the stable');
  if (typeof getAuthToken !== 'function') throw new Error('getAuthToken is required');
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available');
  if (!EDITIONS.includes(expectEdition)) throw new Error('expectEdition must be A or B');

  const leaseMs = handoff.lease_s * 1000;
  const sessionHeader = `${handoff.session_id}.${handoff.token}`;
  let state = 'new'; // new, ready, lost, ejected
  let lostReason = null;
  let leaseOn = false;    // heartbeat running (from startLease or insert)
  let base = 0;           // head version our copy is based on
  let nextSeq = 1;        // next write's seq
  let head = null;        // the last head we know the server holds (memory only)
  let lastContact = now();
  let hbTimer = null;
  let queue = Promise.resolve();
  let pending = 0;
  let lastToken = null;
  let inflight = null;    // { card, seq, base } of the write being sent
  let newest = null;      // newest write handed in and not yet settled
  let lostMessage = null;  // the service's own wording for a resting horse
  let raceOpen = false;   // a race entry was reported and no write followed
  let raceReports = 0;    // race reports queued or on the way
  let connTrouble = false; // the last request got no answer or a 502/503/504
  let byConnection = false; // the session ended because the connection was gone
  let lastNudge = -Infinity;
  const stats = { sent: 0, accepted: 0, rejected: 0, retries: 0, resyncs: 0, heartbeats: 0, races: 0 };

  const emit = (type, detail) => {
    const own = (type === 'resting' || (type === 'lost' && lostReason === 'race_unreported')) && lostMessage;
    const message = own ? lostMessage : (type === 'lost' && byConnection) ? MESSAGES.lostConnection : (MESSAGES[type] || '');
    try { onEvent({ type, message, detail }); } catch { /* UI only */ }
  };

  async function token() {
    let tok = null;
    try { tok = await getAuthToken(); } catch { tok = null; }
    if (tok) lastToken = tok;
    return tok;
  }

  function headersFor(tok) {
    const h = { 'content-type': 'application/json', 'x-browser-session': sessionHeader };
    if (tok) h.authorization = `Bearer ${tok}`;
    return h;
  }

  // One POST. { status, body }, { network: true } (no answer, or none within
  // timeoutMs), or { signedOut: true } (no token, so nothing was sent).
  async function post(path, body) {
    const tok = await token();
    if (!tok) return { signedOut: true };
    let res;
    try {
      res = await fetchImpl(`${apiBase}${path}`, {
        method: 'POST', headers: headersFor(tok), body: JSON.stringify(body || {}),
        cache: 'no-store', credentials: 'same-origin', signal: makeSignal(timeoutMs),
      });
    } catch {
      trouble();
      return { network: true };
    }
    let json = {};
    try { json = await res.json(); } catch { json = {}; }
    // Only a successful answer counts as contact: an error says nothing
    // about whether the lease was renewed.
    if (res.status >= 200 && res.status < 300) { lastContact = now(); recovered(); }
    else if (RETRY_STATUS.has(res.status)) trouble();
    return { status: res.status, body: json && typeof json === 'object' ? json : {} };
  }

  // Connection trouble starts and ends here, told to the page once each way.
  function trouble() {
    if (connTrouble || !live()) return;
    connTrouble = true;
    emit('connection', {});
    // Found by a check-in or other request while the next beat is still on
    // the normal timer: bring it forward to the reconnect rate. (A failing
    // beat schedules its own retry.)
    if (hbTimer !== null) scheduleHeartbeat();
  }
  function recovered() {
    if (!connTrouble) return;
    connTrouble = false;
    if (live()) emit('reconnected', {});
  }

  const isLost = (r) => !r.network && !r.signedOut && (r.status === 404 || r.status === 403 || r.status === 410
    || LOST_CODES.has(String(r.body.code || '')));
  const authFail = (r) => !r.network && !r.signedOut && r.status === 401 && !r.body.code;
  // Worth one retry with a fresh token: a 401, or the service's bare 404
  // (no code), which is also its answer to an expired token.
  const tokenRetry = (r) => authFail(r) || (!r.network && !r.signedOut && r.status === 404 && !r.body.code);

  // POST with retry while the lease could still be alive. A bare 401 or 404
  // (tokenRetry) may be an expired sign-in token: fetch a new one, retry once.
  async function request(path, body, { maxAttempts = Infinity } = {}) {
    let attempt = 0;
    let authRetried = false;
    for (;;) {
      if (state === 'lost') return { lost: true };
      const r = await post(path, body);
      attempt++;
      if (r.signedOut) return r;
      if (tokenRetry(r) && !authRetried) { authRetried = true; continue; }
      const limited = !r.network && r.status === 429 && r.body.code === 'too_fast';
      const retryable = r.network || RETRY_STATUS.has(r.status) || limited;
      if (!retryable) return r;
      if (attempt >= maxAttempts) return r;
      if (now() - lastContact >= leaseMs) { markLost('network'); return { lost: true }; }
      stats.retries++;
      // While the connection is down the page already shows that; "taking
      // longer than usual" is for a slow or busy answer.
      if (!connTrouble) emit('retrying', { path, attempt });
      const backoff = Math.min(retry.maxMs, retry.baseMs * 2 ** Math.min(attempt - 1, 10));
      const wait = limited ? Math.min(leaseMs / 2, Math.max(backoff, Number(r.body.retry_after_s) * 1000 || 0)) : backoff;
      await sleep(wait);
    }
  }

  function stopHeartbeat() {
    if (hbTimer !== null) { clearTimer(hbTimer); hbTimer = null; }
  }

  function markLost(reason, message) {
    if (state === 'lost' || state === 'ejected') return;
    // The connection was the cause: no answer for a whole lease, or the
    // service saying the session ran out right after a gap.
    byConnection = reason === 'network' || (connTrouble && ['expired', 'lock_lost', '410', '409'].includes(String(reason)));
    state = 'lost';
    lostReason = reason;
    if (message) lostMessage = message;
    leaseOn = false;
    stopHeartbeat();
    if (head) head.fill(0);
    head = null;
    emit(reason === 'held' ? 'held' : reason === 'signin' ? 'signin' : reason === 'resting' ? 'resting' : 'lost', { reason });
  }

  // A refusal that ends the session: a resting horse keeps the service's
  // wording and its wait.
  function lose(r) {
    const code = String((r.body && r.body.code) || r.status);
    if (code === 'resting') markLost('resting', restingMessage(r.body.retry_after_s));
    else markLost(code);
  }
  const lostError = () => new LeaseLostError(lostReason, lostReason === 'resting' ? lostMessage : undefined);

  const signedOut = () => markLost('signin');
  const live = () => state === 'ready' || state === 'new';

  function scheduleHeartbeat() {
    stopHeartbeat();
    if (!leaseOn || !live()) return;
    const ms = handoff.heartbeat_s * 1000;
    hbTimer = setTimer(beat, connTrouble ? Math.min(RECONNECT_MS, ms) : ms);
  }

  async function beat() {
    hbTimer = null;
    if (!leaseOn || !live()) return;
    let r = await post('/heartbeat', {});
    stats.heartbeats++;
    if (tokenRetry(r)) r = await post('/heartbeat', {}); // a fresh token, one retry
    if (!leaseOn || !live()) return;
    if (r.signedOut || authFail(r)) { signedOut(); return; }
    if (isLost(r)) { markLost(String(r.body.code || r.status)); return; }
    const ok = !r.network && r.status >= 200 && r.status < 300 && r.body.ok !== false;
    // No renewal for a whole lease (network down, timeouts, server errors):
    // the server has let the lease go, so stop.
    if (!ok && now() - lastContact >= leaseMs) { markLost('network'); return; }
    scheduleHeartbeat();
  }

  // Read the head again after stale_seq. Returns the head bytes, or null
  // after ending the session: on any failure the source can't know where
  // the server stands, so it stops rather than guess.
  async function resync() {
    stats.resyncs++;
    const r = await request('/checkout', {}, { maxAttempts: 4 });
    if (r.lost) return null;
    if (r.signedOut || authFail(r)) { signedOut(); return null; }
    const b64 = r.body ? String(r.body.card_b64 || '') : '';
    if (r.network || !r.body.ok || !B64_207_RE.test(b64)) {
      emit('error', { resync: true, status: r.status });
      if (isLost(r)) lose(r); else markLost('resync');
      return null;
    }
    base = Number(r.body.head_version);
    nextSeq = Math.max(nextSeq, Number(r.body.last_seq) + 1);
    head = b64ToBytes(b64);
    return head;
  }

  async function sendWrite(card) {
    if (state !== 'ready') throw new LeaseLostError(lostReason || state);
    if (head && same(card, head)) return { verdict: 'accept', version: base, noop: true };
    const seq = nextSeq++;
    inflight = { card, seq, base };
    emit('saving', { seq });
    try {
      stats.sent++;
      const r = await request('/checkin', { base_version: base, seq, card_b64: bytesToB64(card) });
      if (r.lost) throw new LeaseLostError(lostReason);
      if (r.signedOut || authFail(r)) { signedOut(); throw new LeaseLostError('signin'); }
      if (!r.network && r.status === 200 && r.body.ok) {
        const v = r.body.verdict;
        raceOpen = false; // any judged write after an entry is its result
        if (v === 'accept') {
          base = Number(r.body.version);
          head = new Uint8Array(card);
          stats.accepted++;
          emit('saved', { version: base, noop: !!r.body.noop });
          return { verdict: 'accept', version: base, noop: !!r.body.noop };
        }
        if (v === 'review') { markLost('held'); return { verdict: 'review' }; }
        stats.rejected++;
        emit('rejected', { closed: !!r.body.closed });
        if (r.body.closed) markLost('rejects');
        return { verdict: 'reject', closed: !!r.body.closed };
      }
      const code = String(r.body.code || '');
      if (isLost(r) || code === 'base_mismatch') {
        // base_mismatch: the head moved under this session. Never rebase.
        markLost(code || String(r.status));
        throw new LeaseLostError(lostReason);
      }
      if (code === 'stale_seq') {
        const h = await resync();
        if (!h) throw new LeaseLostError(lostReason || 'resync');
        if (same(h, card)) {
          stats.accepted++;
          emit('saved', { version: base, resynced: true });
          return { verdict: 'accept', version: base, resynced: true };
        }
        stats.rejected++;
        emit('rejected', { resynced: true });
        return { verdict: 'reject', resynced: true };
      }
      emit('error', { status: r.status, code });
      const err = new Error(MESSAGES.error);
      err.status = r.status;
      err.code = code;
      throw err;
    } finally {
      inflight = null;
    }
  }

  // Fail closed: anything but a recorded entry ends the session (see the
  // header). Transient errors are retried inside request() for as long as
  // the lease could be alive.
  function raceUnreported(detail) {
    emit('error', { race: true, ...detail });
    lostMessage = MESSAGES.raceUnreported;
    markLost('race_unreported');
    return { ok: false, reason: 'race_unreported' };
  }

  async function sendRaceEntry() {
    if (state !== 'ready') return { ok: false, reason: lostReason || state };
    if (raceOpen) return { ok: true, already: true };
    const r = await request('/race', {});
    if (r.lost) return { ok: false, reason: lostReason };
    if (r.signedOut || authFail(r)) { signedOut(); return { ok: false, reason: 'signin' }; }
    if (!r.network && r.status === 200 && r.body.ok) {
      raceOpen = true;
      stats.races++;
      return { ok: true, already: !!r.body.already };
    }
    if (isLost(r)) { lose(r); return { ok: false, reason: lostReason }; }
    return raceUnreported({ status: r.network ? 0 : r.status, code: r.network ? 'network' : String(r.body.code || '') });
  }

  return {
    kind: 'stable',
    horse: { id: handoff.horse_id, name: handoff.horse_name, edition: handoff.edition },
    returnPath: handoff.return_path,
    state: () => state,
    lostReason: () => lostReason,
    pending: () => pending,
    // A lost session owes nothing more: leaving it is never a warning.
    raceOpen: () => raceOpen && state !== 'lost',
    connectionTrouble: () => connTrouble,
    // The browser says the network went away or came back: heartbeat now
    // rather than at the next beat, so the warning (or its end) shows at once.
    nudge() {
      if (!leaseOn || !live() || hbTimer === null) return Promise.resolve();
      if (now() - lastNudge < NUDGE_GAP_MS) return Promise.resolve();
      lastNudge = now();
      stopHeartbeat();
      return beat();
    },
    stats: () => ({ ...stats, base, nextSeq }),

    // Keep the session's lease alive from the moment the hand-off is taken
    // (ROM check, waiting for Start), before any card byte is fetched.
    startLease() {
      if (leaseOn || state !== 'new') return;
      leaseOn = true;
      scheduleHeartbeat();
    },

    async insert() {
      if (state !== 'new') throw new Error(state === 'lost' ? MESSAGES.lost : 'the card is already in the reader');
      if (handoff.edition !== expectEdition) {
        await this.eject();
        throw new EditionMismatchError(expectEdition, handoff.edition);
      }
      const r = await request('/checkout', {}, { maxAttempts: 6 });
      // The checkout await can be long (retries). A heartbeat may have
      // marked the session lost meanwhile, or the page may have abandoned
      // it: never flip it back to 'ready' and never hand bytes to the game.
      if (r.lost || state !== 'new') throw new LeaseLostError(lostReason || state);
      if (r.signedOut || authFail(r)) { signedOut(); throw new LeaseLostError('signin'); }
      if (r.network || !r.body.ok) {
        if (isLost(r)) { lose(r); throw lostError(); }
        if (!r.network && r.body.code === 'chain_broken') throw new CardUnavailableError();
        const err = new Error(String(r.body.error || MESSAGES.error));
        err.status = r.status;
        throw err;
      }
      if (r.body.edition !== handoff.edition || r.body.edition !== expectEdition || r.body.horse_id !== handoff.horse_id) {
        state = 'ready';
        await this.eject();
        throw new EditionMismatchError(expectEdition, String(r.body.edition));
      }
      const b64 = String(r.body.card_b64 || '');
      if (!B64_207_RE.test(b64)) throw new Error('the stable sent something that is not a card');
      base = Number(r.body.head_version);
      nextSeq = Number(r.body.last_seq) + 1;
      head = b64ToBytes(b64);
      state = 'ready';
      leaseOn = true;
      scheduleHeartbeat();
      emit('ready', { version: base });
      return new Uint8Array(head);
    },

    // The player's horse entered a race (cabinet-game.js raceEntrySignal).
    // Sent after every write already made, never instead of one. Never
    // throws; a report that can't be delivered ends the session (header).
    raceEntered() {
      if (state !== 'ready') return Promise.resolve({ ok: false, reason: lostReason || state });
      raceReports++;
      const p = queue.then(() => sendRaceEntry()).catch((err) => (state === 'ready' ? raceUnreported({ thrown: String(err && err.message) }) : { ok: false, reason: lostReason || state }))
        .finally(() => { raceReports--; });
      queue = p.then(() => {}, () => {});
      return p;
    },

    // Why a restart can't happen now ('race', 'saving', 'not_ready'), or null.
    restartBlocker() {
      if (state !== 'ready') return 'not_ready';
      if (raceOpen || raceReports > 0) return 'race';
      if (pending > 0 || inflight) return 'saving';
      return null;
    },

    // Read the head again for a restarted game (the panel's Restart
    // cabinet). The caller has already stopped the old game. Waits for the
    // queue, then refuses (RestartRefusedError, nothing sent) if a race is
    // owed or a write is waiting; otherwise one /checkout, checked exactly
    // as insert() checks it. A refusal from the service (the session ended,
    // a resting horse, the race rule above) ends the session here too.
    async reinsert() {
      if (state !== 'ready') throw new RestartRefusedError('not_ready');
      await queue;
      const why = this.restartBlocker();
      if (why) throw new RestartRefusedError(why);
      const r = await request('/checkout', {}, { maxAttempts: 6 });
      if (r.lost || state !== 'ready') throw new LeaseLostError(lostReason || state);
      if (r.signedOut || authFail(r)) { signedOut(); throw new LeaseLostError('signin'); }
      if (r.network || !r.body.ok) {
        if (isLost(r)) { lose(r); throw lostError(); }
        if (!r.network && r.body.code === 'checkout_limit') throw new RestartRefusedError('limit');
        if (!r.network && r.body.code === 'chain_broken') throw new CardUnavailableError();
        const err = new Error(String(r.body.error || MESSAGES.error));
        err.status = r.status;
        throw err;
      }
      if (r.body.edition !== handoff.edition || r.body.edition !== expectEdition || r.body.horse_id !== handoff.horse_id) {
        await this.eject();
        throw new EditionMismatchError(expectEdition, String(r.body.edition));
      }
      const b64 = String(r.body.card_b64 || '');
      if (!B64_207_RE.test(b64)) throw new Error('the stable sent something that is not a card');
      if (head) head.fill(0);
      base = Number(r.body.head_version);
      nextSeq = Math.max(nextSeq, Number(r.body.last_seq) + 1);
      head = b64ToBytes(b64);
      stats.restarts = (stats.restarts || 0) + 1;
      emit('ready', { version: base, restarted: true });
      return new Uint8Array(head);
    },

    // Called by the host on every card write by the game. Writes are sent
    // one at a time in the order they were made.
    write(bytes) {
      if (!(bytes instanceof Uint8Array) || bytes.length !== CARD_BYTES) {
        return Promise.reject(new Error(`a card write is ${CARD_BYTES} bytes`));
      }
      if (state === 'lost' || state === 'ejected') {
        emit(state === 'lost' ? (lostReason === 'signin' ? 'signin' : 'lost') : 'closed', { dropped: true });
        return Promise.reject(new LeaseLostError(lostReason || state));
      }
      const copy = new Uint8Array(bytes);
      const entry = { card: copy };
      newest = entry;
      pending++;
      const p = queue.then(() => sendWrite(copy)).finally(() => {
        pending--;
        if (newest === entry) newest = null;
        copy.fill(0);
      });
      queue = p.catch(() => {});
      return p;
    },

    async eject() {
      if (state === 'ejected') return;
      await queue;
      const wasLive = live();
      leaseOn = false;
      stopHeartbeat();
      if (wasLive) {
        // The check-out finish. With a race still owed the service records
        // it as no result all the same.
        const r = await request('/close', { reason: 'finish' }, { maxAttempts: 3 });
        // Signed out: no /close was sent; the lease runs out on its own.
        if (r.signedOut) emit('signin', {});
      }
      state = 'ejected';
      if (head) head.fill(0);
      head = null;
      emit('closed', {});
    },

    // Best effort on page hide; nothing here can be awaited, and none of it
    // may arrive. With no write outstanding, release the lock with a
    // keepalive /close. With a write in flight or queued, send only the
    // newest one with keepalive (the in-flight one keeps its own seq and
    // base, so a retry of an accepted write is a no-op) and skip /close,
    // because two keepalive requests can arrive in either order; the lease
    // then runs out on its own. Signed out: nothing is sent. Whatever does
    // not arrive, the last accepted write stands.
    abandon() {
      if (!live()) return;
      const wasReady = state === 'ready';
      leaseOn = false;
      stopHeartbeat();
      state = 'ejected';
      const send = (path, body) => {
        try {
          fetchImpl(`${apiBase}${path}`, {
            method: 'POST', headers: headersFor(lastToken), body: JSON.stringify(body), keepalive: true, credentials: 'same-origin',
          }).catch(() => {});
        } catch { /* page is going away */ }
      };
      if (lastToken) {
        if (wasReady && newest && !(inflight && newest.card === inflight.card)) {
          send('/checkin', { base_version: base, seq: nextSeq++, card_b64: bytesToB64(newest.card) });
        } else if (wasReady && inflight) {
          send('/checkin', { base_version: inflight.base, seq: inflight.seq, card_b64: bytesToB64(inflight.card) });
        } else {
          send('/close', { reason: 'abandon' });
        }
      }
      if (head) head.fill(0);
      head = null;
    },
  };
}
