# pharo-launcher-mcp

pharo-launcher-mcp is an MCP server for controlling Pharo Launcher from a host
process.

It exposes Pharo Launcher image, template, VM, and process operations as MCP
tools. An MCP client can ask it what Launcher installation it resolved, list
templates, create or copy images, launch images, package images, inspect running
Pharo processes, and delete caller-owned images or VMs when explicitly
confirmed.

The server works outside the target images. It does not install code into those
images, keep project state, or decide which images are safe to mutate. It is the
launcher boundary that higher-level tools can call when they need a concrete
image or process action.

## Install

Requirements:

- Node.js 24 or newer
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

## Terms

- A **Pharo Launcher installation** is the app or data directory, VM executable,
  control image, and launcher wrapper used to run Launcher commands.
- A **launcher state scope** is the set of image, VM, template-source,
  init-script, and log directories affected by Launcher commands.
- **No-profile mode** uses the user's normal Pharo Launcher installation and
  state scope directly.
- A **pharo-launcher-mcp profile** is an explicit isolated state scope selected
  through environment variables.
- A **launcher tool result** is the normalized JSON envelope returned by most
  tools. It includes parsed data when available, raw stdout/stderr, parser
  status, command duration, exit code, and timeout state.

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
pharo_launcher_health
pharo_launcher_config
pharo_launcher_validate_installation
pharo_launcher_inventory
```

`pharo_launcher_health` and `pharo_launcher_config` only inspect resolved
configuration. `pharo_launcher_validate_installation` invokes `--version`, so it
crosses the live Launcher boundary.

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
    "newImageName": "sample-130",
    "noLaunch": true
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
  "tool": "pharo_launcher_image_launch",
  "arguments": {
    "imageName": "sample-130-copy",
    "displayMode": "headless",
    "detached": true
  }
}
```

Package an image:

```json
{
  "tool": "pharo_launcher_image_package",
  "arguments": {
    "imageName": "sample-130-copy",
    "location": "/path/to/packages",
    "zip": true
  }
}
```

## Safety Model

Mutating tools are explicit. The destructive ones require `confirm: true`:

```text
pharo_launcher_image_delete
pharo_launcher_image_recreate
pharo_launcher_vm_delete
pharo_launcher_process_kill
pharo_launcher_raw_command
```

`pharo_launcher_process_kill` requires exactly one target: `pid` or
`imageName`. Prefer a recorded PID when cleaning up a known launch.

`pharo_launcher_image_create` and `pharo_launcher_image_copy` verify the target
image after Launcher reports success. If the target image cannot be listed and
inspected, the MCP result is an error with the command output and verification
diagnostics.

Profile-scoped `pharo_launcher_image_create_from_build` is refused before
Launcher is invoked, because that Launcher path can launch and download VMs
outside the configured profile VM directory.

## Documentation

- [Getting started](docs/user/getting-started.md) covers installation,
  environment discovery, MCP client setup, and the first health checks.
- [Profile mode](docs/user/profile-mode.md) explains no-profile mode, isolated
  profiles, profile paths, generated configuration, and cross-profile image
  copy.
- [Tool reference](docs/reference/tools.md) lists the MCP tools, arguments,
  result envelope, and special behaviors.
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
