# Source for the browser game cores

Copyright (C) 2026 John R Reeves III. SPDX-License-Identifier: GPL-2.0-or-later.

The Derby Owners Club browser game runs on two Flycast cores built for
WebAssembly. This file says which source each served core comes from and how
to rebuild it. The host page and our patches are free software under the GNU
General Public License, version 2 or (at your option) any later version
(`LICENSE`). The served cores also contain picoTCP (GPL-2.0-only OR
GPL-3.0-only), so each combined core is distributed under version 2 of the
GNU General Public License; see `COPYRIGHT` and section 8. Notices for the
permissive third-party parts are in `THIRD_PARTY_NOTICES.md`.

No game data is here or in the cores. The player supplies the game files,
which stay in the player's browser.

## 1. What is served

The game page at `/pilot` is `host/index.html`, served with these files
beside it:

| Core | Files in the deploy | Used for |
|---|---|---|
| Single-board | `src/core/flycast_libretro.js`, `src/core/flycast_libretro.wasm` | one game board on one page (diagnostics, `?board=single`) |
| Five-board | `src/lb/core/flycast_libretro.js`, `src/lb/core/flycast_libretro.wasm` | the linked five-board cabinet on one page (boards run in workers); a stable game runs on this core |

The page's own JavaScript is `host/src/` of this repository, served as
written (no build step). The four `lb-*.js` modules are deployed one folder
down, in `src/lb/`, with their relative imports adjusted to match;
`host/README.md` gives the mapping. Nothing else is changed.

The deployed `flycast_libretro.js` files pass through Git with line-ending
normalisation, so the 16 CRLF line ends the linker writes into each become
LF. The `.wasm` files are copied byte for byte.

## 2. Matching source

Everything below is in this repository except upstream Flycast itself.

