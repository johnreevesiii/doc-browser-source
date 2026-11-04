/*
 * libretro_shim.c: the C half of the DOC thin libretro host (PLAN_V2 2.3).
 *
 * Copyright (C) 2026 John R Reeves III
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * What it does
 * ------------
 * Implements the libretro frontend callbacks for the Flycast core, so the
 * page talks to the libretro API directly (no RetroArch):
 *
 *   environment  system and save directories, core options handed in from
 *                JS, log interface, hardware render (GLES3 on WebGL2)
 *   video        hardware frames; the core draws into the default
 *                framebuffer of the WebGL2 context made here, and the
 *                browser presents it when the animation frame ends
 *   audio        the core has its own AudioWorklet sink; samples that
 *                reach audio_batch_cb (fallback) go to Module.onAudioBatch
 *   input        one 16 bit joypad mask per port, set from JS
 *
 * JS drives it through the exported shim_* functions (see core-bridge.js).
 * No network code. Nothing ROM-derived is kept here.
 */

#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <emscripten.h>
#include <emscripten/html5.h>
#include <emscripten/html5_webgl.h>

#include "libretro.h"

#define SHIM_MAX_PORTS 4
#define SHIM_MAX_OPTIONS 160

struct shim_option {
	char *key;
	char *value;
};

static struct shim_option options[SHIM_MAX_OPTIONS];
static int option_count;
static bool options_dirty = true;

static char system_dir[512] = "/home/web_user/retroarch/system";
static char save_dir[512] = "/home/web_user/retroarch/saves";

static struct retro_hw_render_callback hw_render;
static bool hw_render_set;
static EMSCRIPTEN_WEBGL_CONTEXT_HANDLE gl_context;

static uint16_t joypad[SHIM_MAX_PORTS];

static uint32_t frames_total;
static uint32_t frames_valid;
static uint32_t frames_dupe;
static uint32_t audio_frames;
static unsigned last_width;
static unsigned last_height;
static double av_fps;
static double av_sample_rate;
static unsigned rotation;
static bool shutdown_requested;
static bool game_loaded;
static bool gl_preserve;
/* Lockstep (determinism probe): report fast-forward to the core, so the
 * wasm build's wall-clock pacer in retro_run always runs exactly one
 * emu.render() per call. Off by default; the normal page never sets it. */
static bool lockstep;

/* ------------------------------------------------------------ JS hooks */

EM_JS(void, shim_js_log, (int level, const char *msg), {
	var text = UTF8ToString(msg);
	if (Module.onCoreLog) Module.onCoreLog(level, text);
	else if (level >= 3) console.error(text);
	else console.log(text);
});

EM_JS(void, shim_js_frame, (int valid, unsigned w, unsigned h), {
	if (Module.onRetroFrame) Module.onRetroFrame(valid, w, h);
});

EM_JS(void, shim_js_audio, (const int16_t *data, unsigned frames), {
	if (Module.onAudioBatch) Module.onAudioBatch(data, frames);
});

/* ------------------------------------------------------------ logging */

static void shim_log(enum retro_log_level level, const char *fmt, ...)
{
	char buf[2048];
	va_list ap;
	va_start(ap, fmt);
	vsnprintf(buf, sizeof(buf), fmt, ap);
	va_end(ap);
	size_t n = strlen(buf);
	while (n > 0 && (buf[n - 1] == '\n' || buf[n - 1] == '\r'))
		buf[--n] = '\0';
	shim_js_log((int)level, buf);
}

/* ------------------------------------------------------------ options */

static const char *option_get(const char *key)
{
	for (int i = 0; i < option_count; i++)
		if (strcmp(options[i].key, key) == 0)
			return options[i].value;
	return NULL;
}

