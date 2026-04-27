param(
  [string] $ProfileName = "live-test",
  [string] $StateRoot = "",
  [switch] $SkipBuild,
  [switch] $ForceProfileRefresh
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$repoParent = Split-Path -Parent $repoRoot

if (-not $StateRoot) {
  $StateRoot = Join-Path $repoParent ".pharo-launcher-mcp\profiles\$ProfileName"
}

& (Join-Path $PSScriptRoot "prepare-live-profile.ps1") -ProfileName $ProfileName -StateRoot $StateRoot -Force:$ForceProfileRefresh

$env:PHARO_LAUNCHER_MCP_PROFILE = $ProfileName
$env:PHARO_LAUNCHER_MCP_STATE_ROOT = $StateRoot
$env:PHARO_LAUNCHER_MCP_LAUNCHER_IMAGE = Join-Path $StateRoot "launcher\PharoLauncher.image"
$env:PHARO_LAUNCHER_MCP_IMAGES_DIR = Join-Path $StateRoot "images"
$env:PHARO_LAUNCHER_MCP_VMS_DIR = Join-Path $StateRoot "vms"
$env:PHARO_LAUNCHER_MCP_TEMPLATE_SOURCES_DIR = Join-Path $StateRoot "templates"
$env:PHARO_LAUNCHER_MCP_INIT_SCRIPTS_DIR = Join-Path $StateRoot "init-scripts"
$env:PHARO_LAUNCHER_MCP_LOGS_DIR = Join-Path $StateRoot "logs"

if (-not $SkipBuild) {
  npm run build
  if ($LASTEXITCODE -ne 0) {
    throw "npm run build failed with exit code $LASTEXITCODE"
  }
}

function Invoke-CheckedNode {
  param([string[]] $Arguments)

  & node @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "node $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
  }
}

Write-Host ""
Write-Host "Live smoke: health"
Invoke-CheckedNode @(".\dist\index.js", "--health")

Write-Host ""
Write-Host "Live smoke: version"
Invoke-CheckedNode @(".\dist\index.js", "--version-check")

Write-Host ""
Write-Host "Live smoke: validate installation"
Invoke-CheckedNode @(".\dist\index.js", "--validate-installation")

Write-Host ""
Write-Host "Live smoke completed."
