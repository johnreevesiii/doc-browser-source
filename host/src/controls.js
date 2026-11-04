// controls.js: the player's own key and controller bindings, kept per device.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// The panel's Controls section rebinds each player action for the keyboard
// (KeyboardEvent.code) and for a "standard" mapping gamepad (button index),
// by pressing the new key or button. The action names and the defaults are
// the DOC Online seat's (doc-arcade src/lib/controls.ts ACTIONS,
// DEFAULT_KEYMAP and DEFAULT_GP; "a" is OK and "b" is Hold, DOC's own
// naming), so a player keeps the keys they know.
//
// Safety:
// - An action maps to exactly one joypad id from ACTION_IDS, and none of
//   those is Coin, Test or Service (input-map.js PLAYER_BLOCKED). Whatever
//   is stored, the maps built here can't name a blocked id, and the input
//   state masks them out again on top.
// - The page's own keys can never be bound: M (the panel), F (fullscreen),
//   Escape (closes the panel and cancels a capture) and Tab (moves focus).
// - Storage (localStorage "doc_browser_keys_v1") is read and written only
//   inside try/catch. Anything odd in it (bad JSON, another version, an
//   unknown action, a reserved key, an action with no key, two keys on one
//   action) falls back to the defaults for that device kind.

import { JOYPAD, DEFAULT_KEYBOARD_MAP, STANDARD_GAMEPAD_MAP, PLAYER_BLOCKED } from './input-map.js';

export const STORAGE_KEY = 'doc_browser_keys_v1';
export const STORAGE_VERSION = 1;

// Display order, as in the lobby seat's Controls guide.
export const ACTIONS = Object.freeze([
  Object.freeze({ action: 'up', label: 'Up' }),
  Object.freeze({ action: 'down', label: 'Down' }),
  Object.freeze({ action: 'left', label: 'Left' }),
  Object.freeze({ action: 'right', label: 'Right' }),
  Object.freeze({ action: 'a', label: 'OK' }),
  Object.freeze({ action: 'b', label: 'Hold' }),
  Object.freeze({ action: 'whip', label: 'Whip' }),
  Object.freeze({ action: 'card', label: 'Insert card' }),
  Object.freeze({ action: 'start', label: 'Start' }),
]);

// Action to joypad id (input-map.js JOYPAD; the NAOMI meaning is in NAOMI_LABELS).
export const ACTION_IDS = Object.freeze({
  up: JOYPAD.UP, down: JOYPAD.DOWN, left: JOYPAD.LEFT, right: JOYPAD.RIGHT,
  a: JOYPAD.B, b: JOYPAD.A, whip: JOYPAD.Y, card: JOYPAD.L, start: JOYPAD.START,
});
const ID_ACTION = new Map(Object.entries(ACTION_IDS).map(([a, id]) => [id, a]));
const VALID = new Set(ACTIONS.map((a) => a.action));
const actionLabel = (action) => (ACTIONS.find((a) => a.action === action) || { label: action }).label;

// Keys the page keeps for itself.
export const RESERVED_KEYS = Object.freeze(new Set(['KeyM', 'KeyF', 'Escape', 'Tab']));
const RESERVED_WHY = Object.freeze({
  KeyM: 'M opens and closes this panel',
  KeyF: 'F is fullscreen',
  Escape: 'Escape cancels and closes the panel',
  Tab: 'Tab moves between the page buttons',
});
// Highest gamepad button index accepted (the standard layout uses 0 to 16).
export const MAX_PAD_INDEX = 31;
const CODE_RE = /^[A-Za-z][A-Za-z0-9]{0,31}$/;

// The defaults, derived from input-map.js so the two never drift apart.
export function defaultBindings() {
  const keys = {};
  for (const [code, id] of Object.entries(DEFAULT_KEYBOARD_MAP)) keys[code] = ID_ACTION.get(id);
  const pads = {};
  STANDARD_GAMEPAD_MAP.forEach((id, i) => { if (id !== null && id !== undefined) pads[i] = ID_ACTION.get(id); });
  return { keys, pads };
}

const isPlainObject = (o) => !!o && typeof o === 'object' && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype;

// A keyboard map is usable when every action has exactly one key, every key
// is a plain KeyboardEvent.code that the page does not keep, and nothing else.
function cleanKeys(o) {
  if (!isPlainObject(o)) return null;
  const out = {};
  const seen = new Set();
  for (const [code, act] of Object.entries(o)) {
    if (!CODE_RE.test(code) || RESERVED_KEYS.has(code) || typeof act !== 'string' || !VALID.has(act)) return null;
    if (seen.has(act)) return null;
    seen.add(act);
    out[code] = act;
  }
  return seen.size === VALID.size ? out : null;
}

