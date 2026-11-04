// lb-lockstep.js: lockstep LinkBus hub for the single-page cabinet, four or
// eight seats (doc-wasm/linkbus2). Pure functions plus SharedArrayBuffer mailbox
// helpers; no network code. Used by lb-hub-worker.js and the node tests.
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Wire format and mailbox layout: core/network/linkbus.h on
// doc-wasm/linkbus2 (SlotFrameHeader, AssembledFrameHeader, MailboxLayout).
// The core side is MailboxConfig::lockstep: a seat publishes one slot frame
// per linked vblank, and its take number k >= 1 blocks until the hub has
// delivered round k - 1 (hubTick k). This hub assembles round r only when
// every seat has published its r-th frame, so every board's vblank k reads
// every board's vblank k - 1 data: zero skew by construction.
//
// RX assembly is the reference assembleRx() order: for target t, RX slot
// k = 1..n holds node (t + n - k) mod n (k = n is t's own slot back). A slot
// that is missing or refused this round keeps its previous bytes, as
// natively. The slot size comes from the master's (node 0) frame of the
// round only (LinkBus review R1); a seat whose slot size differs is refused
// for that round and counted.

export const SLOT_MAGIC = 0x3152424c; // "LBR1"
export const ASSEMBLED_MAGIC = 0x3141424c; // "LBA1"
export const WIRE_VERSION = 1;
export const SLOT_HEADER_BYTES = 20;
export const ASSEMBLED_HEADER_BYTES = 24;
export const MAX_PAYLOAD = 0x4000;
export const EDITION_A = 1;

// MailboxLayout (byte offsets; i32 header words).
export const MB = Object.freeze({
  seq: 0,
  latestIndex: 4,
  errorFlag: 8,
  txSeq: 12,
  rxLength: 16,
  txLength: 28,
  vblankCount: 32, // written by the core's vblank barrier
  hubRound: 36, // written by the hub
  barrierStop: 40, // nonzero releases the barrier (shutdown)
  headerBytes: 64,
  bufferBytes: ASSEMBLED_HEADER_BYTES + MAX_PAYLOAD,
});
export const mbRxBuffer = (i) => MB.headerBytes + MB.bufferBytes * i;
export const MB_TX_BUFFER = MB.headerBytes + MB.bufferBytes * 3;
export const MB_TOTAL_BYTES = MB_TX_BUFFER + SLOT_HEADER_BYTES + MAX_PAYLOAD;

// Hub status words (Int32, written by lb-hub-worker.js, read by
// lb-cabinet.js hubStatus()): single words, then one word per ring node for
// each per-seat counter. 16 words per counter: a ring of up to 16 nodes
// (kMaxRingNodes), so nine (eight seats) fit. (The four-seat layout had 8
// per counter; only these offsets changed, not what is counted.)
export const HUB_STATUS = Object.freeze({
  round: 0, waitingSeat: 1, running: 2, emptyRounds: 3, overruns: 4, busyMs: 5, lateResets: 6, lateMs: 7,
  txSeq: 8, refused: 24, sizeMismatch: 40, unsized: 56, words: 72, maxNodes: 16,
});

// MultiboardSabLayout: 64-byte header, then the 1 MB bank.
export const CABINET_TOTAL_BYTES = 64 + 0x100000;
// MultiboardSnapshotLayout::totalBytes (linkbus.h): the live layout plus four
// log regions of 16 + 0x80000 * 8 bytes.
export const CABINET_SNAPSHOT_BYTES = CABINET_TOTAL_BYTES + 4 * (16 + 0x80000 * 8);

export function parseSlotHeader(bytes) {
  if (bytes.length < SLOT_HEADER_BYTES) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, SLOT_HEADER_BYTES);
  return {
    magic: v.getUint32(0, true),
    version: v.getUint8(4),
    edition: v.getUint8(5),
    nodeId: v.getUint8(6),
    slotCount: v.getUint8(7),
    slotSize: v.getUint16(8, true),
    packetNumber: v.getUint16(10, true),
    localFrame: v.getUint32(12, true),
    sessionTag: v.getUint32(16, true),
  };
}

export function encodeAssembledHeader(out, h) {
  const v = new DataView(out.buffer, out.byteOffset, ASSEMBLED_HEADER_BYTES);
  v.setUint32(0, ASSEMBLED_MAGIC, true);
  v.setUint8(4, WIRE_VERSION);
  v.setUint8(5, h.edition);
  v.setUint8(6, h.targetNode);
  v.setUint8(7, h.slotCount);
  v.setUint16(8, h.slotSize, true);
  v.setUint16(10, h.prevPacketNumber, true);
  v.setUint32(12, h.hubTick >>> 0, true);
  v.setUint32(16, h.releaseFrame >>> 0, true);
  v.setUint32(20, h.sessionTag >>> 0, true);
}

// RX source node for slot k (1 <= k <= n) at node own (linkbus.h).
export const rxSourceNode = (own, n, k) => (own + n - (k % n)) % n;

