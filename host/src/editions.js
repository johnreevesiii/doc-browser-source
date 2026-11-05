// editions.js: the browser game's edition registry (doc-ops
// research/engine-bible/browser/EDITION_MODEL.md). One row per edition: a
// release (the arcade set it runs) plus how its game image is made.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// The same table lives in doc-arcade src/lib/browserEdition.ts; the two
// must agree on every id, name, release, build, filesFrom, linkTag and
// buildable value. Ids are permanent (they are stored with every horse and
// signed into every card version). Editions never mix (D-059, D-062).
//
// A new edition registers by flipping `buildable` to true here and in
// doc-arcade, in its own lane's PR, once its port works. Until then the game
// refuses it everywhere (rom-setup.js editionProblem 'not-built'), it has no
// link tags (edition-b.js LINK_EDITION), and the stable never offers it.
//
// build: 'stock' = the stored game file as it is; 'edition-b' = rebuilt in
// page memory from the stock Rev C set (edition-b.js, D-072).
// filesFrom: the edition whose stored game files this edition runs from.
// linkTag: the LinkBus edition tag (linkbus/linkbus.h enum Edition). Tags of
// editions that are not buildable are reserved only: the core refuses them
// until the core/link lane adds them.

const row = (r) => Object.freeze(r);

export const EDITION_REGISTRY = Object.freeze([
  row({ id: 'A', name: 'Rev C', release: 'drbyocwc', build: 'stock', filesFrom: 'A', linkTag: 1, family: 'eng', buildable: true }),
  row({ id: 'B', name: 'Rev C Rebalanced', release: 'drbyocwc', build: 'edition-b', filesFrom: 'A', linkTag: 2, family: 'eng', buildable: true }),
  row({ id: 'J99', name: "DOC '99", release: 'derbyoc', build: 'stock', filesFrom: 'J99', linkTag: 3, family: 'jp', buildable: false }),
  row({ id: 'J2K', name: 'DOC 2000', release: 'derbyo2k', build: 'stock', filesFrom: 'J2K', linkTag: 4, family: 'jp', buildable: false }),
  row({ id: 'RD', name: 'Rev D', release: 'derbyocw', build: 'stock', filesFrom: 'RD', linkTag: 5, family: 'eng', buildable: false }),
]);

const BY_ID = new Map(EDITION_REGISTRY.map((e) => [e.id, e]));

export const EDITION_IDS = Object.freeze(EDITION_REGISTRY.map((e) => e.id));
/** The editions this build of the game can run, in registry order. */
export const BUILDABLE = Object.freeze(EDITION_REGISTRY.filter((e) => e.buildable).map((e) => e.id));

export function editionDef(id) { return (typeof id === 'string' && BY_ID.get(id)) || null; }
export function isEditionId(v) { return editionDef(v) !== null; }
export function isBuildable(v) { const d = editionDef(v); return !!(d && d.buildable); }
export function editionName(id) { const d = editionDef(id); return d ? d.name : null; }
export function linkTagOf(id) { const d = editionDef(id); return d ? d.linkTag : null; }
export function filesEditionOf(id) { const d = editionDef(id); return d ? d.filesFrom : null; }

/**
 * The OPFS record (folder "roms") that lists the stored files an edition
 * runs from. Rev C (A, and B built from it) keeps "doc-setup.json" exactly
 * as before; every other files group has its own record, so setting up one
 * release never replaces another's files. null for an unknown id.
 */
export function setupFileFor(id) {
  const g = filesEditionOf(id);
  if (!g) return null;
  return g === 'A' ? 'doc-setup.json' : `doc-setup-${g}.json`;
}
