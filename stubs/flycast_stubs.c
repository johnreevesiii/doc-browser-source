/*
 * flycast_stubs.c: source replacement for flycast-wasm build/flycast_stubs.o
 *
 * Copyright (C) 2026 John R Reeves III
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
 * Why this file exists
 * --------------------
 * flycast-wasm (16e9c7b) ships build/flycast_stubs.o, a 5508 byte LLVM
 * bitcode object compiled from "EJS-RetroArch/flycast_stubs.c" with no
 * source in the repository. To keep our GPL source offer complete
 * (PLAN_V2 2.1, PIVOT_MEMO section 5) we rewrite it here from its
 * symbol table. llvm-nm on the prebuilt object reports:
 *
 *     defined:   __wrap_glGetString
 *                bm_Reset
 *                fill_short_pathname_representation
 *                fill_short_pathname_representation_noext
 *     undefined: __real_glGetString, strncpy, strrchr
 *
 * The bodies below are written from that symbol table, the link flags
 * in flycast-wasm build-prod.sh (-Wl,--wrap=glGetString) and the
 * historic libretro-common semantics of the two path helpers. They are
 * NOT a decompilation of the prebuilt object; the two string constants
 * in the object (.str, .str.1) are inferred to be the GL_VERSION and
 * GL_SHADING_LANGUAGE_VERSION overrides, matching build/gl_override.js.
 * Equivalence with the prebuilt object has not been tested (no build is
 * permitted yet; see PLAN_V2 2.2).
 *
 * Build: compile as C with emcc and pass the object where build-prod.sh
 * passes $STUBS. Requires -Wl,--wrap=glGetString on the final link,
 * which build-prod.sh already sets.
 */

#include <stddef.h>
#include <string.h>

/* Keep this file free of GL headers so it builds without the GL include
 * path; these are the two GLenum values from the GLES 3.0 spec. */
typedef unsigned int stub_glenum;
typedef unsigned char stub_glubyte;

#define STUB_GL_VERSION                  0x1F02u
#define STUB_GL_SHADING_LANGUAGE_VERSION 0x8B8Cu

/* Version strings in desktop GLES form. WebGL2 reports
 * "WebGL 2.0 (OpenGL ES 3.0 ...)", which Flycast's GL version parser
 * does not read as GLES 3.0. These must stay identical to the strings
 * in build/gl_override.js so the C and JS paths agree. */
static const char stub_gl_version[] = "OpenGL ES 3.0 WebGL 2.0";
static const char stub_glsl_version[] = "OpenGL ES GLSL ES 3.00";

/* Provided by the linker when -Wl,--wrap=glGetString is used: it is the
 * original (Emscripten library) glGetString. */
extern const stub_glubyte *__real_glGetString(stub_glenum name);

/*
 * __wrap_glGetString: every call to glGetString in the linked program is
 * redirected here. Version queries get fixed GLES strings; every other
 * query (vendor, renderer, extensions) goes to the real implementation.
 */
const stub_glubyte *__wrap_glGetString(stub_glenum name)
{
	if (name == STUB_GL_VERSION)
		return (const stub_glubyte *)stub_gl_version;
	if (name == STUB_GL_SHADING_LANGUAGE_VERSION)
		return (const stub_glubyte *)stub_glsl_version;
	return __real_glGetString(name);
}

/*
 * bm_Reset: C linkage no-op.
 *
 * Flycast's own block manager defines bm_Reset() with C++ linkage
 * (core/hw/sh4/dyna/blockmanager.cpp, mangled _Z8bm_Resetv), so this
 * unmangled symbol does not collide with it. It only satisfies an
 * unmangled reference from the EmulatorJS RetroArch objects that
 * build-prod.sh links. Inferred, not confirmed: the EJS tree is not
 * present locally. With our own host page (PLAN_V2 2.3) that link may
 * no longer need it; keep it until W2's link proves otherwise.
 */
void bm_Reset(void)
{
}

/*
 * fill_short_pathname_representation: copy the last path component of
 * in_path into out_rep, truncated to size - 1 bytes and always NUL
 * terminated when size > 0. Accepts both '/' and '\\' separators.
 *
 * These two helpers were removed from newer libretro-common. build-prod.sh
 * strips Flycast's file_path.c.o in favour of RetroArch's copy, which no
 * longer defines them, so the stub provides them.
 */
static const char *stub_path_basename(const char *in_path)
{
	const char *slash = strrchr(in_path, '/');
	const char *backslash = strrchr(in_path, '\\');
	const char *last = slash;

	if (backslash && (!last || backslash > last))
		last = backslash;
	return last ? last + 1 : in_path;
}

void fill_short_pathname_representation(char *out_rep, const char *in_path,
		size_t size)
{
	if (!out_rep || size == 0)
		return;
	if (!in_path) {
		out_rep[0] = '\0';
		return;
	}
	strncpy(out_rep, stub_path_basename(in_path), size - 1);
	out_rep[size - 1] = '\0';
}

/*
 * fill_short_pathname_representation_noext: as above, then drop the last
 * extension ("game.zip" becomes "game"). A leading dot (".hidden") is a
 * name, not an extension, and is kept.
 */
void fill_short_pathname_representation_noext(char *out_rep,
		const char *in_path, size_t size)
{
	char *dot;

	fill_short_pathname_representation(out_rep, in_path, size);
	if (!out_rep || size == 0)
		return;
	dot = strrchr(out_rep, '.');
	if (dot && dot != out_rep)
		*dot = '\0';
}
