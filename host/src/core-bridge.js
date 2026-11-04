// core-bridge.js: the JS half of the thin libretro host. GPL-2.0-or-later.
//
// Status: skeleton. The C half (a small shim that implements the libretro
// frontend callbacks and calls into these functions) is written once the
// core links (PLAN_V2 2.2 and 2.3). Until then this module defines the
// contract both halves must keep, and the parts that can be tested now.

export const CORE_OPTION_PREFIX = 'reicast_';

// Option defaults the host sets before retro_load_game. Names are from
// Flycast shell/libretro/libretro_core_options.h at 8412d3d8a.
// threaded_rendering off: assumed, because the wasm build has no pthreads
// (flycast-wasm build-prod.sh passes no -pthread). Recheck after W2.
export const DEFAULT_CORE_OPTIONS = Object.freeze({
  reicast_threaded_rendering: 'disabled',
  reicast_internal_resolution: '640x480',
  reicast_allow_service_buttons: 'enabled',
});

// RETRO_ENVIRONMENT_* commands the shim forwards to JS.
export const ENV = Object.freeze({
  SET_ROTATION: 1,
  GET_CAN_DUPE: 3,
  SET_PIXEL_FORMAT: 10,
  SET_HW_RENDER: 14,
  GET_VARIABLE: 15,
  GET_VARIABLE_UPDATE: 17,
  GET_SYSTEM_DIRECTORY: 9,
  GET_SAVE_DIRECTORY: 31,
  SET_SYSTEM_AV_INFO: 32,
});

export const RETRO_HW_CONTEXT_OPENGLES3 = 4;

// Paths inside the core's in-memory file system. Nothing here is persisted
// by Emscripten; ROMs are copied in from OPFS on each boot.
export const FS_PATHS = Object.freeze({
  system: '/home/web_user/retroarch/system',
  save: '/home/web_user/retroarch/saves',
  roms: '/home/web_user/roms',
});

export function createCoreOptions(overrides = {}) {
  const values = new Map(Object.entries(DEFAULT_CORE_OPTIONS));
  let dirty = true;
  for (const [k, v] of Object.entries(overrides)) set(k, v);

  function set(key, value) {
    if (typeof key !== 'string' || !key.startsWith(CORE_OPTION_PREFIX)) {
      throw new Error(`not a Flycast core option: ${key}`);
    }
    if (typeof value !== 'string') throw new Error(`option ${key} needs a string value`);
    if (values.get(key) !== value) {
      values.set(key, value);
      dirty = true;
    }
  }

  return {
    set,
    // GET_VARIABLE: undefined means "frontend has no value", so the core
    // uses its own default.
    get: (key) => values.get(key),
    // GET_VARIABLE_UPDATE: true once after any change.
    takeUpdated() {
      const was = dirty;
      dirty = false;
      return was;
    },
    entries: () => Array.from(values.entries()),
  };
}

// Answers for environment calls that need no C memory access. Returns
// { handled, value }. The shim handles pointer arguments itself and asks
// JS only for the decision.
export function decideEnvironment(cmd, arg, ctx) {
  switch (cmd) {
    case ENV.GET_CAN_DUPE:
      return { handled: true, value: true };
    case ENV.SET_PIXEL_FORMAT:
      // 1 = XRGB8888, 2 = RGB565. Software frames are not used by Flycast
      // in HW mode, but both are accepted.
      return { handled: arg === 1 || arg === 2, value: arg };
    case ENV.SET_HW_RENDER:
      return { handled: arg === RETRO_HW_CONTEXT_OPENGLES3, value: arg };
    case ENV.GET_SYSTEM_DIRECTORY:
      return { handled: true, value: FS_PATHS.system };
    case ENV.GET_SAVE_DIRECTORY:
      return { handled: true, value: FS_PATHS.save };
    case ENV.GET_VARIABLE: {
      const v = ctx && ctx.options ? ctx.options.get(arg) : undefined;
      return { handled: v !== undefined, value: v };
    }
    case ENV.GET_VARIABLE_UPDATE:
      return { handled: true, value: Boolean(ctx && ctx.options && ctx.options.takeUpdated()) };
    case ENV.SET_ROTATION:
      if (ctx) ctx.rotation = arg & 3;
      return { handled: true, value: arg & 3 };
    default:
      return { handled: false, value: undefined };
  }
}

function mkdirp(FS, path) {
  let cur = '';
  for (const part of path.split('/').filter(Boolean)) {
    cur += `/${part}`;
    try {
      FS.mkdir(cur);
    } catch (err) {
      if (!(err && (err.code === 'EEXIST' || err.errno === 20))) {
        const st = FS.analyzePath ? FS.analyzePath(cur) : { exists: false };
        if (!st.exists) throw err;
      }
    }
  }
}

// Copies ROM bytes from OPFS into the core's in-memory FS and returns the
// path to pass to retro_load_game. FS is Emscripten's Module.FS.
export function mountRom(FS, name, bytes) {
  if (typeof name !== 'string' || name.includes('/') || name.includes('..')) {
    throw new Error('bad ROM name');
  }
  mkdirp(FS, FS_PATHS.roms);
  mkdirp(FS, FS_PATHS.system);
  mkdirp(FS, FS_PATHS.save);
  const path = `${FS_PATHS.roms}/${name}`;
  FS.writeFile(path, bytes);
  return path;
}

// Loads the built core (flycast_libretro.js plus .wasm, same origin) when
// it exists. Returns null when the core is not built yet, so the page can
// say so instead of failing.
export async function loadCoreFactory(url = './core/flycast_libretro.js') {
  try {
    const mod = await import(url);
    return mod.default || null;
  } catch {
    return null;
  }
}

// Page query value of jitdet to the rec-wasm deterministic mode:
// 0 off (wall-clock compile budgets, async compiles; diagnostics only),
// 1 batched deterministic compiles (the default for the page), 2 one
// synchronous compile per block (the first deterministic mode, kept for
// comparison). Missing or unknown values give fallback.
export function jitDetMode(value, fallback = 1) {
  if (value === '0' || value === '1' || value === '2') return Number(value);
  return fallback;
}
