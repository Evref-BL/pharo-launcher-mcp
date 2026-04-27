@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
for %%I in ("%SCRIPT_DIR%\..") do set "ROOT=%%~fI"

if "%PHARO_LAUNCHER_IMAGE%"=="" (
  if exist "%ROOT%\shared\PharoLauncher.image" (
    set "PHARO_LAUNCHER_IMAGE=%ROOT%\shared\PharoLauncher.image"
  )
)

if "%PHARO_LAUNCHER_IMAGE%"=="" (
  for %%I in ("%SCRIPT_DIR%\*.image" "%ROOT%\*.image") do (
    if exist "%%~fI" (
      set "PHARO_LAUNCHER_IMAGE=%%~fI"
      goto :foundImage
    )
  )
)
:foundImage

if "%PHARO_LAUNCHER_VM%"=="" (
  if exist "%ROOT%\pharo-vm\PharoConsole.exe" (
    set "PHARO_LAUNCHER_VM=%ROOT%\pharo-vm\PharoConsole.exe"
  )
)

if "%PHARO_LAUNCHER_VM%"=="" (
  if exist "%ROOT%\vms\80-x64\PharoConsole.exe" (
    set "PHARO_LAUNCHER_VM=%ROOT%\vms\80-x64\PharoConsole.exe"
  )
)

if "%PHARO_LAUNCHER_IMAGE%"=="" (
  echo PHARO_LAUNCHER_IMAGE is required or a packaged image must exist next to the launcher script 1>&2
  exit /b 1
)

if "%PHARO_LAUNCHER_VM%"=="" (
  echo PHARO_LAUNCHER_VM is required or a packaged VM must exist under pharo-vm or vms\80-x64 1>&2
  exit /b 1
)

"%PHARO_LAUNCHER_VM%" --headless "%PHARO_LAUNCHER_IMAGE%" --no-default-preferences clap launcher %*