EMSCRIPTEN_KEEPALIVE int shim_set_option(const char *key, const char *value)
{
	if (!key || !value)
		return 0;
	for (int i = 0; i < option_count; i++) {
		if (strcmp(options[i].key, key) == 0) {
			if (strcmp(options[i].value, value) != 0) {
				free(options[i].value);
				options[i].value = strdup(value);
				options_dirty = true;
			}
			return 1;
		}
	}
	if (option_count >= SHIM_MAX_OPTIONS)
		return 0;
	options[option_count].key = strdup(key);
	options[option_count].value = strdup(value);
	option_count++;
	options_dirty = true;
	return 1;
}

EMSCRIPTEN_KEEPALIVE void shim_set_dirs(const char *sys, const char *save)
{
	if (sys)
		snprintf(system_dir, sizeof(system_dir), "%s", sys);
	if (save)
		snprintf(save_dir, sizeof(save_dir), "%s", save);
}

/* ------------------------------------------------------------ video */

static uintptr_t get_current_framebuffer(void)
{
	return 0; /* default framebuffer of the canvas context */
}

static retro_proc_address_t get_proc_address(const char *sym)
{
	return (retro_proc_address_t)emscripten_webgl_get_proc_address(sym);
}

static void video_refresh(const void *data, unsigned width, unsigned height, size_t pitch)
{
	(void)pitch;
	frames_total++;
	int valid = data == RETRO_HW_FRAME_BUFFER_VALID;
	if (valid)
		frames_valid++;
	else
		frames_dupe++;
	if (width && height) {
		last_width = width;
		last_height = height;
	}
	shim_js_frame(valid, width, height);
}

/* ------------------------------------------------------------ audio */

static void audio_sample(int16_t left, int16_t right)
{
	int16_t frame[2] = { left, right };
	audio_frames++;
	shim_js_audio(frame, 1);
}

static size_t audio_sample_batch(const int16_t *data, size_t frames)
{
	audio_frames += (uint32_t)frames;
	shim_js_audio(data, (unsigned)frames);
	return frames;
}

/* ------------------------------------------------------------ input */

static void input_poll(void)
{
}

static int16_t input_state(unsigned port, unsigned device, unsigned index, unsigned id)
{
	(void)index;
	if (port >= SHIM_MAX_PORTS || (device & RETRO_DEVICE_MASK) != RETRO_DEVICE_JOYPAD)
		return 0;
	if (id == RETRO_DEVICE_ID_JOYPAD_MASK)
		return (int16_t)joypad[port];
	if (id < 16)
		return (joypad[port] >> id) & 1;
	return 0;
}

EMSCRIPTEN_KEEPALIVE void shim_set_input(unsigned port, unsigned mask)
{
	if (port < SHIM_MAX_PORTS)
		joypad[port] = (uint16_t)mask;
}

/* ------------------------------------------------------------ environment */

