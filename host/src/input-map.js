// input-map.js: keyboard and gamepad to libretro joypad state.
// GPL-2.0-or-later.
//
// Button ids are libretro's RETRO_DEVICE_ID_JOYPAD_*. The NAOMI meaning of
// each id comes from nao_joymap in Flycast shell/libretro/libretro.cpp at
// 8412d3d8a (SELECT is Coin, L3 is Test, R3 is Service, B/A/Y/X/R/L/R2/L2
// are Buttons 1 to 8).

export const RETRO_DEVICE_NONE = 0;
export const RETRO_DEVICE_JOYPAD = 1;
export const RETRO_DEVICE_ID_JOYPAD_MASK = 256;

export const JOYPAD = Object.freeze({
  B: 0, Y: 1, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7,
  A: 8, X: 9, L: 10, R: 11, L2: 12, R2: 13, L3: 14, R3: 15,
});

export const NAOMI_LABELS = Object.freeze({
  [JOYPAD.B]: 'Button 1', [JOYPAD.A]: 'Button 2', [JOYPAD.Y]: 'Button 3',
  [JOYPAD.X]: 'Button 4', [JOYPAD.R]: 'Button 5', [JOYPAD.L]: 'Button 6',
  [JOYPAD.R2]: 'Button 7', [JOYPAD.L2]: 'Button 8',
  [JOYPAD.SELECT]: 'Coin', [JOYPAD.START]: 'Start',
  [JOYPAD.L3]: 'Test', [JOYPAD.R3]: 'Service',
  [JOYPAD.UP]: 'Up', [JOYPAD.DOWN]: 'Down', [JOYPAD.LEFT]: 'Left', [JOYPAD.RIGHT]: 'Right',
});

// Player keyboard, by KeyboardEvent.code (layout independent). The DOC Online seat's published defaults
// (doc-arcade src/lib/controls.ts DEFAULT_KEYMAP and the lobby Controls guide), so players keep the keys they
// know: Z OK (Button 1), X Hold (Button 2), C whip (Button 3), I insert card (Button 6), Enter start, arrows.
// A player never gets Coin, Test or Service (Test and Service open the operator menus; free play needs no
// coin) or the buttons DOC does not use (4, 5, 7, 8). M and F stay the page's panel and fullscreen keys.
export const DEFAULT_KEYBOARD_MAP = Object.freeze({
  ArrowUp: JOYPAD.UP, ArrowDown: JOYPAD.DOWN,
  ArrowLeft: JOYPAD.LEFT, ArrowRight: JOYPAD.RIGHT,
  KeyZ: JOYPAD.B, KeyX: JOYPAD.A, KeyC: JOYPAD.Y,
  KeyI: JOYPAD.L, Enter: JOYPAD.START,
});

// W3C "standard" Gamepad layout button index to joypad id, or null for a button the player never gets.
// The DOC Online seat's defaults (controls.ts DEFAULT_GP): bottom face whip, left face OK, right face Hold,
// top face insert card, start, both triggers (6 whip, 7 Hold), D-pad. Select (Coin), the stick clicks
// (Test, Service), the shoulders and the home button are unmapped.
export const STANDARD_GAMEPAD_MAP = Object.freeze([
  JOYPAD.Y, JOYPAD.A, JOYPAD.B, JOYPAD.L,
  null, null, JOYPAD.Y, JOYPAD.A,
  null, JOYPAD.START, null, null,
  JOYPAD.UP, JOYPAD.DOWN, JOYPAD.LEFT, JOYPAD.RIGHT,
]);

// Ids a player's input may never set, whatever map is passed in.
export const PLAYER_BLOCKED = Object.freeze([JOYPAD.SELECT, JOYPAD.L3, JOYPAD.R3]);
const BLOCKED_MASK = PLAYER_BLOCKED.reduce((m, id) => m | (1 << id), 0);

export const MAX_PORTS = 4;

