# pharo-launcher-mcp

Pharo Launcher, driven by a program: its images, its templates, and the VMs
running its images. Use it as a Node library, or as an MCP server for an agent.

It works outside the images. It installs no code into them, keeps no project
state, and does not decide which images are safe to change: it is the launcher
boundary that higher-level tools call when they need an image made, started,
stopped or deleted.

## Install

Requirements:

- Node.js 22.12.0 or newer
- Pharo Launcher installed on the host; the live tests run on Pharo Launcher
  3.4.5

```sh
npm install @evref-bl/pharo-launcher-mcp
```

## As an MCP server

Configure an MCP client to start the `pharo-launcher-mcp` command over stdio:

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

`config` says which Launcher it found and where its images are; `image_list`
reads them, and `template_list` asks the Launcher. Check the installation
before connecting with `npx @evref-bl/pharo-launcher-mcp --health`; when the
paths it found are wrong, set `PHARO_LAUNCHER_DIR`, `PHARO_LAUNCHER_VM` or
`PHARO_LAUNCHER_IMAGE`.

By default it drives the user's own Launcher and images. A **profile** gives it
a Launcher image, images, VMs and templates of its own, for automation and
tests:

```sh
PHARO_LAUNCHER_MCP_PROFILE=isolated PHARO_LAUNCHER_MCP_STATE_ROOT=/path/to/profile npx @evref-bl/pharo-launcher-mcp
```

The tools name what they act on, and ask for no confirmation. `process_kill`
takes a pid or an image, and sees only the VMs running one of this Launcher's
images; `image_delete` refuses an image a VM runs; `image_create` and
`image_copy` check that the Launcher can open the image they made.

## As a library

```js
import { openPharoLauncher } from "@evref-bl/pharo-launcher-mcp";

const launcher = openPharoLauncher({ profile: { stateRoot: "/path/to/profile" } });
const made = await launcher.createImage({ image: "task", template: "Pharo 14.0 - 64bit (stable)" });
const started = await launcher.startImage({ image: "task", detached: true });
```

Without a profile it opens the user's own Launcher. Each call answers a typed
object, which the MCP tools only render as text, and the types come with it.
The library reads none of the command's `PHARO_LAUNCHER_*` variables: a program
says what it wants.

## What is promised

Semantic versioning covers the library's exports, the MCP tools' names and
arguments, and the JSON the command prints for `--health`, `--version-check`,
`--validate-installation` and `--probe-images`. The tools' answers are text for
a model to read, and may be reworded in any release.

## Documentation

- [Getting started](docs/user/getting-started.md): installation, discovery,
  client setup, the first checks.
- [Profile mode](docs/user/profile-mode.md): profiles, their paths, and copying
  an image between them.
- [Tool reference](docs/reference/tools.md): the tools, their arguments and
  answers, and the library's calls.
- [Troubleshooting](docs/troubleshooting.md): setup and live Launcher failures.
- [Development](docs/development.md): source layout, tests and live checks.
- [Cleanup hook boundary](docs/cleanup-hook-boundary.md): status, timeout, stop
  and cleanup for caller-managed live checks.
