# doc-browser-source

Derby Owners Club in the browser, running on Flycast built for WebAssembly.
This repository is the complete corresponding source of the browser game: the
patches to Flycast, the host page and its shims, and the scripts that build
the two cores the page serves.

The player brings their own game files. This repository contains no game data
and nothing derived from it: no ROM or BIOS bytes, dumps, extracted assets,
screenshots, traces, cards or saves. One exception, approved by John R Reeves
III for this recipe only: `host/src/edition-b-spec.js`, the recipe the page
uses to build the Rev C Rebalanced edition from the player's own stock game
file, holds two SHA-256 checks (the stock program it accepts and the program
it must produce) so the page can refuse any other file. It holds no game bytes.

## Layout

| Folder | Contents |
|---|---|
| `flycast/patches/` | Patch series on upstream Flycast 8412d3d8a: the flycast-wasm port, the wasm JIT fixes and our build options (single-board core) |
| `flycast/patches-linkbus2/` | LinkBus series applied on top (five-board linked cabinet core) |
| `host/` | The game page, its JavaScript modules and the C/C++ shims linked into the cores |
| `stubs/` | Source for the small stub object the wasm link needs |
| `scripts/` | Windows build and link scripts for the cores, the release manifest script and the repository policy check |

How to rebuild each served core, and which commit matches it: `SOURCE.md`.

## Checks

    python scripts/check_no_rom.py
    node --test scripts/release-manifest.test.mjs

The policy check refuses ROM and binary file types, any file over 2 MB, build
output, and em or en dashes in our own text.

## Licence

Our code and patches are GPL-2.0-or-later, the same as Flycast (`LICENSE`,
GPL version 2). The served cores also contain picoTCP, which is licensed
under GPL version 2 or version 3 only, so each combined core is distributed
under version 2 of the GNU General Public License (`LICENSE`). Patch 0023
keeps the GPL version 3 sources (libcdio's `iso9660.h` and DuckStation's
`achievements.cpp`) out of the cores; see `SOURCE.md` section 8. Each
source file keeps its own licence. See `COPYRIGHT`, and
`THIRD_PARTY_NOTICES.md` for the permissive third-party parts linked into
the cores.

## Credits

- Flycast by flyinghead and contributors: https://github.com/flyinghead/flycast (GPL-2.0-or-later).
- flycast-wasm by nasomers: https://github.com/nasomers/flycast-wasm (GPL-2.0).

Derby Owners Club is a trademark of its owner. This project is not affiliated
with or endorsed by Sega.
