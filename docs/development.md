# pharo-launcher-mcp Development

This document contains development notes for pharo-launcher-mcp. The main README is kept
focused on installation, configuration, and tool usage.

## Source Layout

- `src/server.ts`: MCP server surface and tool dispatch.
- `src/commandCatalog.ts`: Pharo Launcher command definitions and input checks.
- `src/config.ts`: Pharo Launcher and profile path resolution.
- `src/platform.ts`: host-specific defaults and wrapper selection.
- `src/launcherScript.ts`: bundled wrapper discovery.
- `src/launcherCli.ts`: command execution boundary.
- `src/processTools.ts`: native process list and kill backends.
- `src/parser.ts`: Pharo Launcher output parsing.
- `src/resultNormalizer.ts`: normalized MCP result envelopes.
- `bin/pharo-launcher.cmd`: Windows wrapper.
- `bin/pharo-launcher.sh`: POSIX wrapper.
- `scripts/*.ps1`: Windows helper scripts for local live checks.

## Local Setup

```sh
npm install
npm run build
npm test
```

Useful scripts:

```sh
npm run build
npm run typecheck
npm test
npm run test:integration
```

`npm test` runs unit coverage only. It does not invoke a local Pharo Launcher.

## Platform Contract

The production code handles Windows, macOS, and Linux explicitly:

- Windows defaults to `%LOCALAPPDATA%\Pharo Launcher`,
  `PharoConsole.exe`, and `pharo-launcher.cmd`.
- macOS discovery checks `$HOME/Applications/PharoLauncher.app` and
  `/Applications/PharoLauncher.app` before falling back to
  `$HOME/Library/Application Support/Pharo Launcher`. App-bundle installs use
  `Contents/MacOS/Pharo` and `Contents/Resources/PharoLauncher.image`.
- Linux defaults to `$HOME/.local/share/Pharo Launcher`, `pharo-vm/pharo`,
  and `pharo-launcher.sh`.

`src/crossPlatform.test.ts` covers configuration defaults, bundled wrapper
selection, and native process backend selection for all three platforms.
`src/config.test.ts` covers macOS app-bundle discovery, fallback, and explicit
environment override precedence.

No-profile mode means no pharo-launcher-mcp profile is active and no
pharo-launcher-mcp home/cache is created. The resolved Pharo Launcher
installation and its normal state scope are used directly. Profile mode is
entered only when `PHARO_LAUNCHER_MCP_PROFILE`,
`PHARO_LAUNCHER_MCP_STATE_ROOT`, or one of the explicit profile directory
variables is present.

## Process Backend

Pharo Launcher process commands can vary by host. pharo-launcher-mcp uses a native process
backend for `pharo_launcher_process_list` and `pharo_launcher_process_kill`
when needed:

- Windows uses a PowerShell/CIM query.
- macOS and Linux use `ps -axo pid=,args=`.
- Unsupported host platforms return an explicit unsupported-backend error.

## Parsing Boundary

`src/parser.ts` is the only layer that translates Pharo Launcher output into
pharo-launcher-mcp models.

- STON output is parsed where Pharo Launcher exposes stable STON for list/info
  commands.
- Plain text is parsed only for stable tables and process listings.
- Unsupported commands still return command metadata and raw output.
- Failed commands skip parsing so command failure is not confused with parser
  failure.

Typed launcher results include `parser.status` so result handlers can distinguish
normalized model data from raw-only output.

Stable model names include:

```text
LauncherImage
LauncherTemplate
LauncherVm
LauncherProcess
LauncherCommandResult
```

Inventory output adds normalized identity metadata on top of parsed launcher
models. Template identities normalize Pharo and Moose template names to the
underlying Pharo version when possible, infer architecture from template names
or URLs, and attach source-file digest/mtime for installed `.ston` template
files. Image identities mirror the launcher metadata returned by image
list/info commands.

## Integration Tests

Run the live integration suite explicitly:

```sh
npm run test:integration
```

The integration suite prepares an isolated temporary launcher profile by copying
the Pharo Launcher control image. It includes live checks for:

- health
- version
- installation validation
- config
- template categories, list, info, and update
- VM list and info
- image list
- image create
- image copy
- image info
- image package
- image launch
- image recreate
- image delete
- process list
- process kill
- raw command with explicit confirmation

External-source image creation variants such as build, pull request,
repository, SHA, and VM mutation commands should use explicit fixtures because
they require network inputs or can alter VM installations.

## Windows Live Helpers

The helper scripts under `scripts/*.ps1` are Windows PowerShell conveniences for
the current development environment:

```powershell
.\scripts\verify-environment.ps1
npm run live:profile
npm run live:smoke
```

The live smoke test uses a dedicated profile root and copies the Pharo Launcher
control image there before making live calls. It runs harmless checks by
default: health, `--version`, and installation validation.

Default profile root:

```text
C:\dev\code\git\.pharo-launcher-mcp\profiles\live-test
```

Refresh the copied launcher control image:

```powershell
.\scripts\live-smoke.ps1 -ForceProfileRefresh
```

These helpers are not a substitute for cross-platform verification on macOS and
Linux.

## Cleanup Hook Boundary

Use `docs/cleanup-hook-boundary.md` when mapping launcher status, stop,
timeout, and cleanup hooks for isolated live checks. That boundary
distinguishes read-only planning checks from host inspection and mutation.

## Local Probes

Probe the local Pharo Launcher image list without starting MCP stdio:

```powershell
npm run build
node .\dist\index.js --health
node .\dist\index.js --probe-images
```

Start the MCP server over stdio from a local build:

```powershell
node .\dist\index.js
```
