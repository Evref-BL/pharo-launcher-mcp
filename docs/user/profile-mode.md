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

It also changes the profile's copy of the control image once, and records it
in `pharo-launcher-mcp-patches` beside the image, so that the CLI can create
images from templates hosted on GitHub. github.com answers with header lines
longer than the 4096 characters the Launcher's Zinc reads, so the copy reads
longer ones. And the Launcher answers a failed download with a retry dialog,
which a headless command waits on forever, so the copy fails the download
instead, writing its reason to standard error. The installation control image
is never changed.

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

In profile mode, `template_update` downloads the default Pharo
Launcher source list into the active profile after Launcher returns, since
Launcher does not update a profile's copy and the official templates' names
change with each Pharo release, then probes `template list`.

Its answer says when the list changed, and when downloading it or the probe
failed. A failed download keeps the list the profile has. Until the
profile has a source list, `template_list` and
`image_create` answer that there are no templates yet, and to
call `template_update` first.

## Image Launch In Profile Mode

For profile-scoped image launch, pharo-launcher-mcp resolves the image inside
`PHARO_LAUNCHER_MCP_IMAGES_DIR` and runs it with a VM inside
`PHARO_LAUNCHER_MCP_VMS_DIR`. If the VM is missing, the server asks Launcher to
install that VM into the profile VM directory before launch.

Launch supports:

```json
{
  "image": "sample-130",
  "displayMode": "headless",
  "detached": true
}
```

`displayMode` can be `headless` or `interactive`, and only here: PharoLauncher's
own `image launch` has no display mode, so outside profile mode a launch that
asks for one is refused. Detached launches return the spawned PID and log paths
under the profile log directory. Each start leaves the logs of the image's last
three starts and, when the log directory is inside the state root, removes those
of images the profile no longer holds; a delete removes the image's.

## Cross-Profile Image Copy

`image_copy_between_profiles` copies an existing image directory from one images
directory to another, such as from the user's own Launcher into a profile,
without relying on the active server profile. Nothing runs: the files are
copied, renamed, and checked.

`sourceProfile` and `destinationProfile` each give one of:

- `stateRoot`, the directory that holds the profile's `images/` directory, or
- `imagesDir`, an images directory itself, such as the user's own
  Launcher's.

`config` prints the active profile's `stateRoot`. Both paths must be absolute,
and must exist: the copy creates none. A `stateRoot` that does not exist or
holds no `images/` directory, and an `imagesDir` that does not exist, is refused
and named. Image names must be launcher image names, not paths. Destination
collisions are refused.

Example:

```json
{
  "sourceProfile": { "imagesDir": "/Users/me/Documents/Pharo/images" },
  "destinationProfile": { "stateRoot": "/path/to/destination-profile" },
  "image": "sample-130",
  "newImage": "sample-130-copy"
}
```

The tool answers one line naming the image and both profiles, each by its
`stateRoot` (or its `imagesDir` when it has none), then the copy's path. A
failure says what went wrong and the way out. A destination
that already exists is named by its directory: copy under another name, or
delete it with the destination profile active. An existing image is never
replaced.

The library's `copyImageBetweenProfiles` answers where the copy is: `source`,
and `destination` with its directory and image file. A failure adds `failure`,
which names what went wrong (`profile-path-missing`, `source-missing`,
`source-image-missing`, `source-metadata-missing`, `destination-exists`,
`preflight`, `post-move` or `exception`), next to its `diagnostic` and, when
something can be done, `action`. With `profile-path-missing`,
`missingProfilePaths` names each path that does not exist, by profile and
field.

## Cleanup Rules

Only clean up caller-owned profile state. Keep the library's results, log
files, image names, image paths, process PIDs, and timeout reasons long enough
to debug failed runs.

For process cleanup, prefer a recorded PID from a detached launch. For image
cleanup, delete only image names created by the caller in the active profile.

See [Cleanup hook boundary](../cleanup-hook-boundary.md) for the detailed
status, timeout, stop, and cleanup contract.
