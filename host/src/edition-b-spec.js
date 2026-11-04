// edition-b-spec.js: the stripped spec for Edition B ("Rev C Rebalanced",
// doc-ops D-072): stock Rev C plus the fixes Q01, Q04 and Q17.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// This is a verbatim copy of doc-ops
// research/engine-bible/browser/editionb/edition_b.spec.json (reviewed in
// doc-ops #1379). It carries no ROM bytes: each edit is either a new word
// written by IHA (new_word) or an address whose word is copied from the
// player's own file at run time (copy_from). The pins (sizes and hashes)
// let the page refuse any file that is not the stock set and any result
// that is not the reviewed image. Do not edit by hand: copy the reviewed
// file again. test/edition-b.test.mjs checks the shape.
export const EDITION_B_SPEC_JSON = `
{
 "format": "doc-edition-spec/1",
 "edition": "B",
 "manifest": "FIXROM-REVC",
 "fixes": ["Q01", "Q04", "Q17"],
 "member": "epr-22336c.ic22",
 "base": "0C020000",
 "source_size": 4194304,
 "source_crc32": "50053F82",
 "source_sha256": "2d2e76d4f7bb498d90211410c38291e832ce7175647a5cebed1003b8d641995e",
 "output_sha256": "921b728bb846fd1de3ba12496540c46c0de4671131139c39a64afc7138188595",
 "relocated_words": "copy",
 "edits": [
  {"fix": "Q04", "address": "0C064CF2", "new_word": "E107"},
  {"fix": "Q04", "address": "0C064CF6", "new_word": "3016"},
  {"fix": "Q04", "address": "0C064CF8", "new_word": "8B00"},
  {"fix": "Q04", "address": "0C064CFA", "new_word": "6013"},
  {"fix": "Q04", "address": "0C064CFC", "new_word": "E218"},
  {"fix": "Q04", "address": "0C064CFE", "new_word": "202E"},
  {"fix": "Q04", "address": "0C064D00", "new_word": "001A"},
  {"fix": "Q04", "address": "0C064D02", "new_word": "9263"},
  {"fix": "Q04", "address": "0C064D04", "copy_from": "0C064D00"},
  {"fix": "Q04", "address": "0C064D06", "copy_from": "0C064D02"},
  {"fix": "Q04", "address": "0C064D08", "new_word": "D132"},
  {"fix": "Q01", "address": "0C073AAC", "new_word": "E014"},
  {"fix": "Q01", "address": "0C073AAE", "new_word": "3403"},
  {"fix": "Q01", "address": "0C073AB0", "new_word": "0009"},
  {"fix": "Q01", "address": "0C073AB2", "new_word": "8902"},
  {"fix": "Q17", "address": "0C07D28C", "new_word": "633E"},
  {"fix": "Q17", "address": "0C07D298", "new_word": "633E"},
  {"fix": "Q17", "address": "0C07D2A4", "new_word": "633E"},
  {"fix": "Q17", "address": "0C07D2B0", "new_word": "633E"},
  {"fix": "Q17", "address": "0C07D2BC", "new_word": "633E"},
  {"fix": "Q17", "address": "0C07D2C8", "new_word": "633E"}
 ]
}
`;
