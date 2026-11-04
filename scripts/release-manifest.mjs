#!/usr/bin/env node
// release-manifest.mjs: record which doc-browser-source commit the served Flycast cores
// were built from, so the game page can link to the exact source.
//
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Written by Claude (Claude Code), 2026-11-03.
//
// Usage (from a doc-browser-source checkout that has the release tag):
//
//   node scripts/release-manifest.mjs --deploy <doc-arcade>/pilot-assets --tag web-2026.11.03-1 --repo-url https://github.com/<owner>/<repo>
//   node scripts/release-manifest.mjs --deploy <doc-arcade>/pilot-assets --check
//
// Write mode hashes the core files the page serves (and nothing else), reads
// the Flycast version string each wasm carries, resolves the tag to a commit
// in this repository, checks that the commit has SOURCE.md, and writes
// <deploy>/source-manifest.json. Check mode re-hashes the cores and exits 1
// if any differs from the manifest, so a deploy cannot ship a core the
// manifest does not describe.
//
// Only files named flycast_libretro.js or flycast_libretro.wasm under the
// known core folders are ever read. The script never hashes a ROM, a card or
// any other file. It writes only the manifest, and only inside --deploy.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_NAME = 'source-manifest.json';
const TAG_RE = /^web-\d{4}\.\d{2}\.\d{2}-\d+$/;

// The served cores, relative to <doc-arcade>/pilot-assets.
export const CORES = [
  { variant: 'single-board', dir: 'src/core', flycastBranch: 'doc-wasm/8412d3d8a', series: ['flycast/patches'], link: 'scripts/link-win.ps1' },
  { variant: 'five-board', dir: 'src/lb/core', flycastBranch: 'doc-wasm/linkbus2', series: ['flycast/patches', 'flycast/patches-linkbus2'], link: 'scripts/link-linkbus2.ps1' },
];
const CORE_FILES = ['flycast_libretro.wasm', 'flycast_libretro.js'];

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// Flycast embeds `git describe --tags` of its source tree, for example
// "v2.6-317-ge2e54ca6c". Returns the first such string, or null.
export function flycastVersion(buf) {
  const m = /v\d+\.\d+-\d+-g([0-9a-f]{7,40})/.exec(buf.toString('latin1'));
  return m ? { describe: m[0], commit: m[1] } : null;
}

function git(args) {
  return execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8' }).trim();
}

function parseArgs(argv) {
  const out = { check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') out.check = true;
    else if (a === '--deploy') out.deploy = argv[++i];
    else if (a === '--tag') out.tag = argv[++i];
    else if (a === '--repo-url') out.repoUrl = argv[++i];
    else if (a === '--allow-untagged') out.allowUntagged = true;
    else throw new Error('unknown argument ' + a);
  }
  if (!out.deploy) throw new Error('--deploy <doc-arcade>/pilot-assets is required');
  // The public source repository is named on every write, never assumed.
  if (!out.check && !/^https:\/\/\S+[^/]$/.test(out.repoUrl || '')) throw new Error('--repo-url https://<host>/<owner>/<repo> is required');
  return out;
}

export function readCores(deploy) {
  const root = resolve(deploy);
  const cores = [];
  for (const c of CORES) {
    const files = [];
    let version = null;
    for (const name of CORE_FILES) {
      const rel = `${c.dir}/${name}`;
      const full = resolve(root, ...rel.split('/'));
      if (!full.startsWith(root + sep)) throw new Error('path escapes deploy: ' + rel);
      if (!existsSync(full)) throw new Error('missing core file ' + rel);
      const buf = readFileSync(full);
      files.push({ path: rel, bytes: statSync(full).size, sha256: sha256(buf) });
      if (name.endsWith('.wasm')) version = flycastVersion(buf);
    }
    cores.push({ variant: c.variant, flycast_branch: c.flycastBranch, flycast_version: version ? version.describe : null,
      patch_series: c.series, link_script: c.link, files });
  }
  return cores;
}

export function buildManifest({ cores, tag, commit, repoUrl, now = new Date() }) {
  const ref = tag || commit;
  return {
    schema: 1,
    name: 'Derby Owners Club browser cores (Flycast for WebAssembly)',
    // GPL-3.0-or-later while the cores carry libcdio's iso9660.h (COPYRIGHT).
    license: 'GPL-3.0-or-later',
    built_on: 'Flycast, https://github.com/flyinghead/flycast, upstream commit 8412d3d8a',
    source: {
      repository: repoUrl,
      tag: tag || null,
      commit,
      browse: `${repoUrl}/tree/${ref}`,
      archive: `${repoUrl}/archive/${ref}.zip`,
      how_to_build: `${repoUrl}/blob/${ref}/SOURCE.md`,
      notices: `${repoUrl}/blob/${ref}/THIRD_PARTY_NOTICES.md`,
      licence_text: `${repoUrl}/blob/${ref}/LICENSE.GPL-3`,
      licence_text_gpl2: `${repoUrl}/blob/${ref}/LICENSE`,
    },
    generated_utc: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    cores,
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const deploy = resolve(opts.deploy);
  const manifestPath = join(deploy, MANIFEST_NAME);
  const cores = readCores(deploy);

  if (opts.check) {
    if (!existsSync(manifestPath)) { console.error('no ' + MANIFEST_NAME + ' in ' + deploy); process.exit(1); }
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const want = new Map(m.cores.flatMap((c) => c.files.map((f) => [f.path, f.sha256])));
    let bad = 0;
    for (const c of cores) for (const f of c.files) {
      if (want.get(f.path) !== f.sha256) { console.error('MISMATCH ' + f.path); bad++; }
    }
    console.log(bad ? `${bad} core file(s) differ from the manifest` : `manifest matches (${m.source.tag || m.source.commit})`);
    process.exit(bad ? 1 : 0);
  }

  if (!opts.tag && !opts.allowUntagged) throw new Error('--tag web-YYYY.MM.DD-N is required (or --allow-untagged for a test run)');
  if (opts.tag && !TAG_RE.test(opts.tag)) throw new Error('tag must look like web-2026.11.03-1');
  const commit = git(['rev-parse', '--verify', (opts.tag || 'HEAD') + '^{commit}']);
  try { git(['cat-file', '-e', `${commit}:SOURCE.md`]); } catch { throw new Error(`commit ${commit} has no SOURCE.md`); }
  const manifest = buildManifest({ cores, tag: opts.tag, commit, repoUrl: opts.repoUrl });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log('wrote ' + manifestPath);
  for (const c of cores) console.log(`  ${c.variant}: ${c.flycast_version || 'no version string'}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error('release-manifest: ' + e.message); process.exit(2); }
}
