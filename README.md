# pharo-launcher-mcp

pharo-launcher-mcp is an MCP server for controlling Pharo Launcher from a host
process.

It exposes Pharo Launcher image, template, VM, and process operations as MCP
tools. An MCP client can ask it what Launcher installation it resolved, list
templates, create or copy images, start images, package images, inspect running
Pharo processes, and delete caller-owned images or VMs.

The server works outside the target images. It does not install code into those
images, keep project state, or decide which images are safe to mutate. It is the
launcher boundary that higher-level tools can call when they need a concrete
image or process action.

## Install

Requirements:

- Node.js 22.12.0 or newer
- `npm` and `npx`
- Pharo Launcher installed on the host

Install from npm:

```sh
npm install @evref-bl/pharo-launcher-mcp
```

Run the MCP server over stdio:

```sh
npx @evref-bl/pharo-launcher-mcp
```

The package also provides the `pharo-launcher-mcp` executable when installed in
a project or globally.

## Use it as a library

A Node caller does not need the protocol. The tools are functions:

```js
import { openPharoLauncher } from "@evref-bl/pharo-launcher-mcp/launcher";

const launcher = openPharoLauncher();
const running = await launcher.listProcesses();
const { imagesDir, images, notImages } = await launcher.listImages({ nameFilter: "Task" });
```

Each call answers a typed object, which the MCP tools only render as text.
`listImages` reads the images directory and answers `{ imagesDir, images,
notImages }`; a function that runs a Launcher command answers the launcher
result, with its `ok`, `data`, `diagnostic` and `command` fields.

A TypeScript caller gets those shapes with them, so a result does not have to
be described a second time on the way out:

```ts
import type {
  LauncherCommandResult,
  LauncherImage,
  LauncherImageList,
  LauncherProcess,
  LauncherTemplate,
} from "@evref-bl/pharo-launcher-mcp/launcher";
```

An image directory is read and repaired the way the library does it, for a
caller that copies one itself: `readImageDirectory(imagesDir, name)` says
whether a directory is an image, `readLauncherImage(entry)` what its
`meta-inf.ston`, `pharo.version` and header say, and
`repairCopiedImageMetadataInDirectory(directory, from, to)` points a copy's
metadata at its new name. A caller that deletes an image's directory itself
calls `deleteLaunchLogs({ imageName })` after, as `deleteImage` does, so the
logs of its starts go with it.

Scope is a config, not a process. A caller that works inside a profile passes
the environment that describes it, instead of spawning a process to hold those
variables:

```js
const scoped = openPharoLauncher({
  env: { PHARO_LAUNCHER_MCP_PROFILE: "isolated", PHARO_LAUNCHER_MCP_STATE_ROOT: stateRoot },
});
```

The MCP server is an adapter over the same functions, so a host that embeds it
rather than spawning it imports that instead:

```js
import { callTool, createServer } from "@evref-bl/pharo-launcher-mcp";
import { loadPharoLauncherConfig } from "@evref-bl/pharo-launcher-mcp/config";
import { defaultLauncherDir } from "@evref-bl/pharo-launcher-mcp/platform";
```

The executable is reachable as a command, not as an import: loading it starts a
server on stdio.

## Terms

- A **Pharo Launcher installation** is the app or data directory, VM executable,
  control image, and launcher wrapper used to run Launcher commands.
- A **launcher state scope** is the set of image, VM, template-source,
  init-script, and log directories affected by Launcher commands.
- **No-profile mode** uses the user's normal Pharo Launcher installation and
  state scope directly.
- A **pharo-launcher-mcp profile** is an explicit isolated state scope selected
  through environment variables.
- An **image** is a directory `D` of the Launcher's images directory holding
  `D.image` and `D.changes`, Pharo Launcher's own rule.
- A **launcher result** is the object the library's functions answer for a
  Launcher command: parsed data when available, raw stdout/stderr when asked
  for, parser status, command duration, exit code, and timeout state. The MCP
  tools answer plain text rendered from it, for a model to read.

## Quick Start

Check what installation the server will use without invoking Pharo Launcher:

```sh
npx @evref-bl/pharo-launcher-mcp --health
```

If the discovered paths are not right, set the installation paths explicitly:

