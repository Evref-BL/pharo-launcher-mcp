# Cleanup Hook Boundary For DevNexus Runner Safety

This boundary maps which pharo-launcher-mcp surfaces can be used by a future
DevNexus isolated runner. It does not authorize a live image launch in the
current dogfood cycle.

## Read-Only Inspection

These checks are safe for planning and static verification:

- `npm test`, `npm run typecheck`, and `npm run build`
- `git status --short --branch`
- source review of command schemas, parser behavior, result envelopes, and
  timeout handling
- `pharo_launcher_health`, because it reports resolved paths without invoking
  Pharo Launcher
- `pharo_launcher_config`, because it reports resolved configuration without
  invoking Pharo Launcher

These checks inspect the host or invoke Pharo Launcher and therefore need an
explicit runner approval in DevNexus dogfood cycles:

- `pharo_launcher_version`
- `pharo_launcher_validate_installation`
- `pharo_launcher_image_list`
- `pharo_launcher_image_info`
- `pharo_launcher_process_list`

They are non-mutating, but they still cross the live host boundary.

## Status Signals

The existing launcher result envelope carries the status data a runner needs:

- `ok`
- `parser.status`
- normalized `data` when parsing is supported
- raw `stdout` and `stderr`
- command `durationMs`
- command `exitCode`
- command `timedOut`
- optional `timeoutReason`

For cleanup decisions, a runner must prefer normalized image and process data.
Raw output is diagnostic evidence, not ownership proof.

## Stop And Cleanup Hooks

The mutation hooks that can participate in cleanup are:

- `pharo_launcher_process_kill` with `confirm: true`
- `pharo_launcher_image_delete` with `confirm: true`
- `pharo_launcher_image_recreate` with `confirm: true`, only for explicitly
  disposable images
- profile-root cleanup by the runner after logs and diagnostics are retained

The runner must pass either a recorded pid or an owned image name. Ambiguous
cleanup input is not allowed. It must never use these hooks against the user's
source image, default profile, unrelated images, unrelated VMs, or a process
that cannot be tied to the smoke run.

## Timeout Boundary

Every launcher call must have a bounded timeout supplied by the runner or by
the server default. A timeout means the runner records the phase as failed,
retains command metadata, and continues with owned cleanup. A timeout does not
authorize broader host cleanup.

## Profile And Artifact Boundary

A future runner must use a disposable profile rooted by
`PHARO_LAUNCHER_MCP_STATE_ROOT` or the explicit profile path variables:

- `PHARO_LAUNCHER_MCP_LAUNCHER_IMAGE`
- `PHARO_LAUNCHER_MCP_IMAGES_DIR`
- `PHARO_LAUNCHER_MCP_VMS_DIR`
- `PHARO_LAUNCHER_MCP_TEMPLATE_SOURCES_DIR`
- `PHARO_LAUNCHER_MCP_INIT_SCRIPTS_DIR`
- `PHARO_LAUNCHER_MCP_LOGS_DIR`

Retain the launcher logs, command envelopes, image names, image paths, process
pids, and timeout reasons before deleting disposable directories.

## Follow-Up Policy

No launcher-side blocking hook gap is currently identified for an isolated
PLexus smoke. pharo-launcher-mcp exposes the needed status, timeout, image
delete, and process kill primitives. PLexus or DevNexus must still orchestrate
ownership, approval, artifact retention, and idempotent cleanup.

If a future runner needs one atomic cleanup/report command instead of composing
the existing primitives, create a pharo-launcher-mcp follow-up work item before
enabling the live smoke. Do not bypass the safety gate with raw host commands.
