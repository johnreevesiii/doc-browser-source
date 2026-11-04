// main.js: page wiring for the thin host skeleton. GPL-2.0-or-later.

import { createRomStore } from './rom-store.js';
import { mountRomPicker } from './rom-picker.js';
import { createInputState, bindKeyboard } from './input-map.js';
import { fitRect } from './video.js';
import { createCoreOptions, loadCoreFactory, jitDetMode, FS_PATHS } from './core-bridge.js';
import { startCore, isBiosName } from './libretro-host.js';
import { startPage, pageMode, isPilotBuild } from './page-start.js';
import { createCardStore, createLocalLabCardSource, checkCardName, checkCardSize } from './card-store.js';
import { takeHandoff, createStableCardSource, MESSAGES as STABLE_MESSAGES, EditionMismatchError, CardUnavailableError, DEFAULT_RETURN_PATH } from './card-stable.js';
import { loadMix, saveMix, toPercent } from './audio-mix.js';
import { verifySetup, editionProblem, SETUP_MESSAGES, BUILDABLE_EDITIONS } from './rom-setup.js';
import { createTokenProvider } from './stable-auth.js';
import { startStableCabinet, openCabinetAudio, BOARD_LABELS, PLAYER_BOARD } from './cabinet-game.js';
import { collectFacts, sendFeedback, pageVersionFrom, FEEDBACK_MESSAGES } from './pilot-feedback.js';
import {
  ACTIONS, loadBindings, saveBindings, clearBindings, defaultBindings, isDefault, toKeyboardMap, toGamepadMap,
  keyBindable, bindKey, bindPad, keyForAction, padsForAction, keyName, padName, describeKeyBind, describePadBind,
  newlyPressed, pressedFlags, firstStandardPad, releaseDone,
} from './controls.js';
import { restartBlocker, restartCabinet, RESTART_MESSAGES } from './cabinet-restart.js';
import { RestartRefusedError } from './card-stable.js';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const say = (msg) => { statusEl.textContent = msg; };

// Card source selection. A hand-off from the stable (sessionStorage, read
// and removed once) means a stable game: the horse's card comes from the
// stable service and nothing else is offered. Without one, the lab card
// picker (LocalLabCardSource, OPFS) is a dev-only switch: it shows only when
// the page is served on this machine's loopback address, and never in the
// pilot build (/pilot), which marks itself with a doc-build meta. On any
// other page without a hand-off (a reload of /pilot above all) the page
// only sends the player to the stable and starts nothing.
const handoff = takeHandoff();
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(location.hostname);
const mode = pageMode({ handoff, pilot: isPilotBuild(document), loopback: LOOPBACK });
if (mode === 'lab') $('lab-card-section').hidden = false;
if (mode !== 'lab') $('rom-section').hidden = true;

const canvas = $('screen');
const input = createInputState();

// The player's own bindings (controls.js), kept per device. Storage can be
// missing or throw; the defaults then apply and nothing is kept.
let keyStore = null;
try { keyStore = window.localStorage; } catch { keyStore = null; }
let bindings = loadBindings(keyStore);
const applyBindings = () => input.setMaps({ keyboardMap: toKeyboardMap(bindings), gamepadMap: toGamepadMap(bindings) });
applyBindings();
const cardKey = () => keyName(keyForAction(bindings.keys, 'card'));

