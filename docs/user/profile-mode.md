# Profile Mode

Profiles let pharo-launcher-mcp run Pharo Launcher commands against an explicit
state scope instead of the user's normal Launcher images, VMs, templates, and
logs.

Use a profile for automation, integration tests, disposable image work, or any
caller that must keep Launcher state separate from a human's regular Pharo
Launcher installation.

## No-Profile Mode

No-profile mode is the default. It is active when none of these environment
variables are set:

```text
PHARO_LAUNCHER_MCP_PROFILE
PHARO_LAUNCHER_MCP_STATE_ROOT
PHARO_LAUNCHER_MCP_LAUNCHER_IMAGE
PHARO_LAUNCHER_MCP_IMAGES_DIR
PHARO_LAUNCHER_MCP_VMS_DIR
PHARO_LAUNCHER_MCP_TEMPLATE_SOURCES_DIR
PHARO_LAUNCHER_MCP_INIT_SCRIPTS_DIR
PHARO_LAUNCHER_MCP_LOGS_DIR
```

In this mode, the server uses the resolved Pharo Launcher installation and its
normal state scope directly. It does not create an implicit profile or choose a
private image repository.

## Minimal Profile

The shortest profile setup is a profile name plus a state root:

```sh
PHARO_LAUNCHER_MCP_PROFILE=isolated
PHARO_LAUNCHER_MCP_STATE_ROOT=/path/to/launcher-profile
npx @evref-bl/pharo-launcher-mcp --health
```

The server derives the profile layout:

```text
<state-root>/
  launcher/
    PharoLauncher.image
    pharo-launcher-cli-config.ston
  images/
  vms/
  templates/
  init-scripts/
  logs/
```

Before a live Launcher invocation, pharo-launcher-mcp creates those directories,
copies the installation control image into the profile when needed, copies the
matching `.changes` file when present, and writes the Launcher CLI
configuration.

## Explicit Profile Paths

Callers can also provide every profile path:

```sh
PHARO_LAUNCHER_MCP_LAUNCHER_IMAGE=/path/to/profile/launcher/PharoLauncher.image
PHARO_LAUNCHER_MCP_IMAGES_DIR=/path/to/profile/images
PHARO_LAUNCHER_MCP_VMS_DIR=/path/to/profile/vms
PHARO_LAUNCHER_MCP_TEMPLATE_SOURCES_DIR=/path/to/profile/templates
PHARO_LAUNCHER_MCP_INIT_SCRIPTS_DIR=/path/to/profile/init-scripts
PHARO_LAUNCHER_MCP_LOGS_DIR=/path/to/profile/logs
```

`PHARO_LAUNCHER_MCP_LAUNCHER_CONFIGURATION` can point at a custom Launcher CLI
configuration. In profile mode, a relative value is resolved under
`<state-root>/launcher`. If it is not set, the server writes
`<state-root>/launcher/pharo-launcher-cli-config.ston`.

The generated configuration sets:

- image directory
- VM directory
- template source file location
- init script directory
- launch-from-login-shell behavior

The profile launcher image and generated configuration must stay inside
`PHARO_LAUNCHER_MCP_STATE_ROOT` when a state root is used. The server refuses to
write them outside that root.

## Template Sources

In profile mode, `pharo_launcher_template_update` checks the active profile
template source file after Launcher returns. If the source file is missing or
empty, the server seeds it from the default Pharo Launcher source list and then
probes `template list`.

If template listing still fails, inspect:

```text
pharo_launcher_inventory
pharo_launcher_config
```

The inventory diagnostics include missing or unreadable profile directories and
configuration files.

## Image Launch In Profile Mode

For profile-scoped image launch, pharo-launcher-mcp resolves the image inside
`PHARO_LAUNCHER_MCP_IMAGES_DIR` and runs it with a VM inside
`PHARO_LAUNCHER_MCP_VMS_DIR`. If the VM is missing, the server asks Launcher to
install that VM into the profile VM directory before launch.

Launch supports:

```json
{
  "imageName": "sample-130",
  "displayMode": "headless",
  "detached": true
}
```

`displayMode` can be `headless` or `interactive`. Detached launches return the
spawned PID when available and log paths under the profile log directory.

Profile-scoped `pharo_launcher_image_create_from_build` is refused before
Launcher is invoked. That Launcher path can launch automatically and may use VM
state outside `PHARO_LAUNCHER_MCP_VMS_DIR`.

## Cross-Profile Image Copy

`pharo_launcher_image_copy_between_profiles` copies an existing image directory
from one explicit profile to another without relying on the active server
profile.

Both `sourceProfile` and `destinationProfile` must include either:

- `stateRoot`, or
- the complete explicit path set: `launcherConfiguration`, `imagesDir`,
  `vmsDir`, `templateSourcesDir`, `initScriptsDir`, and `logsDir`.

All profile paths must be absolute. Image names must be launcher image names,
not paths. Destination collisions are refused.

Example:

```json
{
  "sourceProfile": {
    "profileName": "source",
    "stateRoot": "/path/to/source-profile"
  },
  "destinationProfile": {
    "profileName": "destination",
    "stateRoot": "/path/to/destination-profile"
  },
  "sourceImageName": "sample-130",
  "destinationImageName": "sample-130-copy"
}
```

The result reports source and destination image metadata, touched paths,
metadata repair, verification, and cleanup guidance.

## Cleanup Rules

Only clean up caller-owned profile state. Keep command envelopes, log files,
image names, image paths, process PIDs, and timeout reasons long enough to
debug failed runs.

For process cleanup, prefer a recorded PID from a detached launch. For image
cleanup, delete only image names created by the caller in the active profile.

See [Cleanup hook boundary](../cleanup-hook-boundary.md) for the detailed
status, timeout, stop, and cleanup contract.