// A controller map: every action at least once (an action may keep two
// buttons, as Whip and Hold do by default), each button at most once.
function cleanPads(o) {
  if (!isPlainObject(o)) return null;
  const out = {};
  const seen = new Set();
  for (const [idx, act] of Object.entries(o)) {
    if (!/^\d{1,2}$/.test(idx)) return null;
    const n = Number(idx);
    if (n > MAX_PAD_INDEX || typeof act !== 'string' || !VALID.has(act)) return null;
    out[n] = act;
    seen.add(act);
  }
  return seen.size === VALID.size ? out : null;
}

// Whatever was stored, a usable { keys, pads }; each kind falls back to the
// defaults on its own.
export function sanitizeBindings(j) {
  const d = defaultBindings();
  if (!isPlainObject(j) || j.v !== STORAGE_VERSION) return d;
  return { keys: cleanKeys(j.keys) || d.keys, pads: cleanPads(j.pads) || d.pads };
}

export function loadBindings(storage) {
  let parsed = null;
  try {
    const raw = storage ? storage.getItem(STORAGE_KEY) : null;
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  return sanitizeBindings(parsed);
}

// Returns true when stored. Only a clean map is ever written.
export function saveBindings(storage, b) {
  const clean = sanitizeBindings({ v: STORAGE_VERSION, keys: b && b.keys, pads: b && b.pads });
  try {
    if (!storage) return false;
    storage.setItem(STORAGE_KEY, JSON.stringify({ v: STORAGE_VERSION, keys: clean.keys, pads: clean.pads }));
    return true;
  } catch {
    return false;
  }
}

export function clearBindings(storage) {
  try { if (storage) storage.removeItem(STORAGE_KEY); return true; } catch { return false; }
}

const sameMap = (a, b) => {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => b[k] === a[k]);
};
export const isDefault = (b) => { const d = defaultBindings(); return sameMap(b.keys, d.keys) && sameMap(b.pads, d.pads); };

// The maps input-map.js reads. Only ACTION_IDS values can appear, and a
// blocked id is dropped even if one ever slipped in.
const BLOCKED = new Set(PLAYER_BLOCKED);
export function toKeyboardMap(b) {
  const out = {};
  for (const [code, act] of Object.entries(b.keys)) {
    const id = ACTION_IDS[act];
    if (id === undefined || BLOCKED.has(id) || RESERVED_KEYS.has(code)) continue;
    out[code] = id;
  }
  return Object.freeze(out);
}
export function toGamepadMap(b) {
  const out = new Array(MAX_PAD_INDEX + 1).fill(null);
  for (const [idx, act] of Object.entries(b.pads)) {
    const id = ACTION_IDS[act];
    const n = Number(idx);
    if (id === undefined || BLOCKED.has(id) || !(n >= 0 && n <= MAX_PAD_INDEX)) continue;
    out[n] = id;
  }
  return Object.freeze(out);
}

// Can this keydown become a binding? 'ok', 'reserved' (with why), or
// 'not-a-key' (no physical code, or a key a browser made up for a
// controller button, which would then arrive twice).
export function keyBindable(code, key = '') {
  if (typeof code !== 'string' || !CODE_RE.test(code) || String(key).startsWith('Gamepad')) return { ok: false, reason: 'not-a-key' };
  if (RESERVED_KEYS.has(code)) return { ok: false, reason: 'reserved', why: RESERVED_WHY[code] };
  return { ok: true };
}

// Bind a key to an action. One key per action: the action's old key is let
// go, and if the new key belonged to another action, the two swap (that
// action takes the old key), so no action is ever left without a key.
// Returns { keys, swapped: { action, code } | null, changed }.
export function bindKey(keys, code, action) {
  const next = { ...keys };
  if (!VALID.has(action) || !keyBindable(code).ok) return { keys: next, swapped: null, changed: false };
  const oldCode = Object.keys(next).find((c) => next[c] === action) || null;
  if (oldCode === code) return { keys: next, swapped: null, changed: false };
  const other = next[code] && next[code] !== action ? next[code] : null;
  if (oldCode) delete next[oldCode];
  next[code] = action;
  let swapped = null;
  if (other) {
    if (oldCode) { next[oldCode] = other; swapped = { action: other, code: oldCode }; }
    else swapped = { action: other, code: null };
  }
  return { keys: next, swapped, changed: true };
}

