# Tool Reference

pharo-launcher-mcp exposes MCP tools over stdio. Most tools call Pharo Launcher
and return a normalized launcher result envelope.

Every tool here has a caller. PharoLauncher's CLI covers the rest of its own
surface, and this server does not wrap a subcommand until something asks it to.

Checking the installation is not a tool, because a caller doing it is not yet
speaking MCP. The executable answers `--health`, `--version-check`,
`--validate-installation` and `--probe-images` and exits, which is what a
preflight needs.

## Configuration

| Tool | Live Launcher invocation | Purpose |
| --- | --- | --- |
| `pharo_launcher_config` | No | Reports resolved installation, profile, wrapper, and configuration paths. |

## Image Tools

| Tool | Arguments |
| --- | --- |
| `pharo_launcher_image_list` | `nameFilter`, table options |
| `pharo_launcher_image_info` | `imageName`, table options |
| `pharo_launcher_image_create` | `templateName`, `newImageName`, `templateCategory`, `dev`, `noLaunch` |
| `pharo_launcher_image_copy` | `imageName`, `newImageName` |
| `pharo_launcher_image_copy_between_profiles` | `sourceProfile`, `destinationProfile`, `sourceImageName`, `destinationImageName` |
| `pharo_launcher_image_start` | `imageName`, `script`, `detached`, `displayMode` |
| `pharo_launcher_image_delete` | `imageName`, `force` |

`pharo_launcher_image_create` and `pharo_launcher_image_copy` verify the target
image after Launcher returns. A successful Launcher exit is not enough: the MCP
result is successful only when the target image can be listed and inspected.

`pharo_launcher_image_start` supports:

- `displayMode: "headless"` or `"interactive"`, in profile mode only.
  PharoLauncher's own `image launch` has no display mode, so outside profile
  mode the launch is refused rather than started with the mode dropped.
- `detached: true` for detached launches with log paths in the result
- `script` for a launch script passed to Launcher, or evaluated by the profile
  VM launch path

In profile mode, image launch resolves the image and VM inside the active
profile roots instead of using Launcher defaults.

## Template Tools

| Tool | Arguments |
| --- | --- |
| `pharo_launcher_template_category_list` | table options |
| `pharo_launcher_template_list` | `templateCategory`, table options |
| `pharo_launcher_template_update` | none |

Table options are:

```json
{
  "format": "ston",
  "brief": true,
  "rowMode": true,
  "delimiter": "|"
}
```

`format` can be `ston` or `text`. The default is `ston` when a tool supports
table output.

In profile mode, `pharo_launcher_template_update` also verifies that the active
profile source list is usable and probes `template list`.

## Process Tools

| Tool | Arguments |
| --- | --- |
| `pharo_launcher_process_list` | none |
| `pharo_launcher_process_kill` | exactly one of `pid` or `imageName` |

On Windows, process tools use PowerShell/CIM. On macOS and Linux, they use
`ps -axo pid=,args=`. Unsupported platforms return an explicit unsupported
backend error.

A kill matches the target it was given. An all-digit target is a PID and
matches that process only. Any other target is an image, and matches a process
whose image name or image path is exactly that. An image launched more than
once has more than one process, so an image-name kill can still stop several.

Prefer the PID returned by a prior detached launch when cleaning up a launch
you own.

## Result Envelope

Launcher tools return JSON shaped like this:

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
  raw: {
    stdout: string;
    stderr: string;
    format: "ston" | "text";
  };
  command: {
    args: string[];
    durationMs: number;
    exitCode: number | null;
    timedOut: boolean;
    timeoutReason?: string;
  };
}
```

Use `ok` and normalized `data` for program flow. Treat `raw.stdout` and
`raw.stderr` as diagnostics.

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