// Waiting for a key or button to bind (the Controls section). Registered
// before the game's key listener and in the capture phase, so while it
// listens no key reaches the game, the panel keys (M, F, Escape) or a
// focused page button. The input state is suspended as well, which also
// holds the controller at nothing.
// release: { idx, until } after a controller binding, else null.
const capture = { kind: null, action: null, prev: null, timer: 0, release: null, swallow: new Set(), onEnd: null };
const CAPTURE_MS = 10000;
function endCapture(msg, boundIdx = -1) {
  clearTimeout(capture.timer);
  capture.kind = null; capture.action = null; capture.prev = null;
  // The controller button just bound would reach the game at the next poll:
  // the input stays held until that button is up (at most CAPTURE_MS).
  if (boundIdx >= 0) capture.release = { idx: boundIdx, until: performance.now() + CAPTURE_MS };
  else input.suspend(false);
  if (capture.onEnd) capture.onEnd(msg);
}
addEventListener('keydown', (e) => {
  if (!capture.kind) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  capture.swallow.add(e.code);
  if (e.repeat) return;
  if (e.code === 'Escape') { endCapture('Cancelled. Nothing changed.'); return; }
  if (capture.kind !== 'key') return; // waiting for a controller button
  const k = keyBindable(e.code, e.key);
  if (!k.ok) {
    if (capture.onEnd) capture.onEnd(k.reason === 'reserved'
      ? `${keyName(e.code)} can't be used: ${k.why}. Press another key, or Escape to cancel.`
      : "That key can't be used. Press another key, or Escape to cancel.", true);
    return;
  }
  const action = capture.action;
  const r = bindKey(bindings.keys, e.code, action);
  if (r.changed) { bindings = { ...bindings, keys: r.keys }; saveBindings(keyStore, bindings); applyBindings(); }
  endCapture(r.changed ? describeKeyBind(action, e.code, r.swapped) : `${keyName(e.code)} is already ${ACTIONS.find((a) => a.action === action).label}.`);
}, true);
addEventListener('keyup', (e) => {
  if (!capture.kind && !capture.swallow.has(e.code)) return;
  capture.swallow.delete(e.code);
  e.preventDefault();
  e.stopImmediatePropagation();
}, true);
addEventListener('blur', () => { if (capture.kind) endCapture('Cancelled. Nothing changed.'); });

// One frame of the controller capture (from frame()).
function pollCapture(pads) {
  const pad = firstStandardPad(pads);
  if (capture.release) {
    if (releaseDone(pad, capture.release.idx, performance.now(), capture.release.until)) { capture.release = null; input.suspend(false); }
    return;
  }
  if (capture.kind !== 'pad' || !pad) return;
  // The first look only notes what is already held: a held button never counts.
  if (capture.prev === null) { capture.prev = pressedFlags(pad.buttons); return; }
  const i = newlyPressed(capture.prev, pad.buttons);
  capture.prev = pressedFlags(pad.buttons);
  if (i < 0) return;
  const action = capture.action;
  const r = bindPad(bindings.pads, i, action);
  if (r.changed) { bindings = { ...bindings, pads: r.pads }; saveBindings(keyStore, bindings); applyBindings(); }
  endCapture(r.changed ? describePadBind(action, i, r.swapped) : `${padName(i)} is already ${ACTIONS.find((a) => a.action === action).label}.`, i);
}

bindKeyboard(window, input);

function resize() {
  const box = canvas.parentElement.getBoundingClientRect();
  const r = fitRect(4 / 3, box.width, box.height);
  canvas.style.width = `${r.w}px`;
  canvas.style.height = `${r.h}px`;
  // The backing store stays at the core's internal resolution (640x480,
  // reicast_internal_resolution): Flycast draws into the default
  // framebuffer at that size, and CSS scales it.
}
window.addEventListener('resize', resize);
resize();

$('isolation').textContent = window.crossOriginIsolated
  ? 'Cross-origin isolated: yes (shared memory available).'
  : 'Cross-origin isolated: no. Serve with COOP/COEP headers for audio sharing and multiboard.';

const store = createRomStore();
const cards = createCardStore();
const cardSelect = $('card-select');
const cardStatus = (msg) => { $('card-status').textContent = msg; };

async function refreshCards(selected) {
  let list = [];
  try { list = await cards.list(); } catch (err) { cardStatus(String(err && err.message ? err.message : err)); }
  cardSelect.replaceChildren(new Option('(no card)', ''));
  for (const c of list) cardSelect.append(new Option(c.name, c.name));
  if (selected !== undefined) cardSelect.value = selected;
}

$('card-input').addEventListener('change', async (ev) => {
  const f = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  const why = checkCardName(f.name) || checkCardSize(f.size);
  if (why) { cardStatus(`Skipped ${f.name}: ${why}.`); return; }
  try {
    await cards.save(f);
    await refreshCards(f.name);
    cardStatus(`Stored ${f.name} in this browser.`);
  } catch (err) {
    cardStatus(String(err && err.message ? err.message : err));
  }
});
if (mode === 'lab') refreshCards().catch(() => {});

let host = null;

