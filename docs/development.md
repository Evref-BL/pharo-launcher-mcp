# Development

This document is for maintainers changing pharo-launcher-mcp. The README stays
focused on installation and first use; user-facing detail lives under `docs/`.

## Source layout

- `src/server.ts`: MCP server surface and tool dispatch.
- `src/answers.ts`: what each tool answers, as text, and the checks made
  before a call. Every text naming a tool is here.
- `src/library.ts`: the package's entry point, `openPharoLauncher`, and every
  name it exports: the semver promise.
- `src/launcher.ts`: what the library and the tools are made from, opened on a
  config with the hooks tests give.
- `src/commandCatalog.ts`: Pharo Launcher command definitions and input checks.
- `src/config.ts`: Pharo Launcher and profile path resolution.
- `src/platform.ts`: host-specific defaults and wrapper selection.
- `src/launcherScript.ts`: bundled wrapper discovery.
- `src/launcherCli.ts`: command execution boundary.
- `src/processTools.ts`: native process list and kill backends.
- `src/imageStore.ts`: the Launcher's images, read from its images directory,
  and the VMs running them.
- `src/ston.ts`: reads fields of the STON Pharo Launcher writes.
- `src/parser.ts`: Pharo Launcher output parsing.
- `src/resultNormalizer.ts`: the library's launcher results.
- `src/probe.ts`: `--probe-images`.
- `bin/pharo-launcher.cmd`: Windows wrapper.
- `bin/pharo-launcher.sh`: POSIX wrapper.
- `scripts/live-smoke.mjs`: local live checks against a real launcher.

## Local setup

```sh
npm install
npm run check
```

Useful scripts:

```sh
npm run build
npm run typecheck
npm test
npm run test:integration
```

`npm run check` runs type checking, build, and unit tests. `npm test` runs unit
coverage only. It does not invoke a local Pharo Launcher.

Type checking reads `tsconfig.check.json`, which covers the unit and
integration tests as well as the production code; the build reads
`tsconfig.json`, which leaves the tests out of `dist`. The integration tests
need a live Pharo Launcher to run, so type checking is the only thing that
reads them on CI.

## Platform contract

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

## Process backend

pharo-launcher-mcp lists and kills processes itself, never through Pharo
Launcher's `process` commands, whose table shortens a long path:

- Windows uses a PowerShell/CIM query.
- macOS and Linux use `ps -axo pid=,args=`.
- On any other platform the process tools fail: listing processes is not
  supported there.

Of those processes, a VM runs image `D` when its command line names
`<images>/D/D.image`, bounded by whitespace, a quote or the line's ends. The
tools keep those in every mode; the library's `listProcesses` does in profile
mode, and lists every Pharo VM outside one.

## Parsing boundary

What the server knows of the Launcher's state comes from four places, each read
where it is stable:

- Images are read from the images directory (`src/imageStore.ts`), never from
  the Launcher's output: its STON names no image file, and its table shifts
  columns and shortens names. An image's metadata comes from its
  `meta-inf.ston`, its `pharo.version` and its image header.
- Template categories come from `template categories --brief`, one row per
  category with the default marked.
- Templates come from `template list --ston`, every `PhL…Template` it holds,
  in its order.
- Processes come from the native process list.

`src/parser.ts` reads the Launcher's listings. A command that lists nothing has
no data, and a failed command is not read, so a command's failure is never
taken for a listing's.

Stable model names include:

```text
LauncherImage
NotAnImage
LauncherImageList
LauncherImageInfo
LauncherTemplate
LauncherProcess
LauncherCommandResult
```

The MCP tools render these as text in `src/answers.ts`; the library never
answers text.

## Integration tests

Run the live integration suite explicitly:

```sh
npm run test:integration
```

The integration suite prepares an isolated temporary launcher profile by copying
the Pharo Launcher control image. It calls the tools as a model does and checks
their text, and checks the data through the library:

- config
- template categories, list, and update
- image list, and `--probe-images`
- image create, beside an image whose name holds the new one
- image copy
- image info
- image start, detached
- image delete, refused while the image runs and accepted right after the kill
- process list
- process kill

External-source image creation variants such as build, pull request,
repository, SHA, and VM mutation commands should use explicit fixtures because
they require network inputs or can alter VM installations.

## Live checks

`scripts/live-smoke.mjs` runs this package's live checks against a real Pharo
Launcher, in a profile of its own so nothing touches the launcher you use:

```sh
npm run live:smoke
```

It copies the launcher control image into that profile, then runs `--health`,
`--version-check`, `--validate-installation` and `--probe-images`. All four are
read-only.

Where the image comes from is not guessed: the script asks `describeConfig()`,
the same discovery that answers for the server, so a macOS `.app` bundle, a
Windows install and a Linux directory each resolve the way they do in use.
`--source-image`, `PHARO_LAUNCHER_IMAGE` or `PHARO_LAUNCHER_DIR` override it.

Without `--state-root` the profile lives in:

```text
<repo-parent>/.pharo-launcher-mcp/profiles/live-test
```

and the profile's environment is written beside it as `profile.env`, a plain
`KEY=value` file (`set -a; . profile.env` in a shell). `--force` refreshes the
copied control image; `--skip-build` uses `dist` as it is.

`npm run verify:env` is the short version: it builds and prints `--health`,
which reports what was discovered and whether it is usable.

## Cleanup hook boundary

Use `docs/cleanup-hook-boundary.md` when mapping launcher status, stop,
timeout, and cleanup hooks for isolated live checks. That boundary
distinguishes read-only planning checks from host inspection and mutation.

## Local probes

Probe the local Pharo Launcher image list without starting MCP stdio. It asks
the Launcher to list its images, exits with that command's status, and prints
what `image_list` answers:

```powershell
npm run build
node .\dist\index.js --health
node .\dist\index.js --probe-images
```

Start the MCP server over stdio from a local build:

```powershell
node .\dist\index.js
```

## Documentation updates

Keep docs close to the behavior they describe:

- Put the fastest install and health path in `README.md`.
- Put profile details in `docs/user/profile-mode.md`.
- Put tool arguments and result shape in `docs/reference/tools.md`.
- Put live host failure modes in `docs/troubleshooting.md`.
- Keep examples generic. Do not use local machine paths, project names, issue
  numbers, or incident history as examples.

Before committing docs changes, run:

```sh
npm run check
npm pack --dry-run
```
