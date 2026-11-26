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
PHARO_LAUNCHER_MCP_PROFILE=isolated PHARO_LAUNCHER_MCP_STATE_ROOT=/path/to/launcher-profile npx @evref-bl/pharo-launcher-mcp --health
```

A profile always has a state root: `PHARO_LAUNCHER_MCP_STATE_ROOT`, else
`<working directory>/.pharo-launcher-mcp/<profile>`, the profile being
`PHARO_LAUNCHER_MCP_PROFILE`, else `default`. A relative path is read from the
server's working directory. The server derives the profile layout:

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
instead, writing its reason to standard error. Before creating an image, the
Launcher checks its template sources for an update among the user's own
Launcher files, whatever the profile says; the copy skips that check, since a
profile's sources are its own. The installation control image is never
changed.

## Explicit Profile Paths

Each path of the layout can be moved on its own, the state root still holding
the profile's Launcher image:

```sh
export PHARO_LAUNCHER_MCP_STATE_ROOT=/path/to/profile
export PHARO_LAUNCHER_MCP_LAUNCHER_IMAGE=/path/to/profile/launcher/PharoLauncher.image
export PHARO_LAUNCHER_MCP_IMAGES_DIR=/shared/images
export PHARO_LAUNCHER_MCP_VMS_DIR=/shared/vms
export PHARO_LAUNCHER_MCP_TEMPLATE_SOURCES_DIR=/path/to/profile/templates
export PHARO_LAUNCHER_MCP_INIT_SCRIPTS_DIR=/path/to/profile/init-scripts
export PHARO_LAUNCHER_MCP_LOGS_DIR=/path/to/profile/logs
```

`PHARO_LAUNCHER_MCP_LAUNCHER_CONFIGURATION` says where the server writes the
Launcher CLI configuration it generates, inside the state root: a relative
value is resolved under `<state-root>/launcher`, and by default it is
`<state-root>/launcher/pharo-launcher-cli-config.ston`. The server rewrites
that file whenever it differs from the profile's paths, so a configuration of
one's own is used only outside a profile.

The generated configuration points the Launcher at the profile's directories.

The profile's Launcher image and generated configuration must stay inside the
state root. The server refuses to write them outside it.

## Template Sources

In profile mode, `template_update` downloads the default Pharo Launcher source
list into the active profile, since the official templates' names change with
each Pharo release, then probes `template list`. It does not run the
Launcher's own `template update`, which updates the list among the Launcher's
user files whatever the profile says.

Its answer says when the list changed, and when downloading it or the probe
failed. A failed download keeps the list the profile has. Until the profile
has a source list, `template_list` and `image_create` answer that there are no
templates yet, and to call `template_update` first; the library's
`listTemplates` and `createImage` answer the `failure` kind `no-templates`.

## Image Launch In Profile Mode

For profile-scoped image launch, pharo-launcher-mcp resolves the image inside
`PHARO_LAUNCHER_MCP_IMAGES_DIR` and runs it with a VM inside
`PHARO_LAUNCHER_MCP_VMS_DIR`. If the VM is missing, the server asks Launcher to
install that VM into the profile VM directory before launch.

Launch supports:

```json
{
  "image": "sample-130",
  "script": "/path/to/serve.st",
  "detached": true
}
```

A headless image, the default, has nothing to do without a script, and quits.
`displayMode` can be `headless` or `interactive`, and only here: PharoLauncher's
own `image launch` has no display mode, so outside profile mode a launch that
asks for one is refused. Detached launches return the VM's pid and log paths
under the profile log directory. Each detached start leaves the logs of the
image's last three detached starts and, when the log directory is inside the
state root, removes those of images the profile no longer holds; a delete
removes the image's.

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
and named. Image names must be launcher image names, not paths. The source is
found as every call finds an image, exactly, else ignoring case, and must hold
`<image>.image`, `<image>.changes` and `meta-inf.ston`. A new name an image of
the destination has already, in any case, is refused, and so is an existing
directory of that name.

Example:

```json
{
  "sourceProfile": { "imagesDir": "/path/to/Pharo/images" },
  "destinationProfile": { "stateRoot": "/path/to/destination-profile" },
  "image": "sample-130",
  "newImage": "sample-130-copy"
}
```

The tool answers one line naming the image and both profiles, each by its
`stateRoot` (or its `imagesDir` when it has none), then the copy's path. A
failure says what went wrong and the way out. A destination
that already exists is named by its directory: copy under another name, or
remove that directory, which is not an image. An existing image is never
replaced.

The library's `copyImageBetweenProfiles` answers as `copyImage` does, its
`data` being the copy, and says where the copy is: `source` and `destination`,
each with its directory and image file. A failure adds `failure`, whose `kind`
names what went wrong (`profile-path-missing`, `no-such-image`, `no-metadata`,
`name-taken`, `destination-exists`, `preflight`, `post-move` or
`exception`), next to its `diagnostic` and, when something can be done,
`action`. With `profile-path-missing`, `failure.paths` names each path that
does not exist, by profile and field.

## Cleanup Rules

Only clean up caller-owned profile state. Keep the library's results, log
files, image names, image paths, process PIDs, and timeout reasons long enough
to debug failed runs.

For process cleanup, prefer the pid a detached start in the profile answered,
which is the VM's. For image cleanup, delete only image names created by the
caller in the active profile.

See [Cleanup hook boundary](../cleanup-hook-boundary.md) for the detailed
status, timeout, stop, and cleanup contract.