// Boots the picked game. Every file stored in this browser is copied into
// the core's in-memory FS (BIOS archives into <system>/dc/), so a NAOMI
// game finds naomi.zip. Nothing leaves the browser.
async function boot(name) {
  try {
    if (host) { say('Already running. Reload the page to boot again.'); return; }
    const factory = await loadCoreFactory();
    if (!factory) {
      say(`Core not built yet. ${name} stays in browser storage; nothing was sent anywhere.`);
      return;
    }
    const stored = await store.list();
    let game = name;
    if (isBiosName(game)) {
      const other = stored.find((r) => !isBiosName(r.name));
      if (!other) { say('Pick a game file as well as the BIOS.'); return; }
      game = other.name;
    }
    const files = [];
    for (const r of stored) files.push([r.name, await store.read(r.name)]);
    // The lab card picked for this boot (optional, dev only). The game's
    // writes go back into the same OPFS file, so the next boot continues
    // with them. Other card sources plug in through the same interface.
    const cardName = cardSelect.value;
    let cardSource;
    if (cardName) {
      const local = createLocalLabCardSource({ store: cards, name: cardName });
      cardSource = {
        ...local,
        write: (bytes) => local.write(bytes)
          .then(() => cardStatus(`Card written by the game; saved ${cardName} in this browser.`))
          .catch((err) => cardStatus(`Card save failed: ${err && err.message ? err.message : err}`)),
      };
    }
    say(`Starting ${game} with ${files.length} file(s)${cardName ? ` and card ${cardName}` : ''}...`);
    host = await startCore({
      factory, canvas, files, game,
      options: createCoreOptions(),
      input,
      preserve: new URLSearchParams(location.search).get('preserve') === '1',
      dynarec: new URLSearchParams(location.search).get('dynarec') === '0' ? false : undefined,
      // probe=1 (tools/determinism-run.mjs): lockstep frames driven by the
      // probe, optional pinned clock (pintime=<unix seconds>).
      probe: new URLSearchParams(location.search).get('probe') === '1'
        ? {
          pinTime: new URLSearchParams(location.search).has('pintime') ? Number(new URLSearchParams(location.search).get('pintime')) : undefined,
          jitDet: jitDetMode(new URLSearchParams(location.search).get('jitdet'), 0),
        }
        : undefined,
      // Deterministic JIT is the default (D-062 item 6, linked play);
      // jitdet=0 turns it off for diagnostics. perf=1 records frame timings
      // for tools/perf-run.mjs.
      jitDet: jitDetMode(new URLSearchParams(location.search).get('jitdet'), 1),
      perf: new URLSearchParams(location.search).get('perf') === '1',
      log: (t) => console.log(`[core] ${t}`),
      cardSource,
    });
    window.__docHost = host;
    say(host.ok ? `Running ${game}.` : `The core refused ${game} (code ${host.loaded}). See the console log.`);
  } catch (err) {
    say(`Boot failed: ${err && err.message ? err.message : err}`);
    console.error(err);
  }
}

if (mode === 'lab') startPage({
  store,
  mountPicker: () => mountRomPicker({
    input: $('rom-input'),
    listEl: $('rom-list'),
    statusEl,
    store,
    onSelect: boot,
  }),
  status: { get: () => statusEl.textContent, set: say },
}).catch((err) => say(`Start failed: ${err && err.message ? err.message : err}`));

// ---------------------------------------------------------------------------
// Stable game (hand-off present): show the horse and edition, refuse an
// edition this device or build can't run, start on a click (audio needs a
// user gesture), save every card write to the stable, return on finish.
// ---------------------------------------------------------------------------

