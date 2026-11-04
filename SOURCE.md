# Source for the browser game cores

Copyright (C) 2026 John R Reeves III. SPDX-License-Identifier: GPL-2.0-or-later.

The Derby Owners Club browser game runs on two Flycast cores built for
WebAssembly. This file says which source each served core comes from and how
to rebuild it. The host page and our patches are free software under the GNU
General Public License, version 2 or (at your option) any later version
(`LICENSE`). The served cores also contain libcdio's `iso9660.h`
(GPL-3.0-or-later), so the combined cores are distributed under version 3 or
any later version (`LICENSE.GPL-3`) until patch 0023 (section 8) takes it
out; see `COPYRIGHT`. Notices for the permissive third-party parts are in
`THIRD_PARTY_NOTICES.md`.

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
| Patch series | `flycast/patches/0001` to `0022` | `flycast/patches/0001` to `0022`, then `flycast/patches-linkbus2/0001` to `0009` |
| Resulting Flycast tree | commit e2e54ca6cc5e (branch `doc-wasm/8412d3d8a`), tree 5d1858a1703f | tree 4da9f93a87f7 (the tree of `doc-wasm/linkbus2` commit 0fb4009b4) |
| Version string inside the wasm | `v2.6-317-ge2e54ca6c` | `v2.6-323-g888703467` (see 5.2) |
| Library build | `scripts/build-win.ps1` | `scripts/build-win.ps1 -SourceDir <ExtRoot>/wt-linkbus2` |
| Link | `scripts/link-win.ps1` | `scripts/link-linkbus2.ps1` |
| Host shim linked in | `host/shim/libretro_shim.c`, `core_config_shim.cpp`, `debug_state_shim.cpp`, `stubs/flycast_stubs.c` | the same plus `host/shim/linkbus_shim.cpp` |

The patch series, shims, stubs and link scripts in this repository are the
ones the served cores were built from (single-board: commit e2e54ca6c;
five-board: tree 0fb4009b4, both built 2026-11-02). The host page in `host/`
matches the page served at `/pilot` on 2026-11-03. Section 7 says how a
release is tagged.

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

# Checks: wt-8412d3d8a HEAD is e2e54ca6cc5eb4091404c13212520c0055e02205;
#         wt-linkbus2 HEAD^{tree} is 4da9f93a87f71253e0233b253cf04efa5d1c53b5.

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
`-DUSE_BUNDLED_GAME_DATA=OFF` (section 8).

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
result. The single-board tree, rebuilt from the patches with the committer
settings above, is commit e2e54ca6c again, so the string matches.

The five-board core was configured on 2026-11-02 at 21:41 UTC while its tree
was commit 888703467 with the last three patches' changes present but not yet
committed; they were committed eight minutes later as 421edb813, 21b2dcbec and
0fb4009b4. Its version string therefore reads `v2.6-323-g888703467`. Git
cannot recreate those commit hashes from patch files (the earlier commits on
that branch were rebased, so their committer data differs), so a rebuild
reports `v2.6-326-g<other hash>`. The code is the 0fb4009b4 tree; section 6
shows the rest of the file is identical.

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
| libcdio `iso9660.h` (GPL-3.0-or-later) | **Yes** | `core/imgread/isofs.cpp` includes it and is linked (used by the Dreamcast HLE BIOS disc boot in `core/reios/reios.cpp`). `-DUSE_LIBCDIO=OFF` only turns off upstream's optional CD-drive library; it does not touch this header |
| Unclear provenance, not needed for NAOMI: `core/reios/descrambl.cpp`, `core/deps/chdpsr/cdipsr.cpp` | **Yes** | both compiled and linked (reios disc boot; CDI disc images) |
| Unclear provenance, needed for NAOMI: `core/hw/naomi/decrypt.cpp`, `core/hw/aica/dsp_interp.cpp` | Yes (kept on purpose) | NAOMI needs them |

What would close the two open rows (a patch 0023 on `doc-wasm/8412d3d8a`,
carried into `doc-wasm/linkbus2`, then a rebuild and a new tag):

1. A CMake option, for example `USE_DREAMCAST_DISC` (default ON, which keeps
   upstream behaviour; `build-win.ps1` passes OFF), that leaves out
   `core/imgread/isofs.cpp`, `core/reios/descrambl.cpp`, `core/imgread/cdi.cpp`
   and `core/deps/chdpsr/*`, guards the disc-boot path in `core/reios/reios.cpp`
   (`reios_locate_bootfile` and the descramble step) and the CDI entry in the
   image driver table (`core/imgread/common.cpp`) with
   `#ifdef USE_DREAMCAST_DISC`. NAOMI never boots through reios, so the game is
   unaffected; a Dreamcast disc would no longer boot in the browser build.
2. Or, to keep Dreamcast disc boot: replace `iso9660.h` with a short header of
   our own (GPL-2.0-or-later) that declares only the ISO 9660 volume
   descriptor and directory record layouts `isofs.cpp` uses, and still leave
   out `descrambl.cpp` and `cdipsr.cpp` as in 1.
3. Extend the archive check in `build-win.ps1` from `xbrz|libcdio` to also
   refuse `isofs`, `descrambl`, `cdipsr` and `cdi.cpp` objects, so a regression
   fails the build. The current check passes even though `isofs.cpp.o` carries
   the libcdio header.

Checked on 2026-11-03 against commit e2e54ca6c: the only users of `IsoFs`,
`descrambl_buffer` and `cdi_parse` in the libretro build are
`core/reios/reios.cpp` and `core/imgread/common.cpp` (`core/ui/boxart/scraper.cpp`
also uses `IsoFs` but is built only when `LIBRETRO` is off). So option 1 is a
small patch touching `CMakeLists.txt`, `core/imgread/CMakeLists.txt`,
`core/reios/CMakeLists.txt`, `core/reios/reios.cpp` and
`core/imgread/common.cpp`. It is not in the served cores yet: it changes them,
so it lands with the next core rebuild, together with a new release tag.