static bool environment(unsigned cmd, void *data)
{
	/* The switch strips the EXPERIMENTAL bit, so case labels for
	 * experimental commands must strip it too or they never match. */
	switch (cmd & ~(RETRO_ENVIRONMENT_EXPERIMENTAL | RETRO_ENVIRONMENT_PRIVATE)) {
	case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
		((struct retro_log_callback *)data)->log = shim_log;
		return true;
	case RETRO_ENVIRONMENT_GET_CAN_DUPE:
		*(bool *)data = true;
		return true;
	case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT: {
		enum retro_pixel_format f = *(const enum retro_pixel_format *)data;
		return f == RETRO_PIXEL_FORMAT_XRGB8888 || f == RETRO_PIXEL_FORMAT_RGB565;
	}
	case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
		*(const char **)data = system_dir;
		return true;
	case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:
		*(const char **)data = save_dir;
		return true;
	case RETRO_ENVIRONMENT_GET_CORE_ASSETS_DIRECTORY:
		*(const char **)data = system_dir;
		return true;
	case RETRO_ENVIRONMENT_GET_VARIABLE: {
		struct retro_variable *var = (struct retro_variable *)data;
		var->value = var->key ? option_get(var->key) : NULL;
		return var->value != NULL;
	}
	case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
		*(bool *)data = options_dirty;
		options_dirty = false;
		return true;
	case RETRO_ENVIRONMENT_SET_VARIABLES:
	case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_DISPLAY:
	case RETRO_ENVIRONMENT_SET_CONTROLLER_INFO:
	case RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME:
	case RETRO_ENVIRONMENT_SET_KEYBOARD_CALLBACK:
	case RETRO_ENVIRONMENT_SET_GEOMETRY:
	case RETRO_ENVIRONMENT_SET_SUBSYSTEM_INFO:
	case RETRO_ENVIRONMENT_SET_DISK_CONTROL_INTERFACE:
	case RETRO_ENVIRONMENT_SET_PERFORMANCE_LEVEL:
		return true;
	case RETRO_ENVIRONMENT_GET_INPUT_BITMASKS & ~RETRO_ENVIRONMENT_EXPERIMENTAL:
		return true;
	case RETRO_ENVIRONMENT_GET_PREFERRED_HW_RENDER:
		*(unsigned *)data = RETRO_HW_CONTEXT_OPENGLES3;
		return true;
	case RETRO_ENVIRONMENT_SET_HW_RENDER: {
		struct retro_hw_render_callback *cb = (struct retro_hw_render_callback *)data;
		if (cb->context_type != RETRO_HW_CONTEXT_OPENGLES2
				&& cb->context_type != RETRO_HW_CONTEXT_OPENGLES3
				&& cb->context_type != RETRO_HW_CONTEXT_OPENGLES_VERSION)
			return false;
		cb->get_current_framebuffer = get_current_framebuffer;
		cb->get_proc_address = get_proc_address;
		hw_render = *cb;
		hw_render_set = true;
		return true;
	}
	case RETRO_ENVIRONMENT_SET_ROTATION:
		rotation = *(const unsigned *)data & 3;
		return true;
	case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO: {
		const struct retro_system_av_info *av = (const struct retro_system_av_info *)data;
		av_fps = av->timing.fps;
		av_sample_rate = av->timing.sample_rate;
		return true;
	}
	case RETRO_ENVIRONMENT_SET_MESSAGE: {
		const struct retro_message *m = (const struct retro_message *)data;
		if (m && m->msg)
			shim_log(RETRO_LOG_WARN, "[core message] %s", m->msg);
		return true;
	}
	case RETRO_ENVIRONMENT_SET_MESSAGE_EXT: {
		const struct retro_message_ext *m = (const struct retro_message_ext *)data;
		if (m && m->msg)
			shim_log(RETRO_LOG_WARN, "[core message] %s", m->msg);
		return true;
	}
	case RETRO_ENVIRONMENT_GET_FASTFORWARDING & ~RETRO_ENVIRONMENT_EXPERIMENTAL:
		*(bool *)data = lockstep;
		return true;
	case RETRO_ENVIRONMENT_GET_LANGUAGE:
		*(unsigned *)data = RETRO_LANGUAGE_ENGLISH;
		return true;
	case RETRO_ENVIRONMENT_SHUTDOWN:
		shutdown_requested = true;
		shim_log(RETRO_LOG_ERROR, "[shim] core requested shutdown");
		return true;
	default:
		return false;
	}
}

/* ------------------------------------------------------------ lifecycle */

EMSCRIPTEN_KEEPALIVE int shim_init(void)
{
	retro_set_environment(environment);
	retro_set_video_refresh(video_refresh);
	retro_set_audio_sample(audio_sample);
	retro_set_audio_sample_batch(audio_sample_batch);
	retro_set_input_poll(input_poll);
	retro_set_input_state(input_state);
	retro_init();
	struct retro_system_info info;
	memset(&info, 0, sizeof(info));
	retro_get_system_info(&info);
	shim_log(RETRO_LOG_INFO, "[shim] core %s %s, api %u",
			info.library_name ? info.library_name : "?",
			info.library_version ? info.library_version : "?",
			retro_api_version());
	return 1;
}

