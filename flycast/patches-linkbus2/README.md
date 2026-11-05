# Flycast patch series (five-board core)

Copyright (C) 2026 John R Reeves III. GPL-2.0-or-later, like the code it carries.

Applied with `git am` on top of `../patches/` (commit 4cb999d50434), these
ten patches give commit b3e207a43bcf (tree 9369df86118d), the source of the
served five-board core.
They add LinkBus: a seam for the NAOMI M3 comm board ring and the multiboard
bank, so that the five boards of a linked cabinet can run in one browser page
(one core per worker) and talk through SharedArrayBuffer mailboxes instead of
UDP sockets and OS shared memory. How to apply and build: `../../SOURCE.md`.

| Patch | Change |
|---|---|
| 0001 | linkbus: ring seam for the NAOMI M3 comm board |
| 0002 | linkbus: multiboard backend seam and opt-in browser multiboard |
| 0003 | linkbus: validation, replay, stale run and SAB barrier fixes |
| 0004 | linkbus: hub learns the slot size from the master |
| 0005 | linkbus: host-set multiboard board id for the libretro build |
| 0006 | linkbus: snapshot SAB multiboard backend for a deterministic master pair |
| 0007 | linkbus: header-only rounds are stale, board id is clamped |
| 0008 | naomi: no automatic F355 multiboard in the browser build |
| 0009 | linkbus: vblank barrier; loud snapshot failures |
| 0010 | linkbus: accept the J99 (3), J2K (4) and RD (5) edition tags |

The host side of the link is `host/shim/linkbus_shim.cpp` and
`host/src/lb-*.js`.
