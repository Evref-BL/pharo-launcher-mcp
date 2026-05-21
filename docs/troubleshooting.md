# Troubleshooting

Start with `pharo_launcher_health` or the local CLI health check:

```sh
npx @evref-bl/pharo-launcher-mcp --health
```

Health checks do not invoke Pharo Launcher. They show the resolved installation,
control image, VM path, wrapper path, profile paths, and whether those paths
exist.

## Launcher Paths Are Wrong

Set the installation paths explicitly:

```sh
PHARO_LAUNCHER_DIR="/path/to/Pharo Launcher"
PHARO_LAUNCHER_VM="/path/to/pharo"
PHARO_LAUNCHER_IMAGE="/path/to/PharoLauncher.image"
PHARO_LAUNCHER_SCRIPT="/path/to/pharo-launcher.sh"
```

Then run:

```sh
npx @evref-bl/pharo-launcher-mcp --health
```

On macOS, the server checks user and system `PharoLauncher.app` locations before
falling back to the Application Support layout. The health report includes the
selected discovery source and all attempted candidates.

## Wrapper Is Missing

`PHARO_LAUNCHER_SCRIPT` is optional. If it is unset, the server tries the
bundled wrapper for the host platform. If that wrapper cannot be resolved, the
server invokes the VM directly with the Launcher control image.

If a selected wrapper path exists but is not executable, the command result
contains a startup diagnostic with the command, args, working directory, PATH,
and active profile variables.

## `validate_installation` Fails

`pharo_launcher_validate_installation` runs `--version`. If it fails:

1. Run `pharo_launcher_config` and confirm the VM and control image paths.
2. Run `pharo_launcher_health` and check `launcherScript.exists`.
3. If using a profile, confirm the installation control image exists. The
   profile control image is copied from that source before live commands.
4. Try `node ./dist/index.js --version-check` from a local build to separate MCP
   client setup from Launcher startup.

## Profile Configuration Is Refused

When `PHARO_LAUNCHER_MCP_STATE_ROOT` is set, the profile launcher image and
generated Launcher configuration must be inside that state root.

Use a state-root layout:

```text
<state-root>/launcher/PharoLauncher.image
<state-root>/launcher/pharo-launcher-cli-config.ston
<state-root>/images
<state-root>/vms
<state-root>/templates
<state-root>/init-scripts
<state-root>/logs
```

Or provide a complete explicit profile without relying on `stateRoot`. See
[Profile mode](user/profile-mode.md).

## Template List Fails In Profile Mode

Run:

```text
pharo_launcher_template_update
pharo_launcher_inventory
```

`template_update` seeds the active profile source list when Launcher leaves it
missing or empty, then probes `template list`. Inventory diagnostics report
missing profile directories, missing configuration files, and failed probes.

## Image Create Or Copy Reports An Error After Launcher Succeeds

Create and copy tools verify the target image after the command exits. The MCP
result is an error when the target image cannot be listed and inspected.

Check:

- the `createVerification` or `copyVerification` section
- `raw.stdout` and `raw.stderr`
- whether the image name already existed
- whether the active profile points at the expected images directory
- whether the Launcher template source list is valid

For copied images, the result also reports metadata repair and inspected image
metadata when available.

## Process List Or Kill Does Not See A Process

Process tools use native host process queries:

- Windows: PowerShell/CIM
- macOS and Linux: `ps -axo pid=,args=`

The process must have a Pharo or Squeak command line that includes a `.image`
path. For cleanup, prefer a PID captured from the detached launch result. If
using `imageName`, confirm that no unrelated process command line contains the
same text.

## Commands Time Out

Every Launcher command is bounded by a timeout. Timeout results include:

- `command.timedOut: true`
- `command.timeoutReason`
- command args
- raw stdout/stderr captured before the timeout

A timeout does not authorize broader host cleanup. Cleanup should use only
recorded image names, profile roots, and PIDs that the caller owns.

## Profile `create_from_build` Is Refused

Profile-scoped `pharo_launcher_image_create_from_build` is refused before
Launcher starts. That Launcher path can automatically launch the image and may
download or use VMs outside `PHARO_LAUNCHER_MCP_VMS_DIR`.

Use a non-`fromBuild` creation path with explicit launch control, or run the
operation outside profile mode when using the normal Launcher state is intended.
