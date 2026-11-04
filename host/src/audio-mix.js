// audio-mix.js: the player's sound mix (race audio and seat sounds), kept
// per device in localStorage. GPL-2.0-or-later.
//
// As in a DOC Online seat's mixer: the race (announcer, crowd and music from
// the race screen boards) and the seat's own sounds each have a level from 0
// to 100 percent. Storage can be missing or throw (private windows, blocked
// site data); the mix then starts at the defaults and is simply not kept.

export const MIX_KEY = 'doc_browser_mix_v1';
export const DEFAULT_MIX = Object.freeze({ race: 0.8, seat: 1 });

export function clampLevel(v, fallback) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

// The saved mix, or the defaults for anything missing or unreadable.
export function loadMix(storage) {
  let saved = null;
  try {
    const raw = storage ? storage.getItem(MIX_KEY) : null;
    saved = raw ? JSON.parse(raw) : null;
  } catch {
    saved = null;
  }
  if (!saved || typeof saved !== 'object') return { ...DEFAULT_MIX };
  return { race: clampLevel(saved.race, DEFAULT_MIX.race), seat: clampLevel(saved.seat, DEFAULT_MIX.seat) };
}

// Returns true when the mix was stored.
export function saveMix(storage, mix) {
  const clean = { race: clampLevel(mix && mix.race, DEFAULT_MIX.race), seat: clampLevel(mix && mix.seat, DEFAULT_MIX.seat) };
  try {
    if (!storage) return false;
    storage.setItem(MIX_KEY, JSON.stringify(clean));
    return true;
  } catch {
    return false;
  }
}

// A level as the slider shows it: whole percent.
export const toPercent = (v) => Math.round(clampLevel(v, 0) * 100);
