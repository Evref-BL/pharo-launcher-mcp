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
| `pharo_launcher_inventory` | Yes | Reports profile roots, templates, image identities, declared image handles, probes, and diagnostics. |

`pharo_launcher_inventory` accepts optional `declaredImages` supplied by a
scoped caller:

```json
{
  "declaredImages": [
    {
      "imageId": "image:sample-130",
      "imageName": "sample-130",
      "status": "active"
    }
  ]
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
| `pharo_launcher_image_launch` | `imageName`, `script`, `detached`, `displayMode` |
| `pharo_launcher_image_package` | `imageName`, `location`, `zip`, `vm` |
| `pharo_launcher_image_bisect` | `pharoVersion` |
| `pharo_launcher_image_create_from_build` | `buildNumber`, `pharoVersion`, `newImageName` |
| `pharo_launcher_image_create_from_pull_request` | `pullRequest`, `newImageName`, `templateName`, `templateCategory` |
| `pharo_launcher_image_create_from_repo` | `repository`, `newImageName`, `templateName`, `templateCategory`, `subfolder`, `baseline`, `group` |
| `pharo_launcher_image_create_from_sha` | `sha`, `pharoVersion`, `newImageName` |
| `pharo_launcher_image_delete` | `imageName`, `force`, `confirm: true` |
| `pharo_launcher_image_recreate` | `imageName`, `confirm: true` |

`pharo_launcher_image_create` and `pharo_launcher_image_copy` verify the target
image after Launcher returns. A successful Launcher exit is not enough: the MCP
result is successful only when the target image can be listed and inspected.

`pharo_launcher_image_launch` supports:

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
| `pharo_launcher_vm_delete` | `vmId`, `confirm: true` |

VM update can download or install VM files. Use profile mode when automation
needs VM state isolated from a user's normal Launcher installation.

## Process Tools

| Tool | Arguments |
| --- | --- |
| `pharo_launcher_process_list` | none |
| `pharo_launcher_process_kill` | exactly one of `pid` or `imageName`, plus `confirm: true` |

On Windows, process tools use PowerShell/CIM. On macOS and Linux, they use
`ps -axo pid=,args=`. Unsupported platforms return an explicit unsupported
backend error.

Prefer PID-based cleanup when a prior detached launch returned a PID. Image-name
cleanup can match more than one process if multiple command lines contain the
same image name.

## Raw Command

`pharo_launcher_raw_command` is the escape hatch for Launcher CLI arguments not
covered by a dedicated MCP tool:

```json
{
  "args": ["image", "list", "--ston"],
  "confirm": true
}
```

It always requires `confirm: true`.

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

## Confirmation Gates

These tools require `confirm: true`:

```text
pharo_launcher_image_delete
pharo_launcher_image_recreate
pharo_launcher_vm_delete
pharo_launcher_process_kill
pharo_launcher_raw_command
```

The confirmation flag only confirms that the caller meant to cross that tool's
mutation boundary. It does not prove the image, VM, profile, or process is
caller-owned.