const sp = {
  panel: $('stable-panel'), horse: $('stable-horse'), edition: $('stable-edition'), status: $('stable-status'),
  start: $('stable-start'), finish: $('stable-finish'), back: $('stable-back'),
};
let toastTimer = 0;
// For the feedback note (pilot-feedback.js): the cabinet's last stats
// report and the last error message this page showed.
let lastStats = null;
let lastError = null;
// The last half minute of fps readings and the cabinet's sound output, for
// the note's speed and sound summary.
const fpsRecent = [];
let cabSound = null;
const noteError = (msg) => { if (msg) lastError = String(msg).slice(0, 300); };
addEventListener('error', (e) => noteError(e && e.message));
addEventListener('unhandledrejection', (e) => noteError(e && e.reason && e.reason.message ? e.reason.message : String(e && e.reason)));
const stableSay = (msg) => {
  sp.status.textContent = msg;
  // Cabinet mode: the panel is usually closed, so the message also shows
  // for a few seconds over the bottom left of the screen.
  if (!document.body.classList.contains('cab-mode')) return;
  $('cab-toast').textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('cab-toast').textContent = ''; }, 8000);
};
// The way back. In cabinet mode the panel opens so the link is in view.
const showBack = () => {
  sp.back.hidden = false;
  if (document.body.classList.contains('cab-mode')) setCabPanel(true);
};

function setCabPanel(open) {
  // Closing the panel takes focus out of it (the feedback box above all),
  // so the game keys reach the game again.
  if (!open && sp.panel.contains(document.activeElement)) document.activeElement.blur();
  document.body.classList.toggle('cab-panel-open', open);
  $('cab-menu').classList.toggle('on', open);
  $('cab-menu').setAttribute('aria-expanded', String(open));
}

// The lobby seat layout: race screen on top, the seat below, a button rail
// on the right with the panel (horse, status, keys, other seats) beside it.
function enterCabinetLayout(audio) {
  document.body.classList.add('cab-mode');
  $('cab-info').hidden = false;
  const sound = $('cab-sound');
  if (!audio) { sound.disabled = true; sound.classList.remove('on'); sound.title = 'No sound in this browser'; }
  mountMixer(audio);
  let muted = false;
  sound.addEventListener('click', () => {
    if (!audio) return;
    muted = !muted;
    // Suspending the context stops both the race audio and the seat sounds;
    // it only stops playback, the game never reads it.
    (muted ? audio.context.suspend() : audio.context.resume()).catch(() => {});
    sound.classList.toggle('on', !muted);
    sound.title = muted ? 'Sound is off: tap to turn it on' : 'Sound is on: tap to mute';
    sound.setAttribute('aria-label', muted ? 'Turn sound on' : 'Mute sound');
  });
  const toggleFull = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
  };
  $('cab-full').addEventListener('click', toggleFull);
  $('cab-menu').addEventListener('click', () => setCabPanel(!document.body.classList.contains('cab-panel-open')));
  $('cab-leave').addEventListener('click', () => {
    if (sp.finish.disabled) return; // Finish is already saving and leaving
    if (!sp.finish.hidden) sp.finish.click();
    else location.assign(sp.back.href);
  });
  addEventListener('keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.code === 'KeyM') setCabPanel(!document.body.classList.contains('cab-panel-open'));
    else if (e.code === 'KeyF') toggleFull();
    else if (e.code === 'Escape' && document.body.classList.contains('cab-panel-open')) setCabPanel(false);
  });
  // A button keeps focus after a click; the game keys must still reach the
  // page, and Space or Enter must not press the button again.
  for (const b of document.querySelectorAll('.cab-railbtn')) b.addEventListener('click', () => b.blur());
}

// The sound mix in the panel: race audio and seat sounds, each 0 to 100
// percent, kept on this device (audio-mix.js). Hidden without audio.
function mountMixer(audio) {
  if (!audio || typeof audio.setLevel !== 'function') return;
  let storage = null;
  try { storage = window.localStorage; } catch { storage = null; }
  const mix = loadMix(storage);
  $('cab-mix').hidden = false;
  for (const group of ['race', 'seat']) {
    const slider = $(`mix-${group}`);
    const shown = $(`mix-${group}-val`);
    const apply = () => {
      shown.textContent = `${toPercent(mix[group])}%`;
      audio.setLevel(group, mix[group]);
    };
    slider.value = String(toPercent(mix[group]));
    apply();
    slider.addEventListener('input', () => { mix[group] = Number(slider.value) / 100; apply(); });
    slider.addEventListener('change', () => saveMix(storage, mix));
  }
}