| | Single-board core | Five-board core |
|---|---|---|
| Upstream base | Flycast 8412d3d8a391 (https://github.com/flyinghead/flycast) | same |
| Patch series | `flycast/patches/0001` to `0023` | `flycast/patches/0001` to `0023`, then `flycast/patches-linkbus2/0001` to `0010` |
| Resulting Flycast tree | commit 4cb999d50434, tree 8fee3edf1bc4 | commit b3e207a43bcf, tree 9369df86118d |
| Version string inside the wasm | `v2.6-318-g4cb999d50` | `v2.6-328-gb3e207a43` |
| Library build | `scripts/build-win.ps1` | `scripts/build-win.ps1 -SourceDir <ExtRoot>/wt-linkbus2` |
| Link | `scripts/link-win.ps1` | `scripts/link-linkbus2.ps1` |
| Host shim linked in | `host/shim/libretro_shim.c`, `core_config_shim.cpp`, `debug_state_shim.cpp`, `stubs/flycast_stubs.c` | the same plus `host/shim/linkbus_shim.cpp` |

The patch series, shims, stubs and link scripts in this repository are the
ones the cores of release `web-2026.11.05-1` were built from (single-board:
commit 4cb999d50434; five-board: commit b3e207a43bcf; both built 2026-11-05
by the recipe in section 4). Section 7 says how a release is tagged.

Upstream submodules used by the build, all pinned by the Flycast tree:
libchdr 5f82799f2, tinygettext 41572a67f (and its tinycmmc 9a51e1380), asio
d3402006e. The others are checked out but not compiled.

## 3. Toolchain

| Tool | Version |
|---|---|
| OS | Windows 11 (the build is not yet scripted for Linux or macOS) |
| Git for Windows | any recent; `core.autocrlf=true` (its default; see 5.3) |
| emsdk | 3.1.74 (emcc 3.1.74, 1092ec30a3fb), installed with `emsdk install 3.1.74` and `emsdk activate 3.1.74` |
| zlib | the emsdk port, zlib 1.2.13 (`embuilder build zlib`; `build-win.ps1` runs it if missing) |
| CMake | 4.4.4 (`py -3.13 -m pip install --user cmake==4.4.4`) |
| Ninja | 1.13.2 (`py -3.13 -m pip install --user ninja==1.13.2`) |
| Python | 3.13 (only to install CMake and Ninja; emsdk brings its own) |
| PowerShell | Windows PowerShell 5.1 |

Nothing needs administrator rights. The scripts set the Emscripten
environment for their own process only.

## 4. Rebuild

Pick a working folder outside this repository, for example
`C:\dev\doc-browser-build\ext` (called `<ExtRoot>`). It holds emsdk, the two
Flycast trees, the build folders and the logs.

```
# 1. emsdk 3.1.74 in <ExtRoot>\emsdk
git clone https://github.com/emscripten-core/emsdk.git <ExtRoot>\emsdk
<ExtRoot>\emsdk\emsdk.bat install 3.1.74
<ExtRoot>\emsdk\emsdk.bat activate 3.1.74

# 2. Flycast trees. The committer settings make git am recreate the exact
#    commits (and so the exact version string); see 5.2.
$env:GIT_COMMITTER_NAME  = 'John R Reeves III'
$env:GIT_COMMITTER_EMAIL = 'johnreevesiii@outlook.com'
foreach ($t in 'wt-8412d3d8a', 'wt-linkbus2') {
  git clone https://github.com/flyinghead/flycast.git <ExtRoot>\$t
  git -C <ExtRoot>\$t checkout --detach 8412d3d8a391
  git -C <ExtRoot>\$t submodule update --init --recursive
  git -C <ExtRoot>\$t am --keep-cr --committer-date-is-author-date <doc-browser-source>\flycast\patches\*.patch
}
git -C <ExtRoot>\wt-linkbus2 am --keep-cr --committer-date-is-author-date <doc-browser-source>\flycast\patches-linkbus2\*.patch

# Checks: wt-8412d3d8a HEAD is 4cb999d50434f7ad00bdbee2ef0d62b68804bdbe;
#         wt-linkbus2 HEAD is b3e207a43bcf4d54585f9e04bbde349eccc5cfa4.

# 3. Libraries (about 2 minutes each on 32 threads)
powershell -NoProfile -File <doc-browser-source>\scripts\build-win.ps1 -ExtRoot <ExtRoot>
powershell -NoProfile -File <doc-browser-source>\scripts\build-win.ps1 -ExtRoot <ExtRoot> -SourceDir <ExtRoot>\wt-linkbus2

# 4. Link (about 10 seconds each)
powershell -NoProfile -File <doc-browser-source>\scripts\link-win.ps1      -ExtRoot <ExtRoot>
powershell -NoProfile -File <doc-browser-source>\scripts\link-linkbus2.ps1 -ExtRoot <ExtRoot>
```

Outputs: `<ExtRoot>\build-wasm\link-out\flycast_libretro.{js,wasm}` (single
board) and `<ExtRoot>\build-wasm\link-out-linkbus2\flycast_libretro.{js,wasm}`
(five board). Each script writes a log and a provenance record to
`<ExtRoot>\build-logs`. The header of each script explains its options;
`build-win.ps1` passes `-DUSE_XBRZ=OFF`, `-DUSE_LIBCDIO=OFF` and
`-DUSE_BUNDLED_GAME_DATA=OFF`, and patch 0023 turns `USE_ISOFS` off by default
in this build (section 8). After building, `build-win.ps1` refuses the library
if it holds an xBRZ, libcdio, ISO 9660 reader or `achievements.cpp` object, or
if any file in `build.ninja` or `ninja -t deps` carries a common GPL version 3
notice (SPDX or licence-header text) that does not also allow version 2. `-CheckOnly` runs only these checks on an
existing build folder.

## 5. Getting the same bytes

The build is deterministic: the same inputs at the same paths give the same
files. Four inputs are easy to miss.

### 5.1 Source path

Flycast's log and assert macros store `__FILE__`, so about 100 absolute source
paths end up in each wasm, for example
`C:/dev/doc-browser-build/ext/wt-8412d3d8a/core/emulator.cpp`. A tree at
another path gives a wasm that differs only in those strings (and, if the path
length differs, in the layout after them). To compare, either build at
`C:\dev\doc-browser-build\ext`, or build at a path of the same length and
swap the prefix in your output before hashing (section 6 did this).

### 5.2 Version string

Flycast's CMake runs `git describe --tags` at configure time and stores the
result. Both trees, rebuilt from the patches with the committer settings
above, are commits 4cb999d50434 and b3e207a43bcf again, so the strings match.

(Until release `web-2026.11.05-1` the five-board core carried the string
`v2.6-323-g888703467`, a commit that existed only on the build PC; section 6
has the history. The cores of `web-2026.11.05-1` are built straight from the
recipe, so this no longer applies.)

### 5.3 Line endings

The `.po` translation files are embedded byte for byte. The served cores were
built from a checkout with `core.autocrlf=true`, so those files have CRLF line
ends. A checkout with LF line ends gives different translation bytes.

### 5.4 Emscripten system libraries

The served cores link the system libraries (libc, libc++, libc++abi,
compiler-rt and the rest) that ship prebuilt inside the emsdk 3.1.74 release
archive, in `emsdk/upstream/emscripten/cache/sysroot/lib/wasm32-emscripten`.
Emscripten throws that cache away and rebuilds the libraries locally whenever
its configuration changes, for example when the emsdk folder is moved, copied
or reached through a junction. A local rebuild on Windows embeds a different
source path in one libc++abi assert message
(`../../../system/lib/libcxxabi/src/fallback_malloc.cpp` instead of
`system/lib/libcxxabi/src/fallback_malloc.cpp`), which shifts the data that
follows. Use a fresh emsdk install, do not move it, and do not let the cache be
cleared. Only zlib (`libz.a`) is built locally, by `build-win.ps1`; that build
is path independent.

## 6. Reproduction check, 2026-11-03

Done on the build PC, 2026-11-03, in a scratch folder outside every
repository whose path has the same length as `C:\dev\doc-browser-build\ext`:

1. Clean clone of this repository at the pull request branch.
2. Flycast cloned at 8412d3d8a391 with all submodules at their pinned
   commits (taken from local mirrors of the upstream repositories, the same
   objects as GitHub), then the patch series applied with `git am` as in
   section 4. Single-board: HEAD came out as e2e54ca6cc5e, the same commit.
   Five-board: the tree came out as 4da9f93a87f7, the same tree as 0fb4009b4.
3. Its own copy of emsdk 3.1.74 with the release's prebuilt system libraries
   (5.4), CMake 4.4.4 and Ninja 1.13.2.
4. `build-win.ps1`, `link-win.ps1` and `link-linkbus2.ps1` from the clean
   clone, unchanged. Library builds took about 2 minutes each, links about 20
   seconds.

Results, after swapping only the 28-character source path prefix back
(5.1):

| File | Result |
|---|---|
| single-board `flycast_libretro.js` | identical to the served file, byte for byte, with no swap |
| single-board `flycast_libretro.wasm` | identical to the served file after the path swap (101 path strings) |
| five-board `flycast_libretro.js` | identical to the served file, byte for byte, with no swap |
| five-board `flycast_libretro.wasm`, built from the patch-applied commit | differs only through the version string (5.2): with `v2.6-326-gddd460ecf` in place of `v2.6-323-g888703467` the linker orders the merged string data differently and the file is 2 bytes shorter; code section identical in size |
| five-board `flycast_libretro.wasm`, built with HEAD at 888703467 and the 0fb4009b4 tree as the five uncommitted changes (the state recorded in the build PC's provenance file) | identical to the served file after the path swap (102 path strings) |

So the served five-board core is the code of tree 0fb4009b4, which is exactly
`flycast/patches` plus `flycast/patches-linkbus2` in this repository. Its
version string names a commit that only exists in the build PC's Flycast
repository. Rebuilding and redeploying the five-board core from the
patch-applied tree would make the served file reproducible from this
repository alone (its code would not change).

Not checked here: a build on another machine, on Linux, or with Flycast
cloned from GitHub over the network.

### 6.1 Reproduction check, 2026-11-05 (cores of `web-2026.11.05-1`)

Done on the build PC, 2026-11-05, with its own fresh emsdk 3.1.74 (5.4), in a
working folder at another path, with `__FILE__` paths mapped to
`C:/dev/doc-browser-build/ext/wt-8412d3d8a` and `.../wt-linkbus2` through
`EMCC_CFLAGS=-fmacro-prefix-map=...` (5.1), so the outputs are the files a
build at `C:\dev\doc-browser-build\ext` gives:

1. Flycast at 8412d3d8a391 with its pinned submodules, then the patch series
   of this repository applied with `git am` as in section 4. HEAD came out as
   4cb999d50434 (single-board) and b3e207a43bcf (five-board).
2. `build-win.ps1` and the two link scripts of this repository (the link
   scripts unchanged except that their output and source folders were pointed
   at the working folder).
3. Each core was built twice, in separate build folders; both builds gave the
   same bytes.
4. The same setup rebuilt the previously served single-board core (commit
   e2e54ca6c, before patch 0023) byte for byte, as a check of the setup.
5. `build-win.ps1 -CheckOnly` passed on both build folders (no GPL version 3
   file among 2379 and 2383 compiled sources and headers) and failed on a
   build of the previous five-board tree (it found `isofs.cpp.o`,
   `achievements.cpp.o`, `iso9660.h` and `achievements.cpp`).

The SHA-256 of each released core file is recorded in the deploy's
`source-manifest.json` (section 7).

## 7. Release labels

- Tag the doc-browser-source commit whose patch series and scripts built the deployed
  cores: `web-YYYY.MM.DD-N` (annotated), for example `web-2026.11.03-1`. N
  counts deploys of new cores on the same day. A tag is never moved; a fixed
  build gets the next N.
- When cores are deployed, run from that tag's checkout:

  ```
  node scripts/release-manifest.mjs --deploy <deploy folder> --tag web-2026.11.03-1 --repo-url https://github.com/<owner>/<repo>
  ```

  It writes `source-manifest.json` in the deploy folder with each served core file's
  size and SHA-256, the Flycast version string read from each wasm, the tag,
  the commit, and links to the source tree, the zip archive, this file, the
  notices and the licence. Planned: once the public repository exists, the
  game page will link to the tagged source (that link is added in
  doc-arcade after publishing). Write mode needs `--repo-url` naming the
  public repository; there is no default.
- Before a deploy, `node scripts/release-manifest.mjs --deploy <deploy folder> --check`
  fails if a core differs from the manifest.
- The script reads only `flycast_libretro.js` and `flycast_libretro.wasm`
  under `src/core` and `src/lb/core`. It never reads or hashes game files.

## 8. Licence status of the served cores

| Item | In the served cores? | Evidence |
|---|---|---|
| xBRZ (GPL-3.0) | No | `-DUSE_XBRZ=OFF` (patch 0005); `xbrz.cpp` not in the build graph or the library |
| Bundled third-party game data (flash images, F355 picture, printer fonts, BIOS font) | No | `-DUSE_BUNDLED_GAME_DATA=OFF` (patch 0006); `libflycast-resources.a` holds only the resource index and 8 translation files |
| libcdio `iso9660.h` (GPL-3.0-or-later) | No | Patch 0023: option `USE_ISOFS`, OFF by default for the libretro Emscripten build, leaves out `core/imgread/iso9660.h`, `isofs.cpp` and `isofs.h`; `reios_locate_bootfile` (Dreamcast disc boot only) refuses with an error. Not in either build's `build.ninja` or `ninja -t deps` |
| DuckStation-derived `core/achievements/achievements.cpp` (GPL-3.0 OR CC-BY-NC-ND-4.0) | No | Patch 0023: the libretro build compiles `core/achievements/achievements_stub.cpp` (GPL-2.0-or-later, the savestate stub) instead. Before 0023 only the file's stub was compiled (no RetroAchievements in the libretro build) |
| picoTCP (GPL-2.0-only OR GPL-3.0-only) | Yes | `core/deps/picotcp` is linked through `core/network/picoppp.cpp` (Dreamcast modem and network emulation). Compatible with GPL-2.0 and GPL-3.0 but not with "any later version". With the GPL version 3 sources gone (patch 0023), the combined cores are GPL-2.0, through picoTCP's version 2 option |
| Unclear provenance, not needed for NAOMI: `core/reios/descrambl.cpp`, `core/deps/chdpsr/cdipsr.cpp` | **Yes** | both compiled and linked (reios disc boot; CDI disc images) |
| Unclear provenance, needed for NAOMI: `core/hw/naomi/decrypt.cpp`, `core/hw/aica/dsp_interp.cpp` | Yes (kept on purpose) | NAOMI needs them |

Patch 0023 closes the GPL version 3 rows. A NAOMI game never uses the ISO
9660 reader: `reios_locate_bootfile` is reached only when
`settings.platform.isConsole()`, and `reios_boot` loads a NAOMI game from the
cartridge. The only other user of `IsoFs`, `core/ui/boxart/scraper.cpp`, is
built only without `LIBRETRO`.

Still open: `core/reios/descrambl.cpp` and `core/deps/chdpsr/cdipsr.cpp`
(unclear provenance, no licence header, not needed for NAOMI) are compiled
and linked. A later patch can leave them out the same way.
