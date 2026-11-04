# flycast_stubs

Copyright (C) 2026 John R Reeves III. GPL-2.0-or-later.

`flycast_stubs.c` is our source for the small object the wasm link needs in
place of the prebuilt, source-less `flycast_stubs.o` that flycast-wasm links.
`link-win.ps1` and `link-linkbus2.ps1` compile it into both cores.

| Symbol | What it does |
|---|---|
| `__wrap_glGetString` | GL_VERSION and GL_SHADING_LANGUAGE_VERSION return fixed GLES strings; everything else calls `__real_glGetString` (the link keeps `-Wl,--wrap=glGetString`) |
| `bm_Reset` | C linkage no-op |
| `fill_short_pathname_representation` | basename of the path, truncated, NUL terminated |
| `fill_short_pathname_representation_noext` | as above, minus the last extension |

`test_flycast_stubs.c` is a small native test:
`cc -o test_flycast_stubs test_flycast_stubs.c flycast_stubs.c`.
