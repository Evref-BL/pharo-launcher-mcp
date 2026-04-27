$ErrorActionPreference = "Stop"

function Write-Check {
  param(
    [string] $Name,
    [bool] $Ok,
    [string] $Detail = ""
  )

  $status = if ($Ok) { "OK" } else { "MISSING" }
  if ($Detail) {
    Write-Host ("{0,-32} {1}  {2}" -f $Name, $status, $Detail)
  } else {
    Write-Host ("{0,-32} {1}" -f $Name, $status)
  }
}

function Get-CommandDetail {
  param([string] $CommandName)

  $cmd = Get-Command $CommandName -ErrorAction SilentlyContinue
  if (-not $cmd) {
    return $null
  }

  return $cmd.Source
}

$node = Get-CommandDetail "node"
$npm = Get-CommandDetail "npm"
$npx = Get-CommandDetail "npx"

Write-Check "node" ([bool] $node) $node
Write-Check "npm" ([bool] $npm) $npm
Write-Check "npx" ([bool] $npx) $npx

$launcherDir = $env:PHARO_LAUNCHER_DIR
if (-not $launcherDir) {
  $launcherDir = Join-Path $env:LOCALAPPDATA "Pharo Launcher"
}

$launcherVm = $env:PHARO_LAUNCHER_VM
if (-not $launcherVm) {
  $launcherVm = Join-Path $launcherDir "PharoConsole.exe"
}

$launcherImage = $env:PHARO_LAUNCHER_IMAGE
if (-not $launcherImage) {
  $launcherImage = Join-Path $launcherDir "PharoLauncher.image"
}

$profileName = $env:PHARO_LAUNCHER_MCP_PROFILE
$profileRoot = $env:PHARO_LAUNCHER_MCP_STATE_ROOT
if ($profileName -or $profileRoot) {
  if (-not $profileName) {
    $profileName = "default"
  }

  if (-not $profileRoot) {
    $profileRoot = Join-Path (Get-Location) ".pharo-launcher-mcp\$profileName"
  }

  $profileLauncherImage = $env:PHARO_LAUNCHER_MCP_LAUNCHER_IMAGE
  if (-not $profileLauncherImage) {
    $profileLauncherImage = Join-Path $profileRoot "launcher\PharoLauncher.image"
  }
}

$launcherScript = $env:PHARO_LAUNCHER_SCRIPT
if (-not $launcherScript) {
  $repoRoot = Split-Path -Parent $PSScriptRoot
  $launcherScript = Join-Path $repoRoot "bin\pharo-launcher.cmd"
}

Write-Check "PHARO_LAUNCHER_DIR" (Test-Path -LiteralPath $launcherDir) $launcherDir
Write-Check "PHARO_LAUNCHER_VM" (Test-Path -LiteralPath $launcherVm) $launcherVm
Write-Check "PHARO_LAUNCHER_IMAGE" (Test-Path -LiteralPath $launcherImage) $launcherImage
Write-Check "PHARO_LAUNCHER_SCRIPT" (Test-Path -LiteralPath $launcherScript) $launcherScript

if ($profileName -or $profileRoot) {
  $profileImagesDir = $env:PHARO_LAUNCHER_MCP_IMAGES_DIR
  if (-not $profileImagesDir) {
    $profileImagesDir = Join-Path $profileRoot "images"
  }

  $profileVmsDir = $env:PHARO_LAUNCHER_MCP_VMS_DIR
  if (-not $profileVmsDir) {
    $profileVmsDir = Join-Path $profileRoot "vms"
  }

  Write-Host ""
  Write-Host "Profile:"
  Write-Check "PHARO_LAUNCHER_MCP_PROFILE" ([bool] $profileName) $profileName
  Write-Check "PHARO_LAUNCHER_MCP_STATE_ROOT" (Test-Path -LiteralPath $profileRoot) $profileRoot
  Write-Check "PHARO_LAUNCHER_MCP_LAUNCHER_IMAGE" (Test-Path -LiteralPath $profileLauncherImage) $profileLauncherImage
  Write-Check "PHARO_LAUNCHER_MCP_IMAGES_DIR" (Test-Path -LiteralPath $profileImagesDir) $profileImagesDir
  Write-Check "PHARO_LAUNCHER_MCP_VMS_DIR" (Test-Path -LiteralPath $profileVmsDir) $profileVmsDir
}

if ($node) {
  Write-Host ""
  Write-Host "Versions:"
  & node --version
  if ($npm) { & npm --version }
  if ($npx) { & npx --version }
}