```sh
PHARO_LAUNCHER_DIR="/path/to/Pharo Launcher"
PHARO_LAUNCHER_VM="/path/to/pharo"
PHARO_LAUNCHER_IMAGE="/path/to/PharoLauncher.image"
npx @evref-bl/pharo-launcher-mcp --health
```

Configure an MCP client to start the stdio server. A generic MCP configuration
looks like this:

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

Once connected, start with these tools:

```text
pharo_launcher_config
pharo_launcher_image_list
pharo_launcher_template_list
```

`pharo_launcher_config` only inspects resolved configuration, and
`pharo_launcher_image_list` reads the images directory; the template list
crosses the live Launcher boundary.

Checking the installation before connecting is the executable's job, not a
tool's. `pharo-launcher-mcp --health`, `--version-check` and
`--validate-installation` each print JSON and exit. `--probe-images` asks the
Launcher to list its images, exits with that command's status, and prints what
`pharo_launcher_image_list` answers.

## Profile Quick Start

Use a profile when automation or tests need an isolated Launcher state scope:

```sh
PHARO_LAUNCHER_MCP_PROFILE=isolated
PHARO_LAUNCHER_MCP_STATE_ROOT=/path/to/launcher-profile
npx @evref-bl/pharo-launcher-mcp --health
```

In profile mode, pharo-launcher-mcp copies the Launcher control image into the
profile root when needed, creates profile directories, and writes a Launcher CLI
configuration that points images, VMs, templates, init scripts, and logs at that
profile. No-profile mode stays inactive unless one of the profile environment
variables is set.

Read [Profile mode](docs/user/profile-mode.md) before using profiles for live
image creation, launch, or cleanup.

## Common Workflows

List available templates:

```text
pharo_launcher_template_update
pharo_launcher_template_list
```

Create an image from a template:

```json
{
  "tool": "pharo_launcher_image_create",
  "arguments": {
    "templateName": "Pharo 13.0 - 64bit",
    "newImageName": "sample-130"
  }
}
```

Copy an image:

```json
{
  "tool": "pharo_launcher_image_copy",
  "arguments": {
    "imageName": "sample-130",
    "newImageName": "sample-130-copy"
  }
}
```

Launch an image:

```json
{
  "tool": "pharo_launcher_image_start",
  "arguments": {
    "imageName": "sample-130-copy",
    "displayMode": "headless",
    "detached": true
  }
}
```

## Safety Model

Mutating tools are explicit, and name what they act on. There is no
confirmation argument: calling a tool is the decision to call it, and a second
spelling of the same intent protects nothing.

What does protect something is the target. `pharo_launcher_process_kill`
requires exactly one of `pid` or `imageName`, and a PID stops that process
alone. Prefer the PID a detached launch returned when cleaning up a launch you
own. The process tools see only the VMs running an image of this Launcher's
images directory, so a kill cannot reach another Launcher's image.
`pharo_launcher_image_delete` refuses an image that a VM runs.

`pharo_launcher_image_create` and `pharo_launcher_image_copy` check that the
Launcher can list the new image and open it, even after a command that outlived
the call's timeout. If it cannot, the answer is an error saying which check
failed.

## Documentation

- [Getting started](docs/user/getting-started.md) covers installation,
  environment discovery, MCP client setup, and the first health checks.
- [Profile mode](docs/user/profile-mode.md) explains no-profile mode, isolated
  profiles, profile paths, generated configuration, and cross-profile image
  copy.
- [Tool reference](docs/reference/tools.md) lists the MCP tools, their
  arguments and answers, the library's results, and special behaviors.
- [Troubleshooting](docs/troubleshooting.md) maps common setup and live Launcher
  failures to concrete checks.
- [Development](docs/development.md) covers source layout, tests, local probes,
  and live test boundaries.
- [Cleanup hook boundary](docs/cleanup-hook-boundary.md) describes the status,
  timeout, stop, and cleanup contract for caller-managed live checks.

## Source Development

```sh
npm install
npm run check
```

`npm run check` runs type checking, build, and unit tests. Live integration tests
are separate because they invoke a local Pharo Launcher installation:

```sh
npm run test:integration
```
