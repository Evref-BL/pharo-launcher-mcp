# Development

This document is for maintainers changing pharo-launcher-mcp. The README stays
focused on installation and first use; user-facing detail lives under `docs/`.

## Source layout

`src/library.ts` is the package's entry point: what it exports is under the
semantic versioning promise the README states. `src/launcher.ts` is what the
library and the tools are made from, opened on a config with the hooks tests
give; it decides, and refuses what it refuses. `src/answers.ts` renders what it
answers as each tool's text, and `src/server.ts` serves the tools. The other
modules each name what they do.

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

`npm run check` runs type checking, build, and unit tests. `npm test` runs the
unit tests only. Neither invokes a local Pharo Launcher.

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
library and the tools keep those, and only those, in every mode. `ps` runs
under `LC_ALL=C.UTF-8` and PowerShell writes UTF-8, so a path that is not
ASCII matches as it is spelled.

## Parsing boundary

What the server knows of the Launcher's state is read where it is stable:

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

The library answers these as the types `src/models.ts` declares; the MCP
tools render them as text in `src/answers.ts`. The library never answers text,
and every text that names a tool is there.

## Integration tests

Run the live integration suite explicitly:

```sh
npm run test:integration
```

The integration suite prepares an isolated temporary launcher profile by copying
the Pharo Launcher control image. It calls the tools as a model does and checks
their text, and checks the data through the library, from an image's create
to its delete. It was written against Pharo Launcher 3.4.5, and runs before
each release, not on CI.

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
`--version-check`, `--validate-installation` and `--probe-images`. None of them
changes an image or a process; the last three lay the profile out on their
first run.

Where the image comes from is not guessed: the script asks the config report,
the same discovery that answers for the server, so a macOS `.app` bundle, a
Windows install and a Linux directory each resolve the way they do in use.
`--source-image`, `PHARO_LAUNCHER_IMAGE` or `PHARO_LAUNCHER_DIR` override it.

Without `--state-root` the profile lives in:

```text
<repo-parent>/.pharo-launcher-mcp/profiles/live-test
```

and the profile's environment is written in it as `profile.env`, a plain
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
