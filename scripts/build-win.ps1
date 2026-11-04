<#
.SYNOPSIS
  Windows build of the Flycast libretro core for Emscripten (PLAN_V2 item 2.2, work item W2).

.DESCRIPTION
  Configures and builds the static library libflycast_libretro_emscripten.a from a
  Flycast tree that already carries the rebased flycast-wasm patch (W1 output).
  It does NOT link a final .wasm: the EmulatorJS RetroArch link step of
  flycast-wasm/build-prod.sh is replaced later by our own host page (PLAN_V2 2.3).

  Toolchain (all per-user, no elevation):
    emsdk 3.1.74        <ExtRoot>/emsdk
    cmake, ninja        pip --user (%APPDATA%/Python/Python313/Scripts)

  Environment changes (PATH, EMSDK, EM_CONFIG, EMSDK_PYTHON, EMSDK_NODE) apply to
  this PowerShell process only. Nothing is written to the user or machine
  environment, the registry, or any setting outside the ext folder.

  Every run writes a log and a provenance file to <ExtRoot>/build-logs/ (outside Git).
  Nothing ROM-derived is read or written by this script.

.PARAMETER ExtRoot
  Working folder that holds emsdk, the Flycast source tree, the build folder and
  build-logs. Required: pass -ExtRoot or set the DOC_BUILD_EXT environment
  variable (on the build PC: C:/dev/doc-browser-build/ext). Never inside this Git
  repository, so build output cannot be committed.

.PARAMETER SourceDir
  Flycast source tree. Must be inside ExtRoot. Default: <ExtRoot>/wt-8412d3d8a.

.PARAMETER BuildDir
  CMake build directory. Must be inside ExtRoot. Default: <ExtRoot>/build-wasm/<source leaf>.

.PARAMETER ConfigureOnly
  Run the CMake configure step and stop.

.PARAMETER DryRun
  Resolve tools, run preflight checks and print the exact commands. Runs no
  configure and no build (only tool --version queries and read-only git queries).

.PARAMETER InitSubmodules
  Run "git submodule update --init --recursive" in SourceDir first (a git
  download). Off by default because W1 owns the worktree.

.EXAMPLE
  powershell.exe -NoProfile -File scripts/build-win.ps1 -ExtRoot C:/dev/doc-browser-build/ext
