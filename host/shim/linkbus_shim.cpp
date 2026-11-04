// linkbus_shim.cpp: per-board link settings and link status for the
// single-page five-board cabinet (doc-wasm/linkbus2).
//
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// The libretro build pins the network options (shell/libretro/option.cpp:
// NetworkEnable and ActAsServer false, MultiboardSlaves 0) and never reads
// naomi:BoardId from a command line. The desktop lab sets them per board in
// emu.cfg (lab_config.py) and starts the master's graphics partner with
// "-config naomi:BoardId=1" (multiboard.cpp startPartners); the libretro
// build has no config file, so the board id goes through
// linkbus::setMultiboardBoardId (doc-wasm/linkbus2). This shim gives
// the host page the same settings, before shim_load_game:
//
//   board 0 (master, seat 0):  NetworkEnable yes, ActAsServer yes, MultiboardSlaves 2
//   partner (BoardId 1):       same as board 0, plus settings.naomi.slave (nullDC.cpp 83-87)
//   boards 1..4 (satellites):  NetworkEnable yes, ActAsServer no,  MultiboardSlaves 1
//
// It also reads the comm board status words for the link check:
// comm_status2 is (slots << 8) | node id once the ring is up (for DOC
// slots = n - 1, so 0x04kk with five seats), and 0 when the link is down
// (a link error zeroes both words). Compiled with the core's flags (see
// link-linkbus2.ps1).

#include "types.h"
#include "cfg/option.h"
#include "network/linkbus.h"
#include "hw/naomi/naomi.h"
#include "hw/naomi/naomi_regs.h"
#include <emscripten.h>

extern "C" EMSCRIPTEN_KEEPALIVE void shim_lb_configure(int boardId, int networkEnable,
		int actAsServer, int multiboardSlaves)
{
	config::NetworkEnable.override(networkEnable != 0);
	config::ActAsServer.override(actAsServer != 0);
	config::MultiboardSlaves.override(multiboardSlaves);
	linkbus::setMultiboardBoardId(boardId);
	if (boardId != 0)
	{
		settings.naomi.multiboard = true;
		settings.naomi.slave = true;
	}
}

// out[0] = comm_status1, out[1] = comm_status2, out[2] = BoardId,
// out[3] = NetworkEnable, out[4] = ActAsServer, out[5] = MultiboardSlaves,
// out[6] = settings.naomi.multiboard, out[7] = settings.naomi.slave.
extern "C" EMSCRIPTEN_KEEPALIVE int shim_lb_status(u32 *out)
{
	out[0] = ReadMem_naomi(NAOMI_COMM_STATUS1_addr, 2) & 0xffff;
	out[1] = ReadMem_naomi(NAOMI_COMM_STATUS2_addr, 2) & 0xffff;
	out[2] = (u32)linkbus::multiboardBoardId();
	out[3] = config::NetworkEnable ? 1 : 0;
	out[4] = config::ActAsServer ? 1 : 0;
	out[5] = (u32)(int)config::MultiboardSlaves;
	out[6] = settings.naomi.multiboard ? 1 : 0;
	out[7] = settings.naomi.slave ? 1 : 0;
	return 8;
}