// createInputState({ keyboardMap, gamepadMap, keyboardPort })
// setMaps({ keyboardMap, gamepadMap }) swaps in the player's own bindings
// (controls.js); suspend(true) holds every input at nothing (the panel is
// waiting for a key or button to bind), suspend(false) lets it through again.
export function createInputState(options = {}) {
  let keyboardMap = options.keyboardMap || DEFAULT_KEYBOARD_MAP;
  let gamepadMap = options.gamepadMap || STANDARD_GAMEPAD_MAP;
  const keyboardPort = options.keyboardPort ?? 0;
  const keyMasks = new Uint16Array(MAX_PORTS);
  const padMasks = new Uint16Array(MAX_PORTS);
  let suspended = false;

  // Returns true when the key is mapped, so the caller can preventDefault.
  function onKey(code, down) {
    if (suspended) return false;
    if (!Object.prototype.hasOwnProperty.call(keyboardMap, code)) return false;
    const id = keyboardMap[code];
    if (!Number.isInteger(id) || id < 0 || id > 15 || (BLOCKED_MASK >> id) & 1) return false;
    const bit = 1 << id;
    if (down) keyMasks[keyboardPort] |= bit;
    else keyMasks[keyboardPort] &= ~bit;
    return true;
  }

  // Call once per frame with navigator.getGamepads(). The connected
  // "standard" mapping pads drive ports 0, 1, ... in the browser's order, so
  // the first one is always port 0 (the player's) even when the browser lists
  // it at index 1 or later (an empty slot, or a non-standard device first).
  // Other pads are not read.
  function pollGamepads(pads) {
    padMasks.fill(0);
    if (!pads || suspended) return;
    let port = 0;
    for (let i = 0; i < pads.length && port < MAX_PORTS; i++) {
      const pad = pads[i];
      if (!pad || !pad.connected || pad.mapping !== 'standard') continue;
      let mask = 0;
      for (let b = 0; b < gamepadMap.length && b < pad.buttons.length; b++) {
        const id = gamepadMap[b];
        if (!Number.isInteger(id) || id < 0 || id > 15) continue;
        const btn = pad.buttons[b];
        if (btn && (btn.pressed || btn.value > 0.5)) mask |= 1 << id;
      }
      padMasks[port++] = mask & ~BLOCKED_MASK;
    }
  }

  function mask(port) {
    if (suspended || port < 0 || port >= MAX_PORTS) return 0;
    return (keyMasks[port] | padMasks[port]) & ~BLOCKED_MASK;
  }

  // Mirrors retro_input_state_t(port, device, index, id).
  function inputState(port, device, index, id) {
    if (device !== RETRO_DEVICE_JOYPAD || index !== 0) return 0;
    const m = mask(port);
    if (id === RETRO_DEVICE_ID_JOYPAD_MASK) return m;
    if (id < 0 || id > 15) return 0;
    return (m >> id) & 1;
  }

  function releaseAll() {
    keyMasks.fill(0);
    padMasks.fill(0);
  }

  function setMaps(maps = {}) {
    if (maps.keyboardMap) keyboardMap = maps.keyboardMap;
    if (maps.gamepadMap) gamepadMap = maps.gamepadMap;
    releaseAll();
  }

  function suspend(on) {
    suspended = !!on;
    releaseAll();
  }

  return { onKey, pollGamepads, mask, inputState, releaseAll, setMaps, suspend, suspended: () => suspended };
}

// Wires DOM key events to an input state. Returns an unbind function.
// Keys are released when the page loses focus, so nothing sticks down.
// Typing in a text field (the feedback box) never reaches the game, and the field keeps its keys.
function isTyping(e) {
  const t = e.target;
  if (!t || typeof t !== 'object') return false;
  if (t.isContentEditable) return true;
  const tag = typeof t.tagName === 'string' ? t.tagName.toUpperCase() : '';
  // Enter or Space on a focused page button or link presses that button, not the game's Start.
  if ((tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY') && (e.code === 'Enter' || e.code === 'Space' || e.code === 'NumpadEnter')) return true;
  // The arrow keys on a focused slider (the sound mix) move the slider, not the horse.
  if (tag === 'INPUT' && String(t.type || '').toLowerCase() === 'range' && /^Arrow(Up|Down|Left|Right)$/.test(String(e.code))) return true;
  return tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && !['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'range', 'color'].includes(String(t.type || '').toLowerCase()));
}

export function bindKeyboard(target, state) {
  const down = (e) => { if (isTyping(e)) return; if (state.onKey(e.code, true)) e.preventDefault(); };
  const up = (e) => { if (state.onKey(e.code, false)) e.preventDefault(); };
  const blur = () => state.releaseAll();
  target.addEventListener('keydown', down);
  target.addEventListener('keyup', up);
  target.addEventListener('blur', blur);
  return () => {
    target.removeEventListener('keydown', down);
    target.removeEventListener('keyup', up);
    target.removeEventListener('blur', blur);
  };
}
