# Tool Reference

pharo-launcher-mcp exposes MCP tools over stdio. Each tool answers plain text,
for a model to read: a sentence saying what happened, then `Warning: …` lines,
`key: value` lines and indented lists. A failure has `isError` and says what to
do when the caller can do something. The library the tools are made from,
`openPharoLauncher`, answers typed objects instead (see
[Library results](#library-results)).

Every tool here has a caller. PharoLauncher's CLI covers the rest of its own
surface, and this server does not wrap a subcommand until something asks it to.

Checking the installation is not a tool, because a caller doing it is not yet
speaking MCP. The executable answers `--health`, `--version-check`,
`--validate-installation` and `--probe-images` and exits, which is what a
preflight needs.

A tool takes only the arguments its schema names. Any other argument is
ignored.

## Configuration

| Tool | Live Launcher invocation | Purpose |
| --- | --- | --- |
| `pharo_launcher_config` | No | Says which Pharo Launcher the server runs, its profile or settings file, and where its images are. |

## Images

An image of the Launcher is a directory `D` of its images directory holding
the files `D.image` and `D.changes`, Pharo Launcher's own rule. The image tools
read that directory; they do not ask the Launcher to list it. A name given to a
tool finds the image named exactly so, else the one whose name differs only in
case, as the Launcher does.

The images directory is, in profile mode, the profile's. Outside a profile it
is the `#imagesDirectory` of the configuration the Launcher's CLI reads: the
file `PHARO_LAUNCHER_MCP_LAUNCHER_CONFIGURATION` names, else
`launcherSettings.ston` in the Launcher's user files (`~/Documents/Pharo` on
macOS and Windows, `~/Pharo` on Linux), else `<user files>/images`, the
Launcher's default. `pharo_launcher_config` prints which.

| Tool | Arguments |
| --- | --- |
| `pharo_launcher_image_list` | `nameFilter` |
| `pharo_launcher_image_info` | `imageName` |
| `pharo_launcher_image_create` | `templateName`, `newImageName`, `templateCategory`, `dev` |
| `pharo_launcher_image_copy` | `imageName`, `newImageName` |
| `pharo_launcher_image_copy_between_profiles` | `sourceProfile`, `destinationProfile`, `sourceImageName`, `destinationImageName` |
| `pharo_launcher_image_start` | `imageName`, `script`, `detached`, `displayMode` |
| `pharo_launcher_image_delete` | `imageName` |

`pharo_launcher_image_list` and `pharo_launcher_image_info` call no Launcher
command. Each image comes with its Pharo version, architecture and template,
read from its `meta-inf.ston`, its `pharo.version` and its image header, and
with the pids of the VMs running it. `nameFilter` keeps the names that contain
it, case-sensitive. A directory that is not an image is named in a warning,
with the file it lacks.

`pharo_launcher_image_create` never starts the image it makes:
`pharo_launcher_image_start` does.

`pharo_launcher_image_create` and `pharo_launcher_image_copy` check that the
Launcher can list the new image and open it, polling for up to 30 s after the
command, and also after a command that outlived the call's timeout, since the
Launcher goes on and makes the image. In profile mode, listed means the images
directory holds it under the exact new name; outside a profile only the
Launcher's `image info` is asked. A successful Launcher exit is not enough, and
a failed check is an error that says which check failed.

In profile mode, where the server wrote the images directory itself, a name it
does not find is refused before any Launcher call (`image_info`,
`image_start`, `image_delete`, and `image_copy`'s source), and so is a new name
an image already has, in any case. Outside a profile those names go to the
Launcher, whose answer is the answer.

`pharo_launcher_image_start` supports:

- `displayMode: "headless"` or `"interactive"`, in profile mode only.
  PharoLauncher's own `image launch` has no display mode, so outside profile
  mode the launch is refused rather than started with the mode dropped.
- `detached: true` to leave the image running: the answer names its pid and
  its log files. Otherwise the call lasts until the image quits. The logs
  directory keeps the logs of an image's last three starts, so those a
  failed start names outlive two more. In profile mode, from a logs directory
  inside the state root, a detached start also removes the logs of images the
  profile no longer holds.
- `script` for a launch script passed to Launcher, or evaluated by the profile
  VM launch path. A relative path is read from the server's working directory,
  not from the image's or Launcher's. A headless image given no script has
  nothing to run and quits.

In profile mode, image launch resolves the image and VM inside the active
profile roots instead of using Launcher defaults.

`pharo_launcher_image_delete` deletes without asking: calling it is the
confirmation. Launcher's own `image delete` asks on standard input, where a
call has nobody to answer. It refuses an image a VM runs, in every mode, and
refuses when it cannot tell: stop the image with
`pharo_launcher_process_kill` first. It deletes the logs of the image's
starts with it.

## Template Tools

| Tool | Arguments |
| --- | --- |
| `pharo_launcher_template_category_list` | none |
| `pharo_launcher_template_list` | `templateCategory` |
| `pharo_launcher_template_update` | none |

The categories come in the Launcher's order, with the one it marks as its
default. A template list names templates only: a name is what
`pharo_launcher_image_create` takes.

In profile mode, `pharo_launcher_template_update` also verifies that the active
profile source list is usable and probes `template list`.

## Process Tools

| Tool | Arguments |
| --- | --- |
| `pharo_launcher_process_list` | none |
| `pharo_launcher_process_kill` | exactly one of `pid` or `imageName` |

The process tools see the VMs running an image of this Launcher's images
directory, in every mode, and no other process: a VM runs image `D` when its
command line names `<images>/D/D.image`. So `pharo_launcher_image_list`'s
running state and `pharo_launcher_process_list` agree, and a kill cannot reach
an image of another Launcher or profile.

On Windows, process tools use PowerShell/CIM. On macOS and Linux, they use
`ps -axo pid=,args=`. On any other platform they fail, saying that listing
processes is not supported there.

A pid stops that process alone. An image name stops every process running that
image: an image launched more than once has more than one. The answer comes
once every killed process is gone, or says which one still runs 10 s later.

Prefer the PID returned by a prior detached launch when cleaning up a launch
you own.

## Library results

The tools answer text. The library's functions answer objects, which a program
reads instead: `listImages` answers `{ imagesDir, images, notImages,
processListFailure? }` and `imageInfo` `{ found, imagesDir, image? }`. The
functions that run a Launcher command answer a `LauncherCommandResult`:

```ts
{
  ok: boolean;
  data?: unknown;
  diagnostic?: string;
  action?: string;
  parser: {
    status: "parsed" | "unsupported" | "failed" | "skipped";
    format: "ston" | "text";
    message?: string;
  };
  raw?: {
    stdout: string;
    stderr: string;
    format: "ston" | "text";
  };
  command: {
    args: string[];
    durationMs: number;
    exitCode: number | null;
    signal?: NodeJS.Signals;
    timedOut: boolean;
    timeoutReason?: string;
  };
  launch?: LauncherLaunchReport;
}
```

Use `ok` and `data` for program flow. `raw` is there when the call passed
`includeRaw: true`; treat `raw.stdout` and `raw.stderr` as diagnostics. A
create or copy's `data` is `{ image?: LauncherImage }`, and its `failure` says
why a command that exited 0 made no image: never listed or never opened. A
start's `launch` says what it ran, including a run a signal ended, which has
`command.signal` and no exit code.

`listTemplates` leaves out the templates the Launcher keeps on disk unless
given `includeLocal: true`, as the tool is: the Launcher keeps a copy of every
template it downloads, under the same name, in a category of its own. The
templates the user made from an image are in that category too, of the same
class, so a library caller sees them only with `includeLocal: true`, whether
or not it names a category.

## Mutation Boundary

No tool takes a confirmation argument. A confirmation could only say that the
caller meant to call the tool, which calling it already says; it never proved
the image, VM, profile, or process was caller-owned, and that is the thing
worth knowing.

Deciding what is caller-owned is the caller's job. What this server offers
towards it: `pharo_launcher_image_list` for what exists,
`pharo_launcher_process_list` for what runs, profile scoping for keeping a
caller's images and VMs out of the user's own Launcher state, and targets that
mean one thing — a PID stops one process.
