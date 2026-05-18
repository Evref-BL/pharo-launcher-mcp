# pharo-launcher-mcp

pharo-launcher-mcp is a standalone MCP server for Pharo Launcher.

It exposes Pharo Launcher image, template, VM, and process operations as MCP
tools. It can run through a bundled launcher wrapper, or fall back to a direct
Pharo VM invocation when no wrapper is available.

## Requirements

- Node.js 24 or newer
- `npm` and `npx`
- Pharo Launcher

## Install

```sh
npm install @evref-bl/pharo-launcher-mcp
```

Run the server over stdio:

```sh
npx @evref-bl/pharo-launcher-mcp
```

The package also exposes the `pharo-launcher-mcp` executable when installed
into a project.

## Configuration

pharo-launcher-mcp resolves Pharo Launcher paths from environment variables
first. If they are not set, it uses host defaults. On macOS it first checks
regular PharoLauncher.app install locations, then falls back to the application
support layout:

| Host OS | Launcher directory | VM path | Bundled wrapper |
| --- | --- | --- | --- |
| Windows | `%LOCALAPPDATA%\Pharo Launcher` | `<launcher-dir>\PharoConsole.exe` | `pharo-launcher.cmd` |
| macOS app bundle | `$HOME/Applications/PharoLauncher.app` or `/Applications/PharoLauncher.app` | `<app>/Contents/MacOS/Pharo` | `pharo-launcher.sh` |
| macOS fallback data dir | `$HOME/Library/Application Support/Pharo Launcher` | `<launcher-dir>/pharo-vm/Pharo.app/Contents/MacOS/Pharo` | `pharo-launcher.sh` |
| Linux | `$HOME/.local/share/Pharo Launcher` | `<launcher-dir>/pharo-vm/pharo` | `pharo-launcher.sh` |

For macOS app-bundle installs, the control image is resolved from
`<app>/Contents/Resources/PharoLauncher.image`. `pharo_launcher_config` and
`pharo_launcher_health` report the selected discovery source and all attempted
installation candidates.

Override paths when needed:

```sh
PHARO_LAUNCHER_DIR="/path/to/Pharo Launcher"
PHARO_LAUNCHER_VM="/path/to/pharo"
PHARO_LAUNCHER_IMAGE="/path/to/PharoLauncher.image"
PHARO_LAUNCHER_SCRIPT="/path/to/pharo-launcher.sh"
```

```powershell
$env:PHARO_LAUNCHER_DIR="C:\Users\<you>\AppData\Local\Pharo Launcher"
$env:PHARO_LAUNCHER_VM="$env:PHARO_LAUNCHER_DIR\PharoConsole.exe"
$env:PHARO_LAUNCHER_IMAGE="$env:PHARO_LAUNCHER_DIR\PharoLauncher.image"
$env:PHARO_LAUNCHER_SCRIPT="C:\path\to\pharo-launcher.cmd"
```

`PHARO_LAUNCHER_SCRIPT` is optional. If it is unset, pharo-launcher-mcp tries
its bundled wrapper for the current platform. If no wrapper is available, it
runs the VM directly with:

```text
--headless <PharoLauncher.image> --no-default-preferences clap launcher ...
```

## Profiles

Profiles are optional. They let pharo-launcher-mcp use a separate Pharo
Launcher control image and separate folders for images, VMs, templates,
initialization scripts, and logs.

```sh
PHARO_LAUNCHER_MCP_PROFILE=isolated
PHARO_LAUNCHER_MCP_STATE_ROOT=/path/to/pharo-launcher-mcp/profiles/isolated
```

Profile paths can also be set explicitly:

```sh
PHARO_LAUNCHER_MCP_LAUNCHER_IMAGE=/path/to/profile/PharoLauncher.image
PHARO_LAUNCHER_MCP_IMAGES_DIR=/path/to/images
PHARO_LAUNCHER_MCP_VMS_DIR=/path/to/vms
PHARO_LAUNCHER_MCP_TEMPLATE_SOURCES_DIR=/path/to/templates
PHARO_LAUNCHER_MCP_INIT_SCRIPTS_DIR=/path/to/init-scripts
PHARO_LAUNCHER_MCP_LOGS_DIR=/path/to/logs
```

`PHARO_LAUNCHER_MCP_LAUNCHER_CONFIGURATION`, when set, is passed to Pharo Launcher as
`--configuration <value>`. In profile mode, a relative value is resolved under
the profile launcher directory. When it is not set, pharo-launcher-mcp writes
and uses `<state-root>/launcher/pharo-launcher-cli-config.ston`. That generated
configuration points Pharo Launcher at the profile images, VMs, template
sources, and initialization script directories so image create and copy commands
do not fall back to the host default image repository.

## Tools

Health and configuration:

| Tool | Purpose |
| --- | --- |
| `pharo_launcher_health` | Report resolved paths and wrapper availability without invoking Pharo Launcher. |
| `pharo_launcher_config` | Report the active Pharo Launcher configuration. |
| `pharo_launcher_version` | Run `--version`. |
| `pharo_launcher_validate_installation` | Check resolved paths and run `--version`. |
| `pharo_launcher_inventory` | Report scoped template/version/profile inventory, existing images, and caller-declared image handles for lifecycle planning. |

Image tools:

```text
pharo_launcher_image_bisect
pharo_launcher_image_copy
pharo_launcher_image_create
pharo_launcher_image_create_from_build
pharo_launcher_image_create_from_pull_request
pharo_launcher_image_create_from_repo
pharo_launcher_image_create_from_sha
pharo_launcher_image_delete
pharo_launcher_image_info
pharo_launcher_image_launch
pharo_launcher_image_list
pharo_launcher_image_package
pharo_launcher_image_recreate
```

Template tools:

```text
pharo_launcher_template_category_list
pharo_launcher_template_info
pharo_launcher_template_list
pharo_launcher_template_update
```

VM tools:

```text
pharo_launcher_vm_delete
pharo_launcher_vm_info
pharo_launcher_vm_list
pharo_launcher_vm_update
```

Process tools:

```text
pharo_launcher_process_kill
pharo_launcher_process_list
```

Escape hatch:

```text
pharo_launcher_raw_command
```

Destructive tools require `confirm: true`:

```ts
pharo_launcher_image_delete({ imageName, confirm: true, force?: true })
pharo_launcher_image_recreate({ imageName, confirm: true })
pharo_launcher_vm_delete({ vmId, confirm: true })
pharo_launcher_process_kill({ imageName, confirm: true })
pharo_launcher_process_kill({ pid, confirm: true })
```

`pharo_launcher_process_kill` rejects ambiguous input that contains both
`imageName` and `pid`.

## Results

Launcher tools return a normalized envelope:

```ts
{
  ok: boolean;
  data?: unknown;
  parser: {
    status: "parsed" | "unsupported" | "failed" | "skipped";
    format: "ston" | "text";
    message?: string;
  };
  raw: {
    stdout: string;
    stderr: string;
    format: "ston" | "text";
  };
  command: {
    args: string[];
    durationMs: number;
    exitCode: number | null;
    timedOut: boolean;
    timeoutReason?: string;
  };
}
```

## Development

Development, testing, and live Pharo Launcher notes are in
[`docs/development.md`](docs/development.md).
