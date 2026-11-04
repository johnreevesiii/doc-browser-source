// debug_state_shim.cpp: guest state hashes for the determinism probe
// (PLAN_V2 2.5, D-062 item 6).
//
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Exports small read-only views of guest state so tools/determinism-run.mjs
// can compare runs: a 64-bit hash of main RAM (all of settings.platform
// .ram_size, 32 MB on NAOMI), a hash of the architectural SH4 registers,
// per-chunk RAM hashes to locate a divergence, and a plain register dump.
// Only hashes and register values leave the core; RAM bytes are never
// copied out.
//
// It also wraps time() (link-win.ps1 passes -Wl,--wrap=time) so the probe
// can pin the host clock that seeds the AICA real-time clock and the
// syscfg time in flash. Unpinned (the default), the wrap calls the real
// time(). Compiled with the core's include and define set.

#include "types.h"
#include "hw/sh4/sh4_if.h"
#include "hw/sh4/sh4_mem.h"
#include "hw/sh4/sh4_sched.h"
#include <emscripten.h>
#include <ctime>
#include <cstring>

extern "C" time_t __real_time(time_t *t);

static bool time_pinned;
static time_t time_pin;

extern "C" time_t __wrap_time(time_t *t)
{
	if (!time_pinned)
		return __real_time(t);
	if (t)
		*t = time_pin;
	return time_pin;
}

// Pins time() to a fixed Unix time (seconds), or unpins it with pinned = 0.
// Call before shim_load_game so the RTC and flash syscfg see it.
extern "C" EMSCRIPTEN_KEEPALIVE void shim_dbg_pin_time(int pinned, double unix_seconds)
{
	time_pinned = pinned != 0;
	time_pin = (time_t)unix_seconds;
}

// rec-wasm deterministic mode (all compiles synchronous, no chain sweep).
extern "C" void fly_set_deterministic(int on);
extern "C" EMSCRIPTEN_KEEPALIVE void shim_dbg_set_jit_det(int on)
{
	fly_set_deterministic(on);
}

static const u64 FNV_OFFSET = 0xcbf29ce484222325ull;
static const u64 FNV_PRIME = 0x100000001b3ull;

// FNV-1a style, one 64-bit word per step (RAM size is a multiple of 8).
static u64 hash_words(const u8 *p, size_t bytes, u64 h)
{
	const u64 *w = (const u64 *)p;
	for (size_t i = 0; i < bytes / 8; i++) {
		h ^= w[i];
		h *= FNV_PRIME;
	}
	return h;
}

// Architectural SH4 registers only (no JIT or scheduler scratch fields).
// Layout, 69 words: r0..r15, r_bank0..7, gbr, ssr, spc, sgr, dbr, vbr,
// mach, macl, pr, fpul, pc, sr, fpscr, fr0..15, xf0..15.
static const int REG_WORDS = 69;

static void regs_dump(u32 *o)
{
	const Sh4Context &c = Sh4cntx;
	int n = 0;
	for (int i = 0; i < 16; i++) o[n++] = c.r[i];
	for (int i = 0; i < 8; i++) o[n++] = c.r_bank[i];
	o[n++] = c.gbr; o[n++] = c.ssr; o[n++] = c.spc; o[n++] = c.sgr;
	o[n++] = c.dbr; o[n++] = c.vbr;
	o[n++] = c.mac.h; o[n++] = c.mac.l;
	o[n++] = c.pr; o[n++] = c.fpul; o[n++] = c.pc;
	o[n++] = c.sr.getFull();
	o[n++] = c.fpscr.full;
	for (int i = 0; i < 16; i++) { u32 v; memcpy(&v, &c.fr[i], 4); o[n++] = v; }
	for (int i = 0; i < 16; i++) { u32 v; memcpy(&v, &c.xf[i], 4); o[n++] = v; }
}

extern "C" EMSCRIPTEN_KEEPALIVE int shim_dbg_reg_words(void) { return REG_WORDS; }

// Writes REG_WORDS words to out. Returns the count.
extern "C" EMSCRIPTEN_KEEPALIVE int shim_dbg_regs(u32 *out)
{
	if (p_sh4rcb == nullptr) return 0;
	regs_dump(out);
	return REG_WORDS;
}

// out[0..1] RAM hash (lo, hi), out[2..3] register hash (lo, hi),
// out[4] pc, out[5] RAM size in bytes, out[6..7] SH4 scheduler cycle
// count (lo, hi; guest time, informative and not part of either hash).
// Returns 1, or 0 if the core has no RAM yet.
extern "C" EMSCRIPTEN_KEEPALIVE int shim_dbg_state_hash(u32 *out)
{
	const u32 size = settings.platform.ram_size;
	if (p_sh4rcb == nullptr || size == 0) return 0;
	u64 rh = hash_words(&mem_b[0], size, FNV_OFFSET);
	u32 regs[REG_WORDS];
	regs_dump(regs);
	u64 gh = hash_words((const u8 *)regs, sizeof(regs) - (sizeof(regs) % 8), FNV_OFFSET);
	gh = (gh ^ regs[REG_WORDS - 1]) * FNV_PRIME;
	u64 now = sh4_sched_now64();
	out[0] = (u32)rh; out[1] = (u32)(rh >> 32);
	out[2] = (u32)gh; out[3] = (u32)(gh >> 32);
	out[4] = Sh4cntx.pc;
	out[5] = size;
	out[6] = (u32)now; out[7] = (u32)(now >> 32);
	return 1;
}

// Hashes RAM in `chunks` equal parts (power of two, at most 1024) into
// out[0..chunks-1] (low 32 bits of each 64-bit hash). Returns chunks, or 0.
extern "C" EMSCRIPTEN_KEEPALIVE int shim_dbg_ram_chunks(u32 *out, int chunks)
{
	const u32 size = settings.platform.ram_size;
	if (p_sh4rcb == nullptr || size == 0 || chunks <= 0 || chunks > 1024 || (chunks & (chunks - 1)) != 0)
		return 0;
	const u32 len = size / (u32)chunks;
	for (int i = 0; i < chunks; i++) {
		u64 h = hash_words(&mem_b[(size_t)i * len], len, FNV_OFFSET);
		out[i] = (u32)(h ^ (h >> 32));
	}
	return chunks;
}

// Reads one aligned 32-bit RAM word by offset (masked), for narrowing a
// divergence to an address without exporting RAM. Probe use only.
extern "C" EMSCRIPTEN_KEEPALIVE u32 shim_dbg_ram_word(u32 offset)
{
	const u32 size = settings.platform.ram_size;
	if (p_sh4rcb == nullptr || size == 0) return 0;
	u32 v;
	memcpy(&v, &mem_b[(offset & (size - 1)) & ~3u], 4);
	return v;
}