// The Controls section of the panel: every player action with its key and
// controller button(s); press one, then the new key or button (controls.js).
function mountControls() {
  const box = $('cab-controls'), rows = $('ctl-rows'), status = $('ctl-status');
  box.hidden = false;
  const buttons = [];
  const render = () => {
    for (const { el, kind, action, label } of buttons) {
      const name = kind === 'key' ? keyName(keyForAction(bindings.keys, action))
        : (padsForAction(bindings.pads, action).map(padName).join(', ') || 'none');
      const listening = capture.kind === kind && capture.action === action;
      el.textContent = listening ? (kind === 'key' ? 'Press a key...' : 'Press a button...') : name;
      el.classList.toggle('listening', listening);
      el.setAttribute('aria-pressed', String(listening));
      el.setAttribute('aria-label', `${label} ${kind === 'key' ? 'key' : 'controller button'}: ${name}. Press to change.`);
    }
    $('ctl-reset').disabled = isDefault(bindings);
  };
  capture.onEnd = (msg) => { if (msg) status.textContent = msg; render(); };
  for (const { action, label } of ACTIONS) {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = label;
    tr.append(th);
    for (const kind of ['key', 'pad']) {
      const td = document.createElement('td');
      const el = document.createElement('button');
      el.type = 'button';
      el.dataset.kind = kind;
      el.dataset.action = action;
      el.addEventListener('click', () => {
        // Pressing the listening button again cancels.
        if (capture.kind === kind && capture.action === action) { endCapture('Cancelled. Nothing changed.'); return; }
        if (capture.kind) endCapture('');
        if (kind === 'pad' && !firstStandardPad(navigator.getGamepads ? navigator.getGamepads() : null)) {
          status.textContent = 'No controller found. Connect one and press any of its buttons, then try again.';
          return;
        }
        input.suspend(true);
        capture.release = null;
        capture.kind = kind; capture.action = action; capture.prev = null;
        capture.timer = setTimeout(() => { if (capture.kind) endCapture('No key or button was pressed. Nothing changed.'); }, CAPTURE_MS);
        status.textContent = kind === 'key'
          ? `Press the key for ${label}. Escape cancels.`
          : `Press the controller button for ${label}. Escape or this button again cancels.`;
        render();
      });
      buttons.push({ el, kind, action, label });
      td.append(el);
      tr.append(td);
    }
    rows.append(tr);
  }
  $('ctl-reset').addEventListener('click', () => {
    if (capture.kind) endCapture('');
    bindings = defaultBindings();
    clearBindings(keyStore);
    applyBindings();
    status.textContent = 'Back to the DOC Online defaults.';
    render();
  });
  render();
}

// A stable game runs on the five-board linked cabinet (cabinet-game.js):
// a race needs the master, so one board alone sits at NO LINK. ?board=single
// keeps the single-board page for diagnostics.
const CABINET = new URLSearchParams(location.search).get('board') !== 'single';
let cab = null;

// The connection notice over the game ('' hides it).
function setConnBanner(msg) {
  const b = $('conn-banner');
  b.textContent = msg || '';
  b.hidden = !msg;
}

// The session can no longer save: stop the game (every board, the hub and
// the sound) so nobody plays a race that won't be kept, and say why over it.
let paused = false;
function pauseOnLoss(msg) {
  if (paused || (!cab && !host)) return; // nothing running: the panel says it
  paused = true;
  if (cab) { try { cab.stop(); } catch { /* already stopped */ } }
  if (host) { try { host.stop(); } catch { /* already stopped */ } }
  window.__docPaused = true;
  $('lost-msg').textContent = msg;
  $('lost-back').setAttribute('href', sp.back.getAttribute('href') || DEFAULT_RETURN_PATH);
  $('lost-overlay').hidden = false;
  $('lost-back').focus();
}

function cabinetCanvases() {
  return BOARD_LABELS.map((label) => $(`cab-${label}`));
}

// The cabinet sound's state for the note (pilot-feedback.js soundFacts).
function soundSnapshot() {
  const a = cabSound;
  if (!a) return null;
  try {
    return { state: a.context ? a.context.state : null, stats: a.stats(), latency: typeof a.latency === 'function' ? a.latency() : null };
  } catch { return null; }
}

