// core_config_shim.cpp: host-side switches for Flycast settings that the
// libretro build does not expose as core options (PLAN_V2 2.3/2.4).
//
// Copyright (C) 2026 John R Reeves III
// SPDX-License-Identifier: GPL-2.0-or-later
//
// The native lab rig runs with Dynarec.Enabled = no (interpreter). In the
// libretro build DynarecEnabled has no option name, so the only way to pick
// the interpreter for an A/B check against the wasm JIT is to override it
// from the host before retro_load_game. Compiled with the same include and
// define set as the core (see link-win.ps1).

#include "types.h"
#include "cfg/option.h"
#include <emscripten.h>

extern "C" EMSCRIPTEN_KEEPALIVE void shim_set_dynarec(int on)
{
	config::DynarecEnabled.override(on != 0);
}

extern "C" EMSCRIPTEN_KEEPALIVE int shim_get_dynarec(void)
{
	return config::DynarecEnabled ? 1 : 0;
}