// The hub state machine. round(frames) takes this round's slot frame bytes,
// one Uint8Array per seat in seat order, and returns one assembled frame per
// target seat. It never reads the slot payload, only copies it.
// checkLocalFrame: count seats whose slot frame is not this round's (round
// sync). Frame sync re-sends each seat's newest frame, so it is off there.
export function createLockstepHub({ n, edition = EDITION_A, sessionTag, checkLocalFrame = true }) {
  if (!(n >= 2 && n <= 16)) throw new Error('slot count out of range');
  let round = 0;
  let slotSize = 0;
  const rx = Array.from({ length: n }, () => null);
  const prevPn = new Array(n).fill(0);
  const stats = {
    rounds: 0,
    emptyRounds: 0,
    refused: new Array(n).fill(0), // bad header, edition, node, count or size
    sizeMismatch: new Array(n).fill(0), // valid frame, slot size differs from the master's
    unsized: new Array(n).fill(0), // header-only frame (no geometry yet on that seat)
    localFrameSkew: new Array(n).fill(0), // localFrame was not this round
  };

  function check(i, bytes) {
    // Frame sync: a seat that has not published yet (no ring geometry).
    if (bytes.length === 0) return { h: { slotSize: 0, packetNumber: 0 }, ok: true };
    const h = parseSlotHeader(bytes);
    if (!h || h.magic !== SLOT_MAGIC || h.version !== WIRE_VERSION || h.sessionTag !== (sessionTag >>> 0)
      || h.edition !== edition || h.nodeId !== i || h.slotCount !== n) return { h, ok: false };
    if (checkLocalFrame && h.localFrame !== (round >>> 0)) stats.localFrameSkew[i]++;
    return { h, ok: true };
  }

  function step(frames) {
    if (frames.length !== n) throw new Error('need one frame per seat');
    const checked = frames.map((b, i) => check(i, b));
    // R1: the master's frame of this round sets the slot size.
    const m = checked[0];
    let S = m.ok ? m.h.slotSize : 0;
    if (S * n > MAX_PAYLOAD) S = 0;
    if (S !== slotSize) {
      slotSize = S;
      for (let t = 0; t < n; t++) rx[t] = null;
    }
    const slots = checked.map((c, i) => {
      if (!c.ok) { stats.refused[i]++; return null; }
      if (c.h.slotSize === 0) { stats.unsized[i]++; return null; }
      if (S === 0) return null;
      if (c.h.slotSize !== S || frames[i].length !== SLOT_HEADER_BYTES + S) { stats.sizeMismatch[i]++; return null; }
      return frames[i].subarray(SLOT_HEADER_BYTES, SLOT_HEADER_BYTES + S);
    });
    const hubTick = (round + 1) >>> 0;
    const out = [];
    for (let t = 0; t < n; t++) {
      if (S === 0) {
        const f = new Uint8Array(ASSEMBLED_HEADER_BYTES);
        encodeAssembledHeader(f, { edition, targetNode: t, slotCount: n, slotSize: 0, prevPacketNumber: prevPn[t], hubTick, releaseFrame: hubTick, sessionTag });
        out.push(f);
        continue;
      }
      if (!rx[t]) rx[t] = new Uint8Array(S * n);
      for (let k = 1; k <= n; k++) {
        const src = slots[rxSourceNode(t, n, k)];
        if (src) rx[t].set(src, S * (k - 1));
      }
      const pred = rxSourceNode(t, n, 1);
      if (slots[pred]) prevPn[t] = checked[pred].h.packetNumber;
      const f = new Uint8Array(ASSEMBLED_HEADER_BYTES + S * n);
      encodeAssembledHeader(f, { edition, targetNode: t, slotCount: n, slotSize: S, prevPacketNumber: prevPn[t], hubTick, releaseFrame: hubTick, sessionTag });
      f.set(rx[t], ASSEMBLED_HEADER_BYTES);
      out.push(f);
    }
    if (S === 0) stats.emptyRounds++;
    round++;
    stats.rounds = round;
    return out;
  }

  return { step, stats, round: () => round, slotSize: () => slotSize };
}

// ---- Mailbox access (transport side) ---------------------------------------

export function mailboxViews(sab) {
  if (!(sab instanceof SharedArrayBuffer) || sab.byteLength < MB_TOTAL_BYTES) throw new Error('mailbox must be a SharedArrayBuffer of MB_TOTAL_BYTES');
  return { i32: new Int32Array(sab, 0, MB.headerBytes >> 2), u8: new Uint8Array(sab) };
}

// The core's slot frame count so far (txSeq) and a copy of the newest frame.
export function readTx(views) {
  const txSeq = Atomics.load(views.i32, MB.txSeq >> 2) >>> 0;
  const len = Math.min(Atomics.load(views.i32, MB.txLength >> 2) >>> 0, SLOT_HEADER_BYTES + MAX_PAYLOAD);
  return { txSeq, bytes: views.u8.slice(MB_TX_BUFFER, MB_TX_BUFFER + len) };
}

// Same steps as mailboxDeliver() in linkbus.cpp: write the buffer that is
// not latestIndex, store its length, store latestIndex, then bump seq.
export function deliver(views, frame) {
  const i32 = views.i32;
  const seq = Atomics.load(i32, MB.seq >> 2) >>> 0;
  const idx = seq === 0 ? 0 : ((Atomics.load(i32, MB.latestIndex >> 2) >>> 0) + 1) % 3;
  const len = Math.min(frame.length, MB.bufferBytes);
  views.u8.set(frame.subarray(0, len), mbRxBuffer(idx));
  Atomics.store(i32, (MB.rxLength >> 2) + idx, len);
  Atomics.store(i32, MB.latestIndex >> 2, idx);
  Atomics.add(i32, MB.seq >> 2, 1);
  Atomics.notify(i32, MB.seq >> 2);
}