function showCabinetStats(s) {
  lastStats = s;
  if (typeof s.fps === 'number' && Number.isFinite(s.fps)) { fpsRecent.push(s.fps); if (fpsRecent.length > 30) fpsRecent.shift(); }
  const parts = [`Boards loaded: ${s.loaded} of ${s.boards}`];
  parts.push(s.linked ? 'Link: on' : 'Link: waiting');
  parts.push(`Speed: ${Math.round(s.fps)} fps`);
  if (s.phase) parts.push(`Race phase ${s.phase}`);
  $('cab-stats').textContent = parts.join('. ') + '.';
}

async function stableMode() {
  sp.panel.hidden = false;
  sp.back.href = handoff.return_path;
  sp.horse.textContent = handoff.horse_name || 'Your horse';
  sp.edition.textContent = `Edition ${handoff.edition}`;
  say('');
  const getAuthToken = await createTokenProvider();
  // The edition this build runs, never the hand-off's own claim: a horse of
  // another edition is refused before any card byte is fetched.
  const source = createStableCardSource({
    handoff, getAuthToken, expectEdition: BUILDABLE_EDITIONS[0],
    onEvent: (e) => {
      stableSay(e.message);
      if (e.type === 'lost' || e.type === 'held' || e.type === 'signin' || e.type === 'error' || e.type === 'rejected') noteError(e.message);
      // Connection trouble: a notice over the game until an answer comes back.
      if (e.type === 'connection') { noteError(e.message); setConnBanner(e.message); }
      if (e.type === 'reconnected') setConnBanner('');
      if (e.type === 'lost' || e.type === 'held' || e.type === 'signin') {
        setConnBanner('');
        sp.start.hidden = true; sp.finish.hidden = true; showBack();
        pauseOnLoss(e.message);
      }
    },
  });
  // Renew the lease from now on: the ROM check and the wait for Start can
  // take longer than one lease.
  source.startLease();
  addEventListener('offline', () => source.nudge());
  addEventListener('online', () => source.nudge());
  mountFeedback(getAuthToken);
  mountControls();
  addEventListener('pagehide', () => source.abandon());
  // Closing the tab with a race owed counts as an unfinished game: ask first.
  addEventListener('beforeunload', (e) => { if (source.raceOpen() && !sp.finish.disabled) { e.preventDefault(); e.returnValue = ''; } });
  const refuse = async (msg) => {
    noteError(msg);
    try { await source.eject(); } catch { /* the lease runs out on its own */ }
    stableSay(msg);
    showBack();
  };
  const check = await verifySetup({ expected: handoff.rom_sha256 });
  if (!check.ok) { await refuse(SETUP_MESSAGES[check.reason]); return; }
  const why = editionProblem(handoff.edition, check.setup);
  if (why) { await refuse(SETUP_MESSAGES[why]); return; }
  if (source.state() !== 'new') return; // the lease ended while checking
  stableSay(`Ready. Press Start, then press ${cardKey()} in the game to insert your horse card.`);
  sp.start.hidden = false;
  sp.start.addEventListener('click', async () => {
    sp.start.hidden = true;
    if (CABINET) { await startCabinetGame(); return; }
    try {
      const factory = await loadCoreFactory();
      if (!factory) { await refuse('The game is not available on this site yet.'); return; }
      const files = [];
      for (const f of check.setup.files) files.push([f.name, await store.read(f.name)]);
      stableSay('Starting the game.');
      host = await startCore({
        factory, canvas, files, game: check.game, options: createCoreOptions(), input,
        jitDet: 1, log: (t) => console.log(`[core] ${t}`), cardSource: source,
      });
      files.length = 0;
      window.__docHost = host;
      if (!host.ok) { await refuse('The game could not start. Return to your stable and try again.'); return; }
      sp.finish.hidden = false;
    } catch (err) {
      if (err instanceof EditionMismatchError || err instanceof CardUnavailableError) await refuse(err.message);
      else await refuse(err && err.name === 'LeaseLostError' ? err.message : STABLE_MESSAGES.error);
    }
  });
  async function startCabinetGame() {
    // The AudioContext is created here, inside the Start click.
    const audioP = openCabinetAudio();
    try {
      $('single-stage').hidden = true;
      $('cabinet').hidden = false;
      // The panel is the stable panel; this is the first moment the cabinet
      // layout is wanted (the audio promise settles before the boards start).
      enterCabinetLayout(await audioP);
      // The player's files, read once from OPFS and shared by all six boards.
      const files = await readCabinetFiles();
      const card = await source.insert();
      const audio = await audioP;
      // Lost while waiting: startStableCabinet refuses (LeaseLostError) and
      // the catch below closes the sound and says why.
      cabSound = audio;
      stableSay(`Starting the cabinet: five boards boot together. This takes about half a minute. Then press ${cardKey()} to insert your horse card.`);
      cab = launchCabinet(files, card);
      files.length = 0;
      window.__docCabinet = cab;
      mountRestart();
      $('cab-audio').textContent = audio ? 'Sound: on (the race and your seat). Set each level below.' : 'Sound: off (this browser could not start audio).';
      sp.finish.hidden = false;
    } catch (err) {
      audioP.then((a) => a && a.close()).catch(() => {});
      if (err instanceof EditionMismatchError || err instanceof CardUnavailableError) await refuse(err.message);
      else await refuse(err && err.name === 'LeaseLostError' ? err.message : STABLE_MESSAGES.error);
    }
  }

  async function readCabinetFiles() {
    const files = [];
    for (const f of check.setup.files) files.push([f.name, (await store.read(f.name)).buffer]);
    return files;
  }
  function launchCabinet(files, card) {
    return startStableCabinet({
      files, game: check.game, card, input, canvases: cabinetCanvases(), source, audio: cabSound,
      onStats: showCabinetStats,
      onFailure: (why) => { console.error(`[cabinet] ${why}`); noteError(`cabinet: ${why}`); stableSay('The cabinet stopped with an error. Your last saved card is safe in your stable. Press Restart cabinet to try again, or return to your stable.'); showBack(); },
      log: (t) => console.log(t),
    });
  }

  // "Restart cabinet" (cabinet-restart.js): an in-page confirm, then the
  // same session carries on with the card read again from the stable. It is
  // refused while a race is owed or a save is on its way.
  let restarting = false;
  function mountRestart() {
    const btn = $('cab-restart'), box = $('cab-restart-confirm'), yes = $('cab-restart-yes'), no = $('cab-restart-no');
    const blocked = () => restartBlocker({ source, cab, busy: restarting || sp.finish.disabled });
    const closeConfirm = () => { box.hidden = true; };
    btn.addEventListener('click', () => {
      const why = blocked();
      if (why) { closeConfirm(); stableSay(RESTART_MESSAGES[why] || RESTART_MESSAGES.not_ready); return; }
      $('cab-restart-q').textContent = RESTART_MESSAGES.confirm;
      box.hidden = false;
      no.focus();
    });
    no.addEventListener('click', () => { closeConfirm(); btn.focus(); });
    box.addEventListener('keydown', (e) => { if (e.code === 'Escape') { e.stopPropagation(); closeConfirm(); btn.focus(); } });
    yes.addEventListener('click', async () => {
      closeConfirm();
      // Checked again: a race may have begun while the question was open.
      const why = blocked();
      if (why) { stableSay(RESTART_MESSAGES[why] || RESTART_MESSAGES.not_ready); return; }
      restarting = true;
      btn.disabled = true;
      sp.finish.disabled = true;
      const old = cab;
      const r = await restartCabinet({
        source, cab: old, say: stableSay,
        boot: async (card) => {
          // Each board's canvas went to its worker (an OffscreenCanvas) and
          // can't be handed over twice, so every canvas is replaced.
          for (const c of cabinetCanvases()) c.replaceWith(c.cloneNode(false));
          const files = await readCabinetFiles();
          const next = launchCabinet(files, card);
          files.length = 0;
          return next;
        },
      });
      restarting = false;
      sp.finish.disabled = false;
      if (r.ok) {
        cab = r.cab;
        window.__docCabinet = cab;
        btn.disabled = false;
        stableSay(`The cabinet restarted with your horse's last saved card. When the boards are up, press ${cardKey()} to insert it.`);
        return;
      }
      if (r.stopped && cab === old) cab = null;
      const err = r.error;
      if (err && (err.name === 'LeaseLostError' || err instanceof EditionMismatchError || err instanceof CardUnavailableError)) {
        sp.finish.hidden = true;
        await refuse(err.message);
        return;
      }
      if (!r.stopped) { btn.disabled = false; stableSay(RESTART_MESSAGES[r.reason] || RESTART_MESSAGES.not_ready); return; }
      noteError(`restart: ${r.reason}${err && err.message ? ` ${err.message}` : ''}`);
      stableSay(err instanceof RestartRefusedError && err.reason === 'race' ? RESTART_MESSAGES.stoppedRace
        : err instanceof RestartRefusedError && err.reason === 'limit' ? RESTART_MESSAGES.limit : RESTART_MESSAGES.stoppedOther);
      if (document.body.classList.contains('cab-mode')) setCabPanel(true);
    });
  }

  // A race is still owed (entered, no result saved yet): leaving now counts
  // as an unfinished game. The first press warns; a second press within 10 s
  // leaves anyway.
  let leaveArmedUntil = 0;
  sp.finish.addEventListener('click', async () => {
    if (source.raceOpen() && performance.now() > leaveArmedUntil) {
      leaveArmedUntil = performance.now() + 10000;
      stableSay('A race is still running. Leaving now counts as an unfinished game and your horse will rest. Press Finish again to leave anyway, or wait for the results to save.');
      if (document.body.classList.contains('cab-mode')) setCabPanel(true);
      return;
    }
    sp.finish.disabled = true;
    stableSay('Saving and returning to your stable.');
    if (cab) {
      // One last look at the card file, then the cabinet ends (every core and
      // its memory FS, the card copy included, go with their workers).
      let last = null;
      try { last = await cab.finish(); } catch { /* the lease decides */ }
      // No answer from the seat: a card write from its last half second may
      // be missing. Say so before leaving.
      if (last === null) {
        stableSay('The game did not answer in time. Your stable keeps the last card it saved. Returning to your stable.');
        await new Promise((r) => setTimeout(r, 4000));
      }
      cab.stop();
    }
    if (host) { host.pollCard(); host.stop(); }
    try { await source.eject(); } catch { /* lease runs out */ }
    // The emulator's copy of the card is cleared before leaving.
    try { if (host && host.Module) host.Module.FS.unlink(`${FS_PATHS.save}/reicast/${check.game}.card`); } catch { /* none */ }
    location.assign(handoff.return_path || DEFAULT_RETURN_PATH);
  });
}

