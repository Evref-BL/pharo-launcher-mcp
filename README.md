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
- Pharo Launcher installed on the host

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
before connecting with `npx @evref-bl/pharo-launcher-mcp --health`, which exits
1 when something is missing; when the paths it found are wrong, set
`PHARO_LAUNCHER_DIR`, `PHARO_LAUNCHER_VM` or `PHARO_LAUNCHER_IMAGE`. `--help`
lists the other checks.

By default it drives the user's own Launcher and images. A **profile** gives it
a Launcher image, images, VMs and templates of its own, for automation and
tests:

```sh
PHARO_LAUNCHER_MCP_PROFILE=isolated PHARO_LAUNCHER_MCP_STATE_ROOT=/path/to/profile npx @evref-bl/pharo-launcher-mcp
```

The tools name what they act on, and ask for no confirmation. `process_kill`
takes a pid or an image, and sees only the VMs running one of this Launcher's
images; `image_delete` refuses an image a VM runs; `image_create` and
`image_copy` check that the Launcher can open the image they made. An image's
name is never a path.

## As a library

```js
import { openPharoLauncher } from "@evref-bl/pharo-launcher-mcp";

const launcher = openPharoLauncher({ profile: { stateRoot: "/path/to/profile" } });
await launcher.updateTemplates(); // a new profile has no templates yet
// A template is named as listTemplates names it; the names change with Pharo's releases.
const made = await launcher.createImage({ image: "task", template: "Pharo 14.0 - 64bit (stable)" });
if (!made.ok) throw new Error(made.diagnostic);
await launcher.startImage({ image: "task", detached: true, displayMode: "interactive" });
```

Without a profile it opens the user's own Launcher. Each call answers a typed
object, which the MCP tools render as text: what the library refuses, a
running image's delete for one, the tools refuse. The types come with it. The
library reads none of the command's `PHARO_LAUNCHER_*` variables: a program
says what it wants.

## What is promised

Semantic versioning covers:

- the library's exports and their types;
- the MCP tools' names and arguments;
- the command's options, the exit status of its checks, the `ok` field of the
  JSON that `--health`, `--version-check` and `--validate-installation` print,
  and the environment variables it reads.

A minor release may add an optional field, a `failure` kind or a method of
`PharoLauncher`. A program that switches over a `kind` keeps a default case,
and one that implements `PharoLauncher`, as a test double does, implements the
`Pick` of the methods it calls.

The rest of what the checks print, and the tools' answers, are text for a
person or a model to read, and may be reworded in any release.

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
