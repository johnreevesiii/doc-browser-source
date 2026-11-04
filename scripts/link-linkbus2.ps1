<#
.SYNOPSIS
  Links the doc-wasm/linkbus2 Flycast libretro library (deterministic JIT
  plus the LinkBus seam) with our host shim into a browser wasm module that
  can run in a worker, for the single-page five-board cabinet.

.DESCRIPTION
  Copyright (C) 2026 John R Reeves III
  SPDX-License-Identifier: GPL-2.0-or-later

  Inputs:
    <ExtRoot>/build-wasm/<tree>/libflycast_libretro_emscripten.a and its
      dependency libs (built by build-win.ps1)
    <ExtRoot>/wt-linkbus2       (Flycast source tree, for libretro-common headers)
    host/shim/*.c|cpp           (this repository: C and C++ halves of the host)
    stubs/flycast_stubs.c       (this repository: source for the 4 stub symbols;
                                 no prebuilt .o)

  A copy of link-win.ps1 (left unchanged for the single-board core) with:
  source tree <ExtRoot>/wt-linkbus2, build dir <ExtRoot>/build-wasm/wt-linkbus2,
  output <ExtRoot>/build-wasm/link-out-linkbus2, host/shim/linkbus_shim.cpp
  compiled in, the LinkBus and shim_lb_* exports, ENVIRONMENT web,worker (the
  boards run in module workers) and the specialHTMLTargets runtime export (the
  worker maps "#screen" to its OffscreenCanvas). Repository copy (2026-11-03)
  of the build PC's ext/link-linkbus2.ps1 with the same -ExtRoot parameter
  change as link-win.ps1; nothing else changed.

  Output: <ExtRoot>/build-wasm/link-out-linkbus2/flycast_libretro.js and .wasm, an ES6 module
  factory (MODULARIZE + EXPORT_ES6). It is kept in <ExtRoot>, outside this
  repository, so build output cannot be committed and the host tree policy
  tests (no binaries, no dashes) stay meaningful; the local server maps
  /core/ to this folder.

  Not used: EmulatorJS RetroArch objects, its JS libraries, gl_override.js and
  the bundled zlib. zlib comes from the emsdk port (-sUSE_ZLIB=1).

  Environment changes apply to this PowerShell process only. Nothing ROM
  derived is read or written. Logs go to <ExtRoot>/build-logs/.

.PARAMETER ExtRoot
  Working folder that holds emsdk, the Flycast source tree, the build folder
  and build-logs. Required: pass -ExtRoot or set the DOC_BUILD_EXT environment
  variable (on the build PC: C:/dev/doc-browser-build/ext). Never inside this
  Git repository, so build output cannot be committed.

.PARAMETER BuildDir
  Folder holding the static libraries. Must be inside ExtRoot.
  Default: <ExtRoot>/build-wasm/wt-linkbus2.

.PARAMETER Opt
  Optimisation level passed to emcc (default -O2).

.PARAMETER Assertions
  Emscripten ASSERTIONS level (default 0).

.PARAMETER RamMaskFix
  Obsolete since doc-wasm/8412d3d8a commit 3f5774aac, which emits RAM_MASK
  in the source; with that tree the switch finds no sites and stops.
  Experiment (2026-11-02): the rec-wasm emitter hardcoded the Dreamcast
  16 MB RAM mask (0x00FFFFFF) in its inline RAM fast paths, but NAOMI has
  32 MB (settings.platform.ram_mask = 0x01FFFFFF). With this switch a copy
  of core/rec-wasm is made under <ExtRoot>/build-wasm/ramfix-src with that constant
  replaced by RAM_MASK (read at code generation time), rec_wasm.cpp is
  compiled from the copy and linked ahead of the archive (so the archive's
  rec_wasm member is not used), and the output goes to
  <ExtRoot>/build-wasm/link-out-ramfix. The source tree is not touched; the proper
  fix belongs in the patch series.

.EXAMPLE
  powershell.exe -NoProfile -File scripts/link-linkbus2.ps1 -ExtRoot C:/dev/doc-browser-build/ext
#>
[CmdletBinding()]
param(
    [string]$ExtRoot = '',
    [string]$BuildDir = '',
    [string]$Opt = '-O2',
    [int]$Assertions = 0,
    [switch]$RamMaskFix
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

if ($ExtRoot -eq '') { $ExtRoot = $env:DOC_BUILD_EXT }
if ([string]::IsNullOrEmpty($ExtRoot)) {
    Write-Host 'link-win: ERROR: pass -ExtRoot <folder> or set DOC_BUILD_EXT' -ForegroundColor Red
    exit 1
}
$ExtRoot      = (Resolve-Path -LiteralPath $ExtRoot).Path
$RepoRoot     = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if (($ExtRoot.TrimEnd('\') + '\').StartsWith($RepoRoot.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    Write-Host "link-win: ERROR: ExtRoot must be outside the repository ($RepoRoot)" -ForegroundColor Red
    exit 1
}
$EmsdkVersion = '3.1.74'
$EmsdkRoot    = Join-Path $ExtRoot 'emsdk'
if ($BuildDir -eq '') { $BuildDir = Join-Path $ExtRoot 'build-wasm\wt-linkbus2' }
$BuildDir     = [System.IO.Path]::GetFullPath($BuildDir)
$OutDir       = Join-Path $ExtRoot 'build-wasm\link-out-linkbus2'
if ($RamMaskFix) { Write-Host 'link-linkbus2: -RamMaskFix is not supported' -ForegroundColor Red; exit 1 }
$SrcTree      = Join-Path $ExtRoot 'wt-linkbus2'

function Fail([string]$msg) {
    Write-Host "link-win: ERROR: $msg" -ForegroundColor Red
    exit 1
}
if (-not $BuildDir.StartsWith($ExtRoot.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    Fail "BuildDir must be inside $ExtRoot"
}

$Stamp   = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$LogDir  = Join-Path $ExtRoot 'build-logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$LogFile = Join-Path $LogDir "link-linkbus2-$Stamp.log"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Log([string]$line) {
    Write-Host $line
    [System.IO.File]::AppendAllText($LogFile, $line + [Environment]::NewLine, $Utf8NoBom)
}

# ---------------------------------------------------------------- toolchain
$VersionFile = Join-Path $EmsdkRoot 'upstream\emscripten\emscripten-version.txt'
if (-not (Test-Path -LiteralPath $VersionFile)) { Fail "emsdk not found at $EmsdkRoot" }
$EmVer = (Get-Content -LiteralPath $VersionFile -Raw).Trim().Trim('"')
if ($EmVer -ne $EmsdkVersion) { Fail "emsdk is $EmVer, expected $EmsdkVersion" }
$EmscriptenDir = Join-Path $EmsdkRoot 'upstream\emscripten'
$PythonExe = @(Get-ChildItem -LiteralPath (Join-Path $EmsdkRoot 'python') -Recurse -Filter 'python.exe' | Select-Object -First 1)[0].FullName
$NodeExe   = @(Get-ChildItem -LiteralPath (Join-Path $EmsdkRoot 'node') -Recurse -Filter 'node.exe' | Select-Object -First 1)[0].FullName
$env:EMSDK        = $EmsdkRoot
$env:EM_CONFIG    = Join-Path $EmsdkRoot '.emscripten'
$env:EMSDK_PYTHON = $PythonExe
$env:EMSDK_NODE   = $NodeExe
$env:PATH = (@($EmscriptenDir, (Split-Path -Parent $NodeExe), (Join-Path $EmsdkRoot 'upstream\bin'), $EmsdkRoot) -join ';') + ';' + $env:PATH
$Emcc = Join-Path $EmscriptenDir 'emcc.bat'

# ---------------------------------------------------------------- inputs
$Libs = @(
    'libflycast_libretro_emscripten.a',
    'libflycast-resources.a',
    'core\deps\tinygettext\libtinygettext.a',
    'core\deps\nowide\libnowide.a',
    'core\deps\libchdr\libchdr-static.a',
    'core\deps\libchdr\deps\lzma-24.05\liblzma.a',
    'core\deps\libchdr\deps\zstd-1.5.6\build\cmake\lib\libzstd.a',
    'core\deps\xxHash\cmake_unofficial\libxxhash.a',
    'core\deps\libzip\lib\libzip.a',
    'core\deps\libelf\libelf.a',
    'core\deps\miniupnpc\libminiupnpc.a'
) | ForEach-Object { Join-Path $BuildDir $_ }
foreach ($l in $Libs) { if (-not (Test-Path -LiteralPath $l)) { Fail "missing $l" } }

$Shim  = Join-Path $RepoRoot 'host\shim\libretro_shim.c'
$Stubs = Join-Path $RepoRoot 'stubs\flycast_stubs.c'
$DbgShim = Join-Path $RepoRoot 'host\shim\debug_state_shim.cpp'
$LrInc = Join-Path $SrcTree 'core\deps\libretro-common\include'
$CfgShim = Join-Path $RepoRoot 'host\shim\core_config_shim.cpp'
$LbShim = Join-Path $RepoRoot 'host\shim\linkbus_shim.cpp'
foreach ($p in @($Shim, $Stubs, $DbgShim, $CfgShim, $LbShim, $LrInc)) { if (-not (Test-Path -LiteralPath $p)) { Fail "missing $p" } }

# core_config_shim.cpp includes Flycast headers, so it is compiled with the
# core's own DEFINES, FLAGS and INCLUDES, read from build.ninja.
$Ninja = Get-Content -LiteralPath (Join-Path $BuildDir 'build.ninja')
$i = [Array]::FindIndex($Ninja, [Predicate[string]]{ param($l) $l -like 'build CMakeFiles/flycast_libretro.dir/core/emulator.cpp.o:*' })
if ($i -lt 0) { Fail 'emulator.cpp rule not found in build.ninja' }
$CoreFlags = @()
foreach ($l in $Ninja[($i + 1)..($i + 6)]) {
    if ($l -match '^\s+(DEFINES|FLAGS|INCLUDES) = (.*)$') {
        $CoreFlags += ($Matches[2] -replace '\\"', '"' -split ' ' | Where-Object { $_ -ne '' -and $_ -notlike '-DFLYCAST_*' -and $_ -ne '-Wall' })
    }
}
$CfgObj = Join-Path $OutDir 'core_config_shim.o'
$CcArgs = @('-c', $CfgShim, '-o', $CfgObj) + $CoreFlags
# debug_state_shim.cpp (determinism probe hashes) needs the same flags.
$DbgObj = Join-Path $OutDir 'debug_state_shim.o'
$DbgArgs = @('-c', $DbgShim, '-o', $DbgObj) + $CoreFlags
# linkbus_shim.cpp (board settings, comm status) needs the same flags.
$LbObj = Join-Path $OutDir 'linkbus_shim.o'
$LbArgs = @('-c', $LbShim, '-o', $LbObj) + $CoreFlags

$ExtraObjs = @()
if ($RamMaskFix) {
    $FixRoot = Join-Path $ExtRoot 'build-wasm\ramfix-src\core\rec-wasm'
    New-Item -ItemType Directory -Force -Path $FixRoot | Out-Null
    Copy-Item -Path (Join-Path $SrcTree 'core\rec-wasm\*') -Destination $FixRoot -Force
    $Emit = Join-Path $FixRoot 'wasm_emit.h'
    $Text = [System.IO.File]::ReadAllText($Emit)
    $Count = ([regex]::Matches($Text, 'b\.op_i32_const\(0x00FFFFFF\);')).Count
    $Text = $Text.Replace('b.op_i32_const(0x00FFFFFF);', 'b.op_i32_const((s32)RAM_MASK);')
    [System.IO.File]::WriteAllText($Emit, $Text, $Utf8NoBom)
    Log "RamMaskFix: replaced $Count hardcoded 0x00FFFFFF masks in $Emit"
    if ($Count -eq 0) { Fail 'RamMaskFix: no mask sites found' }
    $FixObj = Join-Path $OutDir 'rec_wasm_ramfix.o'
    $FixArgs = @('-c', (Join-Path $FixRoot 'rec_wasm.cpp'), '-o', $FixObj) + $CoreFlags
    Log ("> emcc " + ($FixArgs -join ' '))
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & (Join-Path $EmscriptenDir 'emcc.bat') @FixArgs 2>&1 | ForEach-Object { Log ("$_") }
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $prev }
    if ($code -ne 0) { Fail "RamMaskFix compile failed (exit $code)" }
    $ExtraObjs += $FixObj
}

# Functions the page and the JIT's EM_JS glue call through Module._name.
$Exports = @(
    '_malloc', '_free',
    '_shim_init', '_shim_set_option', '_shim_set_dirs', '_shim_load_game', '_shim_run_frame',
    '_shim_reset', '_shim_set_input', '_shim_frames_total', '_shim_frames_valid',
    '_shim_frames_dupe', '_shim_audio_frames', '_shim_fb_width', '_shim_fb_height',
    '_shim_av_fps', '_shim_rotation', '_shim_shutdown_requested', '_shim_set_gl_preserve',
    '_shim_set_dynarec', '_shim_get_dynarec', '_shim_set_lockstep',
    '_shim_dbg_pin_time', '_shim_dbg_reg_words', '_shim_dbg_regs',
    '_shim_dbg_state_hash', '_shim_dbg_ram_chunks', '_shim_dbg_ram_word', '_shim_dbg_set_jit_det',
    '_wasm_mem_read8', '_wasm_mem_read16', '_wasm_mem_read32',
    '_wasm_mem_write8', '_wasm_mem_write16', '_wasm_mem_write32',
    '_wasm_exec_ifb', '_wasm_exec_shil_fb', '_wasm_sq_pref',
    '_wasm_div32u', '_wasm_div32s', '_wasm_div1',
    '_fly_jit_selftest', '_fly_test_clock_jitter', '_fly_test_bridge_charge',
    '_shim_lb_configure', '_shim_lb_status',
    '_linkbus_install_mailbox', '_linkbus_uninstall_ring',
    '_linkbus_install_sab_multiboard', '_linkbus_install_sab_multiboard_snapshot', '_linkbus_sab_snapshot_bytes', '_linkbus_mb_stats', '_linkbus_install_vblank_barrier', '_linkbus_pacer_frames', '_linkbus_pacer_frame_run',
    '_linkbus_stats', '_linkbus_ring_stats'
) -join ','
$Runtime = @('FS', 'ccall', 'cwrap', 'UTF8ToString', 'stringToUTF8', 'lengthBytesUTF8',
    'HEAPU8', 'HEAP16', 'HEAPU16', 'HEAP32', 'HEAPU32', 'HEAPF32', 'specialHTMLTargets') -join ','

$OutJs = Join-Path $OutDir 'flycast_libretro.js'
$EmArgs = @(
    $Opt,
    "-I$LrInc",
    $Shim, $Stubs, $CfgObj, $DbgObj, $LbObj
) + $ExtraObjs + $Libs + @(
    '-sWASM=1', '-sWASM_BIGINT=1',
    '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sEXPORT_NAME=createFlycastCore',
    '-sENVIRONMENT=web,worker',
    "-sEXPORTED_FUNCTIONS=$Exports",
    "-sEXPORTED_RUNTIME_METHODS=$Runtime",
    '-sINITIAL_MEMORY=268435456', '-sALLOW_MEMORY_GROWTH=1', '-sALLOW_TABLE_GROWTH=1',
    '-sSTACK_SIZE=4194304',
    '-sEXIT_RUNTIME=0', '-sFORCE_FILESYSTEM=1',
    "-sASSERTIONS=$Assertions",
    '-sDISABLE_EXCEPTION_CATCHING=0', '-fexceptions',
    '-sUSE_ZLIB=1',
    '-sFULL_ES3=1', '-sMIN_WEBGL_VERSION=2', '-sMAX_WEBGL_VERSION=2',
    '-sGL_ENABLE_GET_PROC_ADDRESS=1',
    '-Wl,--wrap=glGetString',
    '-Wl,--wrap=time',
    '-o', $OutJs
)

Log "link-linkbus2.ps1 utc=$Stamp emcc=$EmVer"
Log ("> emcc " + ($CcArgs -join ' '))
$prev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    & $Emcc @CcArgs 2>&1 | ForEach-Object { Log ("$_") }
    $code = $LASTEXITCODE
} finally { $ErrorActionPreference = $prev }
if ($code -ne 0) { Fail "compile of core_config_shim.cpp failed (exit $code); see $LogFile" }

Log ("> emcc " + ($DbgArgs -join ' '))
$prev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    & $Emcc @DbgArgs 2>&1 | ForEach-Object { Log ("$_") }
    $code = $LASTEXITCODE
} finally { $ErrorActionPreference = $prev }
if ($code -ne 0) { Fail "compile of debug_state_shim.cpp failed (exit $code); see $LogFile" }

Log ("> emcc " + ($LbArgs -join ' '))
$prev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    & $Emcc @LbArgs 2>&1 | ForEach-Object { Log ("$_") }
    $code = $LASTEXITCODE
} finally { $ErrorActionPreference = $prev }
if ($code -ne 0) { Fail "compile of linkbus_shim.cpp failed (exit $code); see $LogFile" }

Log ("> emcc " + ($EmArgs -join ' '))
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$prev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    & $Emcc @EmArgs 2>&1 | ForEach-Object { Log ("$_") }
    $code = $LASTEXITCODE
} finally { $ErrorActionPreference = $prev }
$sw.Stop()
Log ("exit=$code seconds=" + [int]$sw.Elapsed.TotalSeconds)
if ($code -ne 0) { Fail "emcc failed (exit $code); see $LogFile" }

$Wasm = Join-Path $OutDir 'flycast_libretro.wasm'
foreach ($f in @($OutJs, $Wasm)) {
    $h = (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLower()
    $s = (Get-Item -LiteralPath $f).Length
    Log "output $f bytes=$s sha256=$h"
}
Log "log: $LogFile"
