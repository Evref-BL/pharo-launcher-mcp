# Tool Reference

pharo-launcher-mcp exposes MCP tools over stdio. Most tools call Pharo Launcher
and return a normalized launcher result envelope. Health and configuration tools
only inspect local paths.

## Health And Configuration

| Tool | Live Launcher invocation | Purpose |
| --- | --- | --- |
| `pharo_launcher_health` | No | Reports service version, resolved paths, wrapper source, and existence checks. |
| `pharo_launcher_config` | No | Reports resolved installation, profile, wrapper, and configuration paths. |
| `pharo_launcher_version` | Yes | Runs `--version`. |
| `pharo_launcher_validate_installation` | Yes | Checks resolved paths and runs `--version`. |
| `pharo_launcher_inventory` | Yes | Reports profile roots, templates, image identities, probes, and diagnostics. |

`pharo_launcher_inventory` reports what the host has. It holds no caller state
and takes no declaration of what should exist; a caller that tracks its own
images matches them against `images.existing` itself.

`pharo_launcher_inventory` accepts an optional `templateCreateRequest` and
answers whether that image could be created offline, without downloading or
mutating anything:

```json
{
  "templateCreateRequest": {
    "templateName": "Pharo 13.0 - 64bit",
    "templateCategory": "Official distributions"
  }
}
```

## Image Tools

| Tool | Arguments |
| --- | --- |
| `pharo_launcher_image_list` | `nameFilter`, table options |
| `pharo_launcher_image_info` | `imageName`, table options |
| `pharo_launcher_image_create` | `templateName`, `newImageName`, `templateCategory`, `dev`, `noLaunch` |
| `pharo_launcher_image_copy` | `imageName`, `newImageName` |
| `pharo_launcher_image_copy_between_profiles` | `sourceProfile`, `destinationProfile`, `sourceImageName`, `destinationImageName` |
| `pharo_launcher_image_start` | `imageName`, `script`, `detached`, `displayMode` |
| `pharo_launcher_image_package` | `imageName`, `location`, `zip`, `vm` |
| `pharo_launcher_image_bisect` | `pharoVersion` |
| `pharo_launcher_image_create_from_build` | `buildNumber`, `pharoVersion`, `newImageName` |
| `pharo_launcher_image_create_from_pull_request` | `pullRequest`, `newImageName`, `templateName`, `templateCategory` |
| `pharo_launcher_image_create_from_repo` | `repository`, `newImageName`, `templateName`, `templateCategory`, `subfolder`, `baseline`, `group` |
| `pharo_launcher_image_create_from_sha` | `sha`, `pharoVersion`, `newImageName` |
| `pharo_launcher_image_delete` | `imageName`, `force` |
| `pharo_launcher_image_recreate` | `imageName` |

`pharo_launcher_image_create` and `pharo_launcher_image_copy` verify the target
image after Launcher returns. A successful Launcher exit is not enough: the MCP
result is successful only when the target image can be listed and inspected.

`pharo_launcher_image_start` supports:

- `displayMode: "headless"` or `"interactive"`
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
| `pharo_launcher_template_info` | `templateName`, `templateCategory` |
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

## VM Tools

| Tool | Arguments |
| --- | --- |
| `pharo_launcher_vm_list` | `vmId`, table options |
| `pharo_launcher_vm_info` | `vmId` |
| `pharo_launcher_vm_update` | `vmId` |
| `pharo_launcher_vm_delete` | `vmId` |

VM update can download or install VM files. Use profile mode when automation
needs VM state isolated from a user's normal Launcher installation.

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

## Raw Command

`pharo_launcher_raw_command` is the escape hatch for Launcher CLI arguments not
covered by a dedicated MCP tool:

```json
{
  "args": ["image", "list", "--ston"]
}
```

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
towards it: `pharo_launcher_inventory` and `pharo_launcher_image_list` for what
exists, `pharo_launcher_process_list` for what runs, profile scoping for
keeping a caller's images and VMs out of the user's own Launcher state, and
targets that mean one thing — a PID stops one process.
