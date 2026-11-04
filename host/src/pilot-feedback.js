// pilot-feedback.js: the "Send feedback" control of a stable game (the
// browser game pilot, doc-ops D-068).
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Sends the tester's note and a few session facts to the stable's
// same-origin feedback route, with the member's sign-in token (the same
// token provider the card source uses, stable-auth.js). The facts are only
// these: the browser's user agent string, the game speed (now, and the
// lowest and average of the last half minute), how many boards loaded, the
// link state, the last error message the page showed, the page version,
// and a short sound summary (how far behind each sound group plays, its
// gaps and skips, and the browser's own audio delay). Never card bytes,
// game file hashes, sound or picture contents, storage contents or anything
// about the device beyond the user agent. Nothing is stored on the device.

export const FEEDBACK_API = '/api/browser-pilot/feedback';
export const NOTE_MAX = 1000;
export const REQUEST_TIMEOUT_MS = 15000;

export const FEEDBACK_MESSAGES = Object.freeze({
  empty: 'Write a short note first.',
  sending: 'Sending.',
  sent: 'Thanks. Your note was sent.',
  signin: 'Your sign-in has ended. Sign in again on your stable, then send it.',
  error: 'Could not send just now. Try again in a minute.',
});

const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The page version the server put in <meta name="doc-page-version">, or null. */
export function pageVersionFrom(doc = globalThis.document) {
  const m = doc && doc.querySelector ? doc.querySelector('meta[name="doc-page-version"]') : null;
  const v = m && typeof m.content === 'string' ? m.content : '';
  return /^[A-Za-z0-9._+-]{1,64}$/.test(v) ? v : null;
}

const SOUND_RATE = 44100;
const ms1 = (frames) => Math.round((frames / SOUND_RATE) * 10000) / 10;

/** Recent game speed: { fps_min, fps_avg } of the fps readings given (the last half minute), or nulls. */
export function speedFacts(fpsRecent) {
  const v = Array.isArray(fpsRecent) ? fpsRecent.filter((x) => num(x) !== null) : [];
  if (!v.length) return { fps_min: null, fps_avg: null };
  const avg = v.reduce((a, b) => a + b, 0) / v.length;
  return { fps_min: Math.round(Math.min(...v) * 10) / 10, fps_avg: Math.round(avg * 10) / 10 };
}

/**
 * A short sound summary from the cabinet's audio output (audio-output.js):
 * sound = { state, stats: audio.stats(), latency: audio.latency() } or
 * null. Per group (race, seat): the average buffered sound over the
 * worklet's last report in ms (the most of the group's sources), its gaps
 * (underruns) and the ms skipped after a long stall; and the browser's own
 * delay to the speakers.
 */
export function soundFacts(sound) {
  const out = {
    audio_state: null, race_ms: null, seat_ms: null, race_underruns: null, seat_underruns: null,
    race_skip_ms: null, seat_skip_ms: null, audio_base_ms: null, audio_out_ms: null,
  };
  if (!sound || typeof sound !== 'object') return out;
  if (sound.state === 'running' || sound.state === 'suspended' || sound.state === 'closed') out.audio_state = sound.state;
  const lat = sound.latency || {};
  if (num(lat.base) !== null) out.audio_base_ms = Math.round(lat.base * 10000) / 10;
  if (num(lat.output) !== null) out.audio_out_ms = Math.round(lat.output * 10000) / 10;
  for (const src of Object.values(sound.stats || {})) {
    if (!src || (src.group !== 'race' && src.group !== 'seat')) continue;
    const g = src.group;
    const level = num(src.avg) !== null && src.avg > 0 ? src.avg : num(src.buffered);
    if (level !== null) out[`${g}_ms`] = Math.max(out[`${g}_ms`] ?? 0, ms1(level));
    if (num(src.underruns) !== null) out[`${g}_underruns`] = Math.max(out[`${g}_underruns`] ?? 0, src.underruns);
    if (num(src.skipped) !== null) out[`${g}_skip_ms`] = Math.max(out[`${g}_skip_ms`] ?? 0, Math.round(ms1(src.skipped)));
  }
  return out;
}

/**
 * The facts sent with a note. stats is the cabinet's last onStats report
 * ({ fps, loaded, boards, linked }) or null; fpsRecent the fps readings of
 * the last half minute; sound as for soundFacts.
 */
export function collectFacts({ userAgent = null, stats = null, lastError = null, pageVersion = null, mode = null, edition = null, fpsRecent = null, sound = null } = {}) {
  return {
    ua: clip(userAgent, 300),
    fps: stats ? (num(stats.fps) === null ? null : Math.round(stats.fps * 10) / 10) : null,
    boards_loaded: stats ? num(stats.loaded) : null,
    boards: stats ? num(stats.boards) : null,
    link: stats ? (stats.linked ? 'on' : 'waiting') : null,
    error: clip(lastError, 300),
    page_version: pageVersion,
    mode: mode === 'cabinet' || mode === 'single' ? mode : null,
    edition: edition === 'A' || edition === 'B' ? edition : null,
    ...speedFacts(fpsRecent),
    ...soundFacts(sound),
  };
}

/**
 * sendFeedback({ note, facts, getAuthToken, fetchImpl }) resolves to
 * { ok, message }. It never throws.
 */
export async function sendFeedback({
  note, facts, getAuthToken,
  fetchImpl = globalThis.fetch ? globalThis.fetch.bind(globalThis) : null,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  const text = typeof note === 'string' ? note.trim().slice(0, NOTE_MAX) : '';
  if (!text) return { ok: false, message: FEEDBACK_MESSAGES.empty };
  if (typeof fetchImpl !== 'function' || typeof getAuthToken !== 'function') return { ok: false, message: FEEDBACK_MESSAGES.error };
  let tok = null;
  try { tok = await getAuthToken(); } catch { tok = null; }
  if (!tok) return { ok: false, message: FEEDBACK_MESSAGES.signin };
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : 0;
  try {
    const res = await fetchImpl(FEEDBACK_API, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ note: text, facts }),
      signal: ctl ? ctl.signal : undefined,
    });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (res.ok && body && body.ok === true) return { ok: true, message: FEEDBACK_MESSAGES.sent };
    // The service answers a rejected sign-in token with the same bare 404 (no
    // code) it gives anyone not allowed. This page only shows for an allowed
    // member and the feedback route still lets a removed pilot through, so
    // here a bare 404 means the sign-in was not accepted. (401: older builds.)
    if (res.status === 401 || (res.status === 404 && !(body && body.code))) return { ok: false, message: FEEDBACK_MESSAGES.signin };
    // The server's own plain wording for a refusal it explains (empty note, too many notes); anything else is generic.
    if ((res.status === 400 || res.status === 429) && body && typeof body.error === 'string' && body.error.length <= 120) {
      return { ok: false, message: body.error };
    }
    return { ok: false, message: FEEDBACK_MESSAGES.error };
  } catch {
    return { ok: false, message: FEEDBACK_MESSAGES.error };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
