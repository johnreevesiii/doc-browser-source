# Host page

Copyright (C) 2026 John R Reeves III. GPL-2.0-or-later.

Our own libretro host for the Flycast wasm cores: the game page, its
JavaScript modules and the C/C++ shims linked into the cores. The page has no
build step; the modules are served as written.

## Served layout

The deployed page is `index.html` with these files beside it:

| Deployed path | From this folder |
|---|---|
| `src/*.js` | `src/*.js`, except the four `lb-*.js` modules |
| `src/lb/lb-*.js` | `src/lb-*.js`; on deploy their imports of the shared modules gain `../` (for example `./core-bridge.js` becomes `../core-bridge.js`), and modules that import an `lb-*.js` module reach it as `./lb/...` |
| `src/core/flycast_libretro.{js,wasm}` | the single-board core (`../SOURCE.md`) |
| `src/lb/core/flycast_libretro.{js,wasm}` | the five-board core (`../SOURCE.md`) |

The page needs cross-origin isolation (COOP `same-origin`, COEP
`require-corp`) for SharedArrayBuffer.

## Folders

| Folder | Contents |
|---|---|
| `src/` | Page modules: game file store and setup check, input, audio, video, core bridge, card store and the stable card source, the five-board linked cabinet (`lb-*.js`, `cabinet-game.js`) |
| `shim/` | C/C++ linked into the cores: the libretro front end (`libretro_shim.c`), core options, debug state reads, and the LinkBus glue for the five-board core |

The player supplies the game files, which stay in the browser. Nothing here
contains or is derived from game data.
