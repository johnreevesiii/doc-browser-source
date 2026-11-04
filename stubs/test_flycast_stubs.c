/*
 * test_flycast_stubs.c: host-native test for the path helpers and the
 * glGetString wrapper in flycast_stubs.c. GPL-2.0-or-later.
 *
 * Not run yet: this PC has no native C compiler, and Emscripten builds
 * wait for John's build permission (PLAN_V2 2.2). To run later:
 *     cc -o test_flycast_stubs test_flycast_stubs.c flycast_stubs.c
 *     ./test_flycast_stubs
 * Exit code 0 means every check passed.
 */

#include <stdio.h>
#include <string.h>

typedef unsigned int stub_glenum;
typedef unsigned char stub_glubyte;

void fill_short_pathname_representation(char *out_rep, const char *in_path,
		size_t size);
void fill_short_pathname_representation_noext(char *out_rep,
		const char *in_path, size_t size);
const stub_glubyte *__wrap_glGetString(stub_glenum name);
void bm_Reset(void);

/* Fake for the linker-provided original. */
static const char real_vendor[] = "real";
const stub_glubyte *__real_glGetString(stub_glenum name)
{
	(void)name;
	return (const stub_glubyte *)real_vendor;
}

static int failures;

static void expect_str(const char *what, const char *got, const char *want)
{
	if (strcmp(got, want) != 0) {
		printf("FAIL %s: got '%s' want '%s'\n", what, got, want);
		failures++;
	}
}

int main(void)
{
	char buf[16];

	fill_short_pathname_representation(buf, "/roms/naomi/game.zip", sizeof buf);
	expect_str("basename slash", buf, "game.zip");
	fill_short_pathname_representation(buf, "C:\\roms\\game.zip", sizeof buf);
	expect_str("basename backslash", buf, "game.zip");
	fill_short_pathname_representation(buf, "plain.bin", sizeof buf);
	expect_str("no separator", buf, "plain.bin");
	fill_short_pathname_representation(buf, "/a/averyveryverylongname.zip", 8);
	expect_str("truncate", buf, "averyve");
	fill_short_pathname_representation(buf, NULL, sizeof buf);
	expect_str("null path", buf, "");

	fill_short_pathname_representation_noext(buf, "/roms/game.zip", sizeof buf);
	expect_str("noext", buf, "game");
	fill_short_pathname_representation_noext(buf, "/roms/a.b.zip", sizeof buf);
	expect_str("noext last dot only", buf, "a.b");
	fill_short_pathname_representation_noext(buf, "/roms/.hidden", sizeof buf);
	expect_str("noext leading dot kept", buf, ".hidden");

	expect_str("GL_VERSION", (const char *)__wrap_glGetString(0x1F02u),
			"OpenGL ES 3.0 WebGL 2.0");
	expect_str("GLSL", (const char *)__wrap_glGetString(0x8B8Cu),
			"OpenGL ES GLSL ES 3.00");
	expect_str("passthrough", (const char *)__wrap_glGetString(0x1F00u), "real");

	bm_Reset();

	if (failures == 0)
		printf("OK all stub checks passed\n");
	return failures == 0 ? 0 : 1;
}