static int make_gl_context(const char *canvas_selector)
{
	EmscriptenWebGLContextAttributes attr;
	emscripten_webgl_init_context_attributes(&attr);
	attr.alpha = false;
	attr.depth = true;
	attr.stencil = true;
	attr.antialias = false;
	attr.premultipliedAlpha = false;
	attr.preserveDrawingBuffer = gl_preserve;
	attr.powerPreference = EM_WEBGL_POWER_PREFERENCE_HIGH_PERFORMANCE;
	attr.majorVersion = 2;
	attr.minorVersion = 0;
	attr.enableExtensionsByDefault = true;
	gl_context = emscripten_webgl_create_context(canvas_selector, &attr);
	if (gl_context <= 0) {
		shim_log(RETRO_LOG_ERROR, "[shim] WebGL2 context failed on %s: %d", canvas_selector, (int)gl_context);
		return 0;
	}
	if (emscripten_webgl_make_context_current(gl_context) != EMSCRIPTEN_RESULT_SUCCESS) {
		shim_log(RETRO_LOG_ERROR, "[shim] make_context_current failed");
		return 0;
	}
	return 1;
}

/* Diagnostics: keep the drawing buffer so a screenshot taken between
 * frames shows the last frame instead of a cleared canvas. Set before
 * shim_load_game. Costs a little speed. */
EMSCRIPTEN_KEEPALIVE void shim_set_gl_preserve(int on)
{
	gl_preserve = on != 0;
}

/* Returns 1 on success, 0 when the core refuses the game, -1 when the GL
 * context cannot be made. */
EMSCRIPTEN_KEEPALIVE int shim_load_game(const char *path, const char *canvas_selector)
{
	struct retro_game_info game;
	memset(&game, 0, sizeof(game));
	game.path = path;
	/* The GL context must exist before the core's context_reset, and
	 * Flycast only asks for it inside retro_load_game. Make it first. */
	if (!gl_context && !make_gl_context(canvas_selector ? canvas_selector : "#screen"))
		return -1;
	if (!retro_load_game(path && path[0] ? &game : NULL)) {
		shim_log(RETRO_LOG_ERROR, "[shim] retro_load_game refused %s", path ? path : "(none)");
		return 0;
	}
	struct retro_system_av_info av;
	memset(&av, 0, sizeof(av));
	retro_get_system_av_info(&av);
	av_fps = av.timing.fps;
	av_sample_rate = av.timing.sample_rate;
	shim_log(RETRO_LOG_INFO, "[shim] loaded; base %ux%u, fps %.3f, rate %.0f, hw %d",
			av.geometry.base_width, av.geometry.base_height, av_fps, av_sample_rate,
			hw_render_set ? (int)hw_render.context_type : -1);
	if (hw_render_set && hw_render.context_reset)
		hw_render.context_reset();
	game_loaded = true;
	return 1;
}

EMSCRIPTEN_KEEPALIVE void shim_run_frame(void)
{
	if (!game_loaded || shutdown_requested)
		return;
	emscripten_webgl_make_context_current(gl_context);
	retro_run();
}

EMSCRIPTEN_KEEPALIVE void shim_reset(void)
{
	if (game_loaded)
		retro_reset();
}

EMSCRIPTEN_KEEPALIVE uint32_t shim_frames_total(void) { return frames_total; }
EMSCRIPTEN_KEEPALIVE uint32_t shim_frames_valid(void) { return frames_valid; }
EMSCRIPTEN_KEEPALIVE uint32_t shim_frames_dupe(void) { return frames_dupe; }
EMSCRIPTEN_KEEPALIVE uint32_t shim_audio_frames(void) { return audio_frames; }
EMSCRIPTEN_KEEPALIVE unsigned shim_fb_width(void) { return last_width; }
EMSCRIPTEN_KEEPALIVE unsigned shim_fb_height(void) { return last_height; }
EMSCRIPTEN_KEEPALIVE double shim_av_fps(void) { return av_fps; }
EMSCRIPTEN_KEEPALIVE unsigned shim_rotation(void) { return rotation; }
EMSCRIPTEN_KEEPALIVE int shim_shutdown_requested(void) { return shutdown_requested; }
EMSCRIPTEN_KEEPALIVE void shim_set_lockstep(int on) { lockstep = on != 0; }