#>
[CmdletBinding()]
param(
    [string]$ExtRoot = '',
    [string]$SourceDir = '',
    [string]$BuildDir = '',
    [switch]$ConfigureOnly,
    [switch]$DryRun,
    [switch]$InitSubmodules
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- constants
if ($ExtRoot -eq '') { $ExtRoot = $env:DOC_BUILD_EXT }
if ([string]::IsNullOrEmpty($ExtRoot)) {
    Write-Host 'build-win: ERROR: pass -ExtRoot <folder> or set DOC_BUILD_EXT' -ForegroundColor Red
    exit 1
}
$ExtRoot        = (Resolve-Path -LiteralPath $ExtRoot).Path
$RepoRoot       = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if (($ExtRoot.TrimEnd('\') + '\').StartsWith($RepoRoot.TrimEnd('\') + '\',[System.StringComparison]::OrdinalIgnoreCase)) {
    Write-Host "build-win: ERROR: ExtRoot must be outside the repository ($RepoRoot)" -ForegroundColor Red
    exit 1
}
$EmsdkVersion   = '3.1.74'
$EmsdkRoot      = Join-Path $ExtRoot 'emsdk'
$PyUserScripts  = Join-Path $env:APPDATA 'Python\Python313\Scripts'
$JitFlags       = '-DJIT_PROD_BUILD=1 -DFLY_RELEASE_BUILD=1'
$ExpectedLib    = 'libflycast_libretro_emscripten.a'

if ($SourceDir -eq '') { $SourceDir = Join-Path $ExtRoot 'wt-8412d3d8a' }

function Fail([string]$msg) {
    Write-Host "build-win: ERROR: $msg" -ForegroundColor Red
    exit 1
}

function Assert-InsideExt([string]$path, [string]$what) {
    $full = [System.IO.Path]::GetFullPath($path)
    $root = $ExtRoot.TrimEnd('\') + '\'
    if (-not $full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
        Fail "$what must be inside $ExtRoot (got $full)"
    }
    return $full
}

$SourceDir = Assert-InsideExt $SourceDir 'SourceDir'
if ($BuildDir -eq '') { $BuildDir = Join-Path (Join-Path $ExtRoot 'build-wasm') (Split-Path -Leaf $SourceDir) }
$BuildDir = Assert-InsideExt $BuildDir 'BuildDir'
if ($BuildDir.TrimEnd('\') -eq $SourceDir.TrimEnd('\')) { Fail 'BuildDir must differ from SourceDir' }

# ---------------------------------------------------------------- logging
$Stamp   = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$LogDir  = Join-Path $ExtRoot 'build-logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Mode    = 'build'
if ($ConfigureOnly) { $Mode = 'configure' }
if ($DryRun) { $Mode = 'dryrun' }
$LogFile = Join-Path $LogDir "build-win-$Stamp-$Mode.log"
$ProvFile = Join-Path $LogDir "provenance-$Stamp-$Mode.json"

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Log([string]$line) {
    Write-Host $line
    [System.IO.File]::AppendAllText($LogFile, $line + [Environment]::NewLine, $Utf8NoBom)
}

# Runs a native command, tees stdout and stderr to the log, returns exit code.
function Invoke-Logged([string]$exe, [string[]]$argv) {
    Log ("> `"$exe`" " + (($argv | ForEach-Object { if ($_ -match '\s') { "`"$_`"" } else { $_ } }) -join ' '))
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $exe @argv 2>&1 | ForEach-Object { Log ("$_") }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }
    return $code
}

# Runs a native command and returns its first output line (for version queries).
function Get-FirstLine([string]$exe, [string[]]$argv) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $out = & $exe @argv 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $prev }
    if ($null -eq $out) { return '' }
    return (@($out)[0]).Trim()
}

Log "build-win.ps1 mode=$Mode utc=$Stamp"
Log "ExtRoot=$ExtRoot"
Log "SourceDir=$SourceDir"
Log "BuildDir=$BuildDir"

# ---------------------------------------------------------------- toolchain
$VersionFile = Join-Path $EmsdkRoot 'upstream\emscripten\emscripten-version.txt'
if (-not (Test-Path -LiteralPath $VersionFile)) { Fail "emsdk not found at $EmsdkRoot (install: emsdk install $EmsdkVersion)" }
$EmVer = (Get-Content -LiteralPath $VersionFile -Raw).Trim().Trim('"')
if ($EmVer -ne $EmsdkVersion) { Fail "emsdk upstream is $EmVer, expected $EmsdkVersion (run: emsdk install $EmsdkVersion; emsdk activate $EmsdkVersion)" }

$EmscriptenDir = Join-Path $EmsdkRoot 'upstream\emscripten'
$Toolchain     = Join-Path $EmscriptenDir 'cmake\Modules\Platform\Emscripten.cmake'
$EmConfig      = Join-Path $EmsdkRoot '.emscripten'
$PythonExe     = @(Get-ChildItem -LiteralPath (Join-Path $EmsdkRoot 'python') -Recurse -Filter 'python.exe' -ErrorAction SilentlyContinue | Select-Object -First 1)
$NodeExe       = @(Get-ChildItem -LiteralPath (Join-Path $EmsdkRoot 'node') -Recurse -Filter 'node.exe' -ErrorAction SilentlyContinue | Select-Object -First 1)
$CmakeExe      = Join-Path $PyUserScripts 'cmake.exe'
$NinjaExe      = Join-Path $PyUserScripts 'ninja.exe'

foreach ($p in @($Toolchain, $EmConfig, $CmakeExe, $NinjaExe)) {
    if (-not (Test-Path -LiteralPath $p)) { Fail "missing $p (cmake/ninja: py -3.13 -m pip install --user cmake ninja)" }
}
if ($PythonExe.Count -eq 0) { Fail "no python.exe under $EmsdkRoot\python" }
if ($NodeExe.Count -eq 0) { Fail "no node.exe under $EmsdkRoot\node" }
$PythonExe = $PythonExe[0].FullName
$NodeExe   = $NodeExe[0].FullName

# Session-only environment. Never [Environment]::SetEnvironmentVariable.
$env:EMSDK        = $EmsdkRoot
$env:EM_CONFIG    = $EmConfig
$env:EMSDK_PYTHON = $PythonExe
$env:EMSDK_NODE   = $NodeExe
$env:PATH = (@($PyUserScripts, $EmscriptenDir, (Split-Path -Parent $NodeExe), (Join-Path $EmsdkRoot 'upstream\bin'), $EmsdkRoot) -join ';') + ';' + $env:PATH

$EmccBat = Join-Path $EmscriptenDir 'emcc.bat'
$EmccVer  = Get-FirstLine $EmccBat @('--version')
$CmakeVer = Get-FirstLine $CmakeExe @('--version')
$NinjaVer = Get-FirstLine $NinjaExe @('--version')
Log "emcc:  $EmccVer"
Log "cmake: $CmakeVer"
Log "ninja: $NinjaVer"
if ($EmccVer -notmatch [regex]::Escape($EmsdkVersion)) { Fail "emcc does not report $EmsdkVersion" }

# ---------------------------------------------------------------- preflight on the source tree
if (-not (Test-Path -LiteralPath (Join-Path $SourceDir 'CMakeLists.txt'))) { Fail "no CMakeLists.txt in $SourceDir" }

$Problems = New-Object System.Collections.Generic.List[string]
$Rejects = @(Get-ChildItem -LiteralPath $SourceDir -Recurse -Filter '*.rej' -File -ErrorAction SilentlyContinue |
             Where-Object { $_.FullName -notmatch '\\core\\deps\\' })
foreach ($r in $Rejects) { $Problems.Add("unresolved patch reject: $($r.FullName.Substring($SourceDir.Length + 1))") }
foreach ($f in @('core\rec-wasm\rec_wasm.cpp', 'core\rec-wasm\wasm_emit.h', 'core\rec-wasm\wasm_module_builder.h')) {
    if (-not (Test-Path -LiteralPath (Join-Path $SourceDir $f))) { $Problems.Add("missing wasm JIT file: $f") }
}

if ($InitSubmodules -and -not $DryRun) {
    $c = Invoke-Logged 'git' @('-C', $SourceDir, 'submodule', 'update', '--init', '--recursive')
    if ($c -ne 0) { Fail "git submodule update failed ($c)" }
}

$prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
$GitHead   = (& git -C $SourceDir rev-parse HEAD 2>$null | Select-Object -First 1)
$GitDirty  = @(& git -C $SourceDir status --porcelain --ignore-submodules=all 2>$null).Count
$SubStatus = @(& git -C $SourceDir submodule status 2>$null)
$ErrorActionPreference = $prevEap
$Uninit = @($SubStatus | Where-Object { $_ -match '^-' } | ForEach-Object { ($_ -split '\s+')[1] })
if ($Uninit.Count -gt 0) { $Problems.Add("uninitialized submodules (use -InitSubmodules): " + ($Uninit -join ', ')) }
Log "source HEAD: $GitHead (modified paths: $GitDirty)"

# ---------------------------------------------------------------- zlib port
$Sysroot     = Join-Path $EmscriptenDir 'cache\sysroot'
$ZlibInclude = Join-Path $Sysroot 'include'
$ZlibLibrary = Join-Path $Sysroot 'lib\wasm32-emscripten\libz.a'
if (-not $DryRun -and -not (Test-Path -LiteralPath $ZlibLibrary)) {
    $c = Invoke-Logged (Join-Path $EmscriptenDir 'embuilder.bat') @('build', 'zlib')
    if ($c -ne 0) { Fail "embuilder build zlib failed ($c)" }
}
if (-not $DryRun -and -not (Test-Path -LiteralPath (Join-Path $ZlibInclude 'zlib.h'))) { Fail "zlib.h not found in $ZlibInclude" }

# ---------------------------------------------------------------- commands
$ConfigureArgs = @(
    '-S', $SourceDir,
    '-B', $BuildDir,
    '-G', 'Ninja',
    "-DCMAKE_MAKE_PROGRAM=$NinjaExe",
    "-DCMAKE_TOOLCHAIN_FILE=$Toolchain",
    "-DCMAKE_CROSSCOMPILING_EMULATOR=$NodeExe",
    '-DCMAKE_POLICY_VERSION_MINIMUM=3.5',
    '-DCMAKE_BUILD_TYPE=Release',
    '-DLIBRETRO=ON',
    '-DUSE_GLES=ON',
    # Use Emscripten's zlib port (prebuilt into the sysroot by this script) instead
    # of the bundled zlib-1.3.1. The bundled one defines both zlib (SHARED) and
    # zlibstatic with OUTPUT_NAME z; under Emscripten both become libz.a and Ninja
    # refuses the duplicate output (Make, used by build-prod.sh, does not check).
    '-DWITH_SYSTEM_ZLIB=ON',
    "-DZLIB_INCLUDE_DIR=$ZlibInclude",
    "-DZLIB_LIBRARY=$ZlibLibrary",
    # D-063: keep the client GPL-2.0-or-later. xBRZ (GPL-3.0) is left out via the
    # USE_XBRZ option (patch 0005 on doc-wasm/8412d3d8a); libcdio stays off.
    '-DUSE_XBRZ=OFF',
    '-DUSE_LIBCDIO=OFF',
    # D-063: no bundled third-party game data (flash defaults, printer and BIOS fonts).
    '-DUSE_BUNDLED_GAME_DATA=OFF',
    "-DCMAKE_C_FLAGS=$JitFlags",
    "-DCMAKE_CXX_FLAGS=$JitFlags"
)
$BuildArgs = @('--build', $BuildDir, '--target', 'flycast_libretro')

$prov = [ordered]@{
    utc            = $Stamp
    mode           = $Mode
    source_dir     = $SourceDir
    source_head    = $GitHead
    source_modified_paths = $GitDirty
    build_dir      = $BuildDir
    emsdk_version  = $EmsdkVersion
    emcc           = $EmccVer
    cmake          = $CmakeVer
    ninja          = $NinjaVer
    configure_args = $ConfigureArgs
    build_args     = $BuildArgs
    preflight_problems = @($Problems)
    result         = 'not run'
}
function Save-Prov { [System.IO.File]::WriteAllText($ProvFile, ($prov | ConvertTo-Json -Depth 4), $Utf8NoBom) }

if ($Problems.Count -gt 0) {
    foreach ($p in $Problems) { Log "PREFLIGHT: $p" }
}

if ($DryRun) {
    Log "DRY RUN: would run:"
    Log ("  `"$CmakeExe`" " + ($ConfigureArgs -join ' '))
    if (-not $ConfigureOnly) { Log ("  `"$CmakeExe`" " + ($BuildArgs -join ' ')) }
    $prov.result = 'dry run'
    Save-Prov
    Log "log: $LogFile"
    Log "provenance: $ProvFile"
    if ($Problems.Count -gt 0) { Log 'DRY RUN: preflight would block a real run.'; exit 2 }
    exit 0
}

if ($Problems.Count -gt 0) {
    $prov.result = 'blocked by preflight'
    Save-Prov
    Fail 'preflight failed; see PREFLIGHT lines above'
}

New-Item -ItemType Directory -Force -Path $BuildDir | Out-Null
$code = Invoke-Logged $CmakeExe $ConfigureArgs
if ($code -ne 0) { $prov.result = "configure failed ($code)"; Save-Prov; Fail "configure failed ($code); log: $LogFile" }
if ($ConfigureOnly) { $prov.result = 'configured'; Save-Prov; Log "configured. log: $LogFile"; exit 0 }

$code = Invoke-Logged $CmakeExe $BuildArgs
if ($code -ne 0) { $prov.result = "build failed ($code)"; Save-Prov; Fail "build failed ($code); log: $LogFile" }

$Lib = Join-Path $BuildDir $ExpectedLib
if (-not (Test-Path -LiteralPath $Lib)) { $prov.result = 'build ok but library missing'; Save-Prov; Fail "build finished but $ExpectedLib not found" }
# D-063 check: no xBRZ or libcdio object may end up in the library.
$prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
$Members = @(& (Join-Path $EmscriptenDir 'emar.bat') 't' $Lib 2>$null)
$ErrorActionPreference = $prevEap
$Banned = @($Members | Where-Object { $_ -match '(?i)xbrz|libcdio' })
if ($Banned.Count -gt 0) { $prov.result = 'built but contains excluded code'; Save-Prov; Fail ('library contains excluded objects: ' + ($Banned -join ', ')) }
$prov['library_members'] = $Members.Count
$prov.result = 'built'
$prov['library'] = $Lib
$prov['library_sha256'] = (Get-FileHash -LiteralPath $Lib -Algorithm SHA256).Hash
Save-Prov
Log "built $Lib"
Log "log: $LogFile"
Log "provenance: $ProvFile"
exit 0
