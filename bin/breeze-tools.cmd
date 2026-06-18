@echo off
rem breeze-tools.cmd - Windows runtime shim. Resolves a Node-compatible runtime and
rem runs breeze-tools.mjs. Silent no-op (exit 0) if no runtime is available so this
rem never blocks a Claude Code SessionStart hook.
rem
rem Runtime priority:
rem   1. Bundled Electron via ELECTRON_RUN_AS_NODE - when installed inside the
rem      packaged app, the sibling Breeze File.exe is a self-contained Node
rem      runtime. Lets installed users run the CLI without system Node.
rem   2. System `node` on PATH - for dev (`node bin\breeze-tools.mjs ...`) and for
rem      users who already have Node.
rem
rem The .mjs lives next to this script in both layouts:
rem   ...\bin\breeze.cmd      +  ...\bin\breeze-tools.mjs                 (repo)
rem   ...\resources\breeze.cmd +  ...\resources\breeze-tools.mjs          (installed)

setlocal enabledelayedexpansion

set "HERE=%~dp0"
set "MJS=%HERE%breeze-tools.mjs"

if not exist "%MJS%" exit /b 0

rem 1. Bundled Electron: the .exe sits one level up from resources\ in an
rem    electron-builder install (app\resources\breeze.cmd -> app\Breeze File.exe).
set "ELECTRON_EXE=%HERE%..\Breeze File.exe"
if exist "%ELECTRON_EXE%" (
  set "ELECTRON_RUN_AS_NODE=1"
  "%ELECTRON_EXE%" "%MJS%" %*
  exit /b !errorlevel!
)

rem 2. System node on PATH.
where node >nul 2>nul
if !errorlevel! equ 0 (
  node "%MJS%" %*
  exit /b !errorlevel!
)

rem No runtime found - silent success so hooks never block.
exit /b 0