// "Send feedback" (the pilot, D-068): a note plus a few session facts to
// the stable, with the member's sign-in token. Typing in the box must not
// press game buttons or the panel keys, so its key events stop there.
function mountFeedback(getAuthToken) {
  const box = $('pilot-feedback'), form = $('fb-form'), note = $('fb-note'), send = $('fb-send'), status = $('fb-status');
  box.hidden = false;
  for (const t of ['keydown', 'keyup', 'keypress']) note.addEventListener(t, (e) => e.stopPropagation());
  // A game key held down when the box takes focus would never see its
  // key-up (the box keeps it), so every held key is released here.
  note.addEventListener('focusin', () => input.releaseAll());
  // Escape still closes the panel from inside the box.
  note.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && document.body.classList.contains('cab-panel-open')) setCabPanel(false);
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    // A clicked button keeps focus, and Enter on it would send the note again.
    if (document.activeElement === send) send.blur();
    if (send.disabled) return;
    send.disabled = true;
    status.textContent = FEEDBACK_MESSAGES.sending;
    const facts = collectFacts({
      userAgent: navigator.userAgent, stats: lastStats, lastError, pageVersion: pageVersionFrom(document),
      mode: CABINET ? 'cabinet' : 'single', edition: handoff.edition, fpsRecent,
      sound: soundSnapshot(),
    });
    const r = await sendFeedback({ note: note.value, facts, getAuthToken });
    status.textContent = r.message;
    if (r.ok) note.value = '';
    send.disabled = false;
  });
}

if (mode === 'stable') {
  stableMode().catch(() => { stableSay(STABLE_MESSAGES.error); showBack(); });
} else if (mode === 'none') {
  // Only the way back: no ROM picker, no game screen, no board started.
  document.body.classList.add('no-handoff');
  $('no-handoff').hidden = false;
  say('');
}

function frame() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : null;
  if (capture.kind || capture.release) pollCapture(pads);
  input.pollGamepads(pads);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