// Bind a controller button to an action: the action now has this one
// button. If the button belonged to another action, that action takes this
// action's old buttons (a swap), so every action keeps at least one.
// Returns { pads, swapped: { action, buttons } | null, changed }.
export function bindPad(pads, idx, action) {
  const next = {};
  for (const [k, v] of Object.entries(pads)) next[Number(k)] = v;
  if (!VALID.has(action) || !Number.isInteger(idx) || idx < 0 || idx > MAX_PAD_INDEX) return { pads: next, swapped: null, changed: false };
  const old = Object.keys(next).map(Number).filter((i) => next[i] === action);
  if (old.length === 1 && old[0] === idx) return { pads: next, swapped: null, changed: false };
  const other = next[idx] && next[idx] !== action ? next[idx] : null;
  for (const i of old) delete next[i];
  next[idx] = action;
  let swapped = null;
  if (other) {
    const otherLeft = Object.keys(next).map(Number).filter((i) => next[i] === other);
    if (otherLeft.length === 0) {
      const give = old.filter((i) => i !== idx);
      for (const i of give) next[i] = other;
      swapped = { action: other, buttons: give };
    } else {
      swapped = { action: other, buttons: otherLeft, kept: true };
    }
  }
  return { pads: next, swapped, changed: true };
}

export const keyForAction = (keys, action) => Object.keys(keys).find((c) => keys[c] === action) || null;
export const padsForAction = (pads, action) => Object.keys(pads).map(Number).filter((i) => pads[i] === action).sort((x, y) => x - y);

// Plain names for the panel.
const KEY_NAMES = {
  ArrowUp: 'Up arrow', ArrowDown: 'Down arrow', ArrowLeft: 'Left arrow', ArrowRight: 'Right arrow',
  Space: 'Space', Enter: 'Enter', NumpadEnter: 'Keypad Enter', Backspace: 'Backspace',
  ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl',
  AltLeft: 'Left Alt', AltRight: 'Right Alt', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  Backslash: '\\', BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backquote: '`',
};
export function keyName(code) {
  if (!code) return 'none';
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  m = /^Digit(\d)$/.exec(code);
  if (m) return m[1];
  m = /^Numpad(.+)$/.exec(code);
  if (m) return `Keypad ${m[1]}`;
  return code;
}
const PAD_NAMES = ['A (bottom)', 'B (right)', 'X (left)', 'Y (top)', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start (menu)',
  'Left stick press', 'Right stick press', 'D-pad up', 'D-pad down', 'D-pad left', 'D-pad right', 'Home'];
export const padName = (i) => PAD_NAMES[i] || `Button ${i}`;

// The messages the panel shows. Plain words, no numbers or rules.
export function describeKeyBind(action, code, swapped) {
  const base = `${actionLabel(action)} is now ${keyName(code)}.`;
  if (!swapped) return base;
  return swapped.code ? `${base} ${actionLabel(swapped.action)} moved to ${keyName(swapped.code)} (the two swapped).` : `${base} ${actionLabel(swapped.action)} has no key now.`;
}
export function describePadBind(action, idx, swapped) {
  const base = `${actionLabel(action)} is now ${padName(idx)}.`;
  if (!swapped) return base;
  const names = swapped.buttons.map(padName).join(' and ');
  if (swapped.kept) return `${base} ${actionLabel(swapped.action)} keeps ${names}.`;
  return `${base} ${actionLabel(swapped.action)} moved to ${names} (the two swapped).`;
}

// One poll of a pad while waiting for a button: the first button down now
// that was up in the last poll (so a button already held when the capture
// began never counts). prev is the last poll's pressed flags, or null.
export function newlyPressed(prev, buttons) {
  if (!buttons) return -1;
  for (let i = 0; i < buttons.length && i <= MAX_PAD_INDEX; i++) {
    const b = buttons[i];
    const down = !!(b && (b.pressed || b.value > 0.5));
    if (down && !(prev && prev[i])) return i;
  }
  return -1;
}
export const pressedFlags = (buttons) => (buttons ? Array.from(buttons, (b) => !!(b && (b.pressed || b.value > 0.5))) : []);

// After a controller binding the input stays held until the bound button
// is up (the press must not reach the game), but never longer than the
// capture time, so a stuck or noisy other button can't freeze input.
export function releaseDone(pad, idx, now, until) {
  if (now >= until || !pad || !pad.buttons) return true;
  const b = pad.buttons[idx];
  return !(b && (b.pressed || b.value > 0.5));
}

// The first connected "standard" pad, the one that drives the player's port.
export function firstStandardPad(pads) {
  if (!pads) return null;
  for (const p of pads) if (p && p.connected && p.mapping === 'standard') return p;
  return null;
}
