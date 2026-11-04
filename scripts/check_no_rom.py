#!/usr/bin/env python3
"""Repository policy check: nothing ROM-derived or binary goes into Git.

Written by Claude (Claude Code), 2026-11-02. GPL-2.0-or-later.

Checks every file Git would commit (tracked plus untracked, not ignored), or
the paths given on the command line:

- refused extensions: .ic22 .zip .bin .nvmem .card .chd .wasm .a .o
- any file over 2 MB
- any path with a build/ or run-logs/ folder in it
- any em dash (U+2014) or en dash (U+2013) in our own text files; the
  upstream patch series under flycast/patches/ is exempt, since it carries
  upstream text as written

Exit 0 when clean, 1 when any file breaks a rule, 2 on usage errors.
Usage: python scripts/check_no_rom.py [path ...]
"""

import os
import subprocess
import sys

REFUSED_EXT = {".ic22", ".zip", ".bin", ".nvmem", ".card", ".chd", ".wasm", ".a", ".o"}
REFUSED_DIRS = {"build", "run-logs"}
MAX_BYTES = 2 * 1024 * 1024
DASHES = {chr(0x2013): "en dash", chr(0x2014): "em dash"}
DASH_EXEMPT_PREFIX = "flycast/patches/"
DASH_EXEMPT_EXT = {".patch", ".diff"}

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def git_files():
    out = subprocess.run(
        ["git", "-C", ROOT, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        check=True, capture_output=True,
    ).stdout
    files = [p for p in out.decode("utf-8").split("\0") if p]
    # Deleted-but-tracked files are listed by --cached; skip them.
    return sorted(p for p in files if os.path.isfile(os.path.join(ROOT, p)))


def is_text(data):
    return b"\0" not in data[:8192]


def check(rel):
    problems = []
    rel = rel.replace("\\", "/")
    parts = rel.split("/")
    lower = rel.lower()
    ext = os.path.splitext(lower)[1]
    if ext in REFUSED_EXT:
        problems.append("refused file type " + ext)
    if any(p in REFUSED_DIRS for p in parts[:-1]):
        problems.append("path under build/ or run-logs/")
    full = os.path.join(ROOT, rel)
    size = os.path.getsize(full)
    if size > MAX_BYTES:
        problems.append("larger than 2 MB (%d bytes)" % size)
        return problems
    with open(full, "rb") as fh:
        data = fh.read()
    exempt = rel.startswith(DASH_EXEMPT_PREFIX) and ext in DASH_EXEMPT_EXT
    if not exempt and is_text(data):
        text = data.decode("utf-8", errors="replace")
        for lineno, line in enumerate(text.splitlines(), 1):
            for ch, name in DASHES.items():
                if ch in line:
                    problems.append("%s on line %d" % (name, lineno))
    return problems


def main(argv):
    if argv:
        rels = []
        for a in argv:
            full = os.path.abspath(a)
            if not os.path.isfile(full):
                print("check_no_rom: not a file: " + a, file=sys.stderr)
                return 2
            rels.append(os.path.relpath(full, ROOT))
    else:
        rels = git_files()
    bad = 0
    for rel in rels:
        for p in check(rel):
            print("REFUSED %s: %s" % (rel.replace("\\", "/"), p))
            bad += 1
    print("check_no_rom: %d files checked, %d problems" % (len(rels), bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
