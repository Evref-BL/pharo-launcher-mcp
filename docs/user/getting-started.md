# Getting Started

This guide gets pharo-launcher-mcp running as a stdio MCP server and shows the
first checks to run before mutating any Launcher state.

## Requirements

- Node.js 22.12.0 or newer
- `npm` and `npx`
- A local Pharo Launcher installation
- An MCP client that can start a stdio server

## Install

Install the package in a project:

```sh
npm install @evref-bl/pharo-launcher-mcp
```

Or run it directly with `npx`:

```sh
npx @evref-bl/pharo-launcher-mcp
```

The server prints MCP JSON-RPC messages on stdio. For a human-readable local
check, run the health command instead:

```sh
npx @evref-bl/pharo-launcher-mcp --health
```

`--health` reports resolved paths and wrapper availability. It does not invoke
Pharo Launcher.

## Discovery

pharo-launcher-mcp resolves the Launcher installation from environment
variables first. If they are not set, it uses host defaults.

| Host OS | Launcher directory | VM path | Wrapper |
| --- | --- | --- | --- |
| Windows | `%LOCALAPPDATA%\Pharo Launcher` | `<launcher-dir>\PharoConsole.exe` | `pharo-launcher.cmd` |
| macOS app bundle | `$HOME/Applications/PharoLauncher.app` or `/Applications/PharoLauncher.app` | `<app>/Contents/MacOS/Pharo` | `pharo-launcher.sh` |
| macOS data directory | `$HOME/Library/Application Support/Pharo Launcher` | `<launcher-dir>/pharo-vm/Pharo.app/Contents/MacOS/Pharo` | `pharo-launcher.sh` |
| Linux | `$HOME/.local/share/Pharo Launcher` | `<launcher-dir>/pharo-vm/pharo` | `pharo-launcher.sh` |

For macOS app bundles, the control image is
`<app>/Contents/Resources/PharoLauncher.image`.

Override the installation when needed:

```sh
PHARO_LAUNCHER_DIR="/path/to/Pharo Launcher"
PHARO_LAUNCHER_VM="/path/to/pharo"
PHARO_LAUNCHER_IMAGE="/path/to/PharoLauncher.image"
PHARO_LAUNCHER_SCRIPT="/path/to/pharo-launcher.sh"
npx @evref-bl/pharo-launcher-mcp --health
```

PowerShell:

```powershell
$env:PHARO_LAUNCHER_DIR="C:\Path\To\Pharo Launcher"
$env:PHARO_LAUNCHER_VM="$env:PHARO_LAUNCHER_DIR\PharoConsole.exe"
$env:PHARO_LAUNCHER_IMAGE="$env:PHARO_LAUNCHER_DIR\PharoLauncher.image"
$env:PHARO_LAUNCHER_SCRIPT="C:\Path\To\pharo-launcher.cmd"
npx @evref-bl/pharo-launcher-mcp --health
```

`PHARO_LAUNCHER_SCRIPT` is optional. If it is not set, the server tries its
bundled wrapper for the host platform. If no wrapper is available, it invokes
the VM directly with:

```text
--headless <PharoLauncher.image> --no-default-preferences clap launcher ...
```

## MCP Client Setup

A generic MCP client entry looks like this:

```json
{
  "mcpServers": {
    "pharo-launcher": {
      "command": "npx",
      "args": ["-y", "@evref-bl/pharo-launcher-mcp"]
    }
  }
}
```

If the package is installed in a project, point the client at the package
executable from that project environment:

```json
{
  "mcpServers": {
    "pharo-launcher": {
      "command": "pharo-launcher-mcp"
    }
  }
}
```

For a profile-backed server, add the profile environment variables to the MCP
client entry. See [Profile mode](profile-mode.md).

## First Tools

Run read-only checks first:

```text
pharo_launcher_health
pharo_launcher_config
pharo_launcher_validate_installation
pharo_launcher_inventory
```

Use the output this way:

- `pharo_launcher_health` confirms whether the resolved directory, VM, control
  image, and wrapper exist. It does not invoke Pharo Launcher.
- `pharo_launcher_config` shows the same resolved configuration in a direct
  report.
- `pharo_launcher_validate_installation` runs `--version` and verifies that the
  launcher command can start.
- `pharo_launcher_inventory` gathers templates, images, profile roots, and
  declared image handles for lifecycle planning.

After validation, list templates:

```text
pharo_launcher_template_update
pharo_launcher_template_list
```

Then create an image with an explicit name:

```json
{
  "tool": "pharo_launcher_image_create",
  "arguments": {
    "templateName": "Pharo 13.0 - 64bit",
    "newImageName": "sample-130",
    "noLaunch": true
  }
}
```

The create result is only successful when the new image can be listed and
inspected after Launcher returns.

## No-Profile Defaults

With no profile variables set, commands operate on the user's normal Pharo
Launcher state scope. pharo-launcher-mcp does not create a hidden default
profile or redirect images and VMs into its own cache.

Detached image launches may write log files under `.pharo-launcher-mcp/logs` in
the server working directory when no profile log directory is active.

## When To Use A Profile

Use a profile when the caller needs an isolated Launcher state scope for tests,
automation, disposable images, or a project-bound runtime. In profile mode,
image and VM state are separated from the user's normal Launcher installation.

Continue with [Profile mode](profile-mode.md) before running live image create,
launch, delete, or process cleanup calls from automation.
