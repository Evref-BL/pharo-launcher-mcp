param(
  [string] $ProfileName = "live-test",
  [string] $StateRoot = "",
  [switch] $Force
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$repoParent = Split-Path -Parent $repoRoot

if (-not $StateRoot) {
  $StateRoot = Join-Path $repoParent ".pharo-launcher-mcp\profiles\$ProfileName"
}

$launcherDir = $env:PHARO_LAUNCHER_DIR
if (-not $launcherDir) {
  $launcherDir = Join-Path $env:LOCALAPPDATA "Pharo Launcher"
}

$sourceImage = $env:PHARO_LAUNCHER_IMAGE
if (-not $sourceImage) {
  $sourceImage = Join-Path $launcherDir "PharoLauncher.image"
}

$sourceChanges = [System.IO.Path]::ChangeExtension($sourceImage, ".changes")
$launcherProfileDir = Join-Path $StateRoot "launcher"
$profileImage = Join-Path $launcherProfileDir "PharoLauncher.image"
$profileChanges = [System.IO.Path]::ChangeExtension($profileImage, ".changes")
$profileConfiguration = Join-Path $launcherProfileDir "pharo-launcher-cli-config.ston"

$profileDirs = @(
  $StateRoot,
  $launcherProfileDir,
  (Join-Path $StateRoot "images"),
  (Join-Path $StateRoot "vms"),
  (Join-Path $StateRoot "templates"),
  (Join-Path $StateRoot "init-scripts"),
  (Join-Path $StateRoot "logs")
)

foreach ($dir in $profileDirs) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

if (-not (Test-Path -LiteralPath $sourceImage)) {
  throw "Source PharoLauncher image not found: $sourceImage"
}

if ((Test-Path -LiteralPath $profileImage) -and -not $Force) {
  Write-Host "Profile launcher image already exists: $profileImage"
  Write-Host "Use -Force to overwrite it."
} else {
  Copy-Item -LiteralPath $sourceImage -Destination $profileImage -Force
  Write-Host "Copied launcher image:"
  Write-Host "  $sourceImage"
  Write-Host "  -> $profileImage"
}

if (Test-Path -LiteralPath $sourceChanges) {
  if ((Test-Path -LiteralPath $profileChanges) -and -not $Force) {
    Write-Host "Profile launcher changes already exists: $profileChanges"
  } else {
    Copy-Item -LiteralPath $sourceChanges -Destination $profileChanges -Force
    Write-Host "Copied launcher changes:"
    Write-Host "  $sourceChanges"
    Write-Host "  -> $profileChanges"
  }
} else {
  Write-Host "No source changes file found next to launcher image: $sourceChanges"
}

$envFile = Join-Path $StateRoot "profile.env.ps1"
@"
`$env:PHARO_LAUNCHER_MCP_PROFILE="$ProfileName"
`$env:PHARO_LAUNCHER_MCP_STATE_ROOT="$StateRoot"
`$env:PHARO_LAUNCHER_MCP_LAUNCHER_IMAGE="$profileImage"
`$env:PHARO_LAUNCHER_MCP_IMAGES_DIR="$(Join-Path $StateRoot "images")"
`$env:PHARO_LAUNCHER_MCP_VMS_DIR="$(Join-Path $StateRoot "vms")"
`$env:PHARO_LAUNCHER_MCP_TEMPLATE_SOURCES_DIR="$(Join-Path $StateRoot "templates")"
`$env:PHARO_LAUNCHER_MCP_INIT_SCRIPTS_DIR="$(Join-Path $StateRoot "init-scripts")"
`$env:PHARO_LAUNCHER_MCP_LOGS_DIR="$(Join-Path $StateRoot "logs")"
`$env:PHARO_LAUNCHER_MCP_LAUNCHER_CONFIGURATION="$profileConfiguration"
"@ | Set-Content -LiteralPath $envFile -Encoding UTF8

Write-Host ""
Write-Host "Live profile prepared:"
Write-Host "  profile: $ProfileName"
Write-Host "  root:    $StateRoot"
Write-Host "  env:     $envFile"
