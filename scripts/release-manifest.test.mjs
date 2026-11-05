// Tests for release-manifest.mjs. Written by Claude (Claude Code), 2026-11-03.
// Copyright (C) 2026 John R Reeves III. SPDX-License-Identifier: GPL-2.0-or-later.
// Run: node --test scripts/release-manifest.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CORES, buildManifest, flycastVersion, readCores, sha256 } from './release-manifest.mjs';

function fakeDeploy() {
  const root = mkdtempSync(join(tmpdir(), 'relman-'));
  for (const c of CORES) {
    const dir = join(root, ...c.dir.split('/'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'flycast_libretro.wasm'), Buffer.from(`\0asm\x01\0\0\0 v2.6-317-ge2e54ca6c ${c.variant}`, 'latin1'));
    writeFileSync(join(dir, 'flycast_libretro.js'), `// ${c.variant}\n`);
  }
  return root;
}

test('flycastVersion finds the git describe string', () => {
  assert.deepEqual(flycastVersion(Buffer.from('xx v2.6-323-g888703467 yy')), { describe: 'v2.6-323-g888703467', commit: '888703467' });
  assert.equal(flycastVersion(Buffer.from('no version here')), null);
});

test('readCores hashes only the two core files of each variant', () => {
  const root = fakeDeploy();
  try {
    writeFileSync(join(root, 'src', 'core', 'game.zip'), 'not read');
    const cores = readCores(root);
    assert.equal(cores.length, 2);
    for (const c of cores) {
      assert.deepEqual(c.files.map((f) => f.path.split('/').pop()), ['flycast_libretro.wasm', 'flycast_libretro.js']);
      assert.equal(c.flycast_version, 'v2.6-317-ge2e54ca6c');
      for (const f of c.files) assert.match(f.sha256, /^[0-9a-f]{64}$/);
    }
    assert.equal(cores[1].files[1].sha256, sha256(Buffer.from('// five-board\n')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('readCores refuses a deploy without the cores', () => {
  const root = mkdtempSync(join(tmpdir(), 'relman-'));
  try { assert.throws(() => readCores(root), /missing core file/); } finally { rmSync(root, { recursive: true, force: true }); }
});

test('buildManifest links the tag, not a moving branch', () => {
  const m = buildManifest({ cores: [], tag: 'web-2026.11.03-1', commit: 'a'.repeat(40), repoUrl: 'https://example.invalid/doc-web', now: new Date(0) });
  assert.equal(m.license, 'GPL-2.0-only');
  assert.equal(m.source.licence_text, 'https://example.invalid/doc-web/blob/web-2026.11.03-1/LICENSE');
  assert.equal(m.source.browse, 'https://example.invalid/doc-web/tree/web-2026.11.03-1');
  assert.equal(m.source.how_to_build, 'https://example.invalid/doc-web/blob/web-2026.11.03-1/SOURCE.md');
  assert.equal(m.generated_utc, '1970-01-01T00:00:00Z');
});
