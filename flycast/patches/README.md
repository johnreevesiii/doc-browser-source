# Flycast patch series (single-board core)

Copyright (C) 2026 John R Reeves III. GPL-2.0-or-later, like the code it carries.

Base: upstream Flycast 8412d3d8a391 (https://github.com/flyinghead/flycast).
Patches 0001 to 0003 port flycast-wasm 16e9c7b by nasomers
(https://github.com/nasomers/flycast-wasm, GPL-2.0) onto that base. The rest
are ours. Applied in order with `git am` they give commit 4cb999d50434, the
source of the served single-board core. The five-board core applies
`../patches-linkbus2/` on top. How to apply and build: `../../SOURCE.md`.

| Patch | Change |
|---|---|
| 0001 | wasm: port the flycast-wasm phase 1 patch onto 8412d3d8a |
| 0002 | wasm: add the rec-wasm SH4 to WebAssembly JIT sources (from flycast-wasm, unchanged) |
| 0003 | wasm: drop code compiled only without JIT_PROD_BUILD |
| 0004 | wasm: add source for the flycast_stubs object |
| 0005 | build: `USE_XBRZ` option, to build without the GPL-3.0 xBRZ upscaler |
| 0006 | build: `USE_BUNDLED_GAME_DATA` option, to leave out bundled third-party game data |
| 0007 | rec-wasm: use the platform RAM mask in the inline RAM fast paths |
| 0008 | aica: declare the g_fly_rp telemetry array at file scope |
| 0009 | rec-wasm: opt-in deterministic mode |
| 0010 | rec-wasm: fast-forward only polling self-loops, not counted delays |
| 0011 | rec-wasm: batch compiles in deterministic mode |
| 0012 | rec-wasm: keep the chain sweep in deterministic mode |
| 0013 | rec-wasm: fast-forward only self-loops without loop-carried state |
| 0014 | rec-wasm: update the chain builder's self-loop comment |
| 0015 | rec-wasm: size the page-exec histogram from the RAM size |
| 0016 | rec-wasm: mask chain guard page indices with RAM_MASK |
| 0017 | rec-wasm: bump page generations for interpreter-fallback stores |
| 0018 | rec-wasm: JIT self-test and clock jitter test hooks |
| 0019 | rec-wasm: per-read clock jitter and a bridge-charge test hook |
| 0020 | rec-wasm: run every single-instruction interpreter step under the ifb guard |
| 0021 | rec-wasm: fix the ifb guard comment about the insurance tick |
| 0022 | rec-wasm: do not exempt T from the loop-carried register test |
| 0023 | build: leave GPL-3.0 sources out of the libretro browser build (the ISO 9660 reader with libcdio's `iso9660.h`, and DuckStation's `achievements.cpp`; see `../../SOURCE.md` section 8) |
