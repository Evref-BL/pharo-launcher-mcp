# Cleanup Hook Boundary

This boundary maps pharo-launcher-mcp status, timeout, stop, and cleanup
surfaces for caller-managed isolated live checks. It documents the launcher
server's contract only; callers own higher-level project policy, approval,
artifact retention, and cleanup orchestration.

## Read-Only Inspection

These checks are safe for planning and static verification:

- `npm test`, `npm run typecheck`, and `npm run build`
- source review of command schemas, the library's results, and timeout
  handling
- `pharo-launcher-mcp --health`, because it reports resolved paths without
  invoking Pharo Launcher
- `config`, because it reports resolved configuration without
  invoking Pharo Launcher

These checks inspect live host state or invoke Pharo Launcher. Run them only
when the caller has chosen to cross that boundary:

- `pharo-launcher-mcp --version-check` and `--validate-installation`
- `image_list` and `image_info`, which read the
  images directory and the host's process list
- `process_list`, which reads the host's process list

They change no image and no process, but they cross the live host boundary,
and in a profile a Launcher command first lays the profile out: it creates its
directories, copies and patches the control image, and writes the Launcher's
configuration.

## Status Signals

The tools answer text, for a model. A program reads the library's launcher
results instead, which carry status data for callers:

- `ok`
- `data`, each call's own
- `failure`, why it did nothing, as a `kind`
- `diagnostic`, why it failed, in words
- `action`, what to do about it
- command `durationMs`
- command `exitCode`
- command `signal`, when one ended the command
- command `timedOut`
- optional `timeoutReason`

For cleanup decisions, callers use image and process data. A diagnostic is
evidence, not ownership proof.

## Stop And Cleanup Hooks

The mutation hooks that can participate in cleanup are:

- `process_kill`
- `image_delete`
- profile-root cleanup by the caller after logs and diagnostics are retained

The caller must pass either a recorded pid or an owned image. Ambiguous
cleanup input is not allowed. It must never use these hooks against the user's
source image, default profile, unrelated images, unrelated VMs, or a process
that cannot be tied to the caller's live check.

## Timeout Boundary

Every launcher call must have a bounded timeout supplied by the caller or by
the server default. A timeout means the caller records the phase as failed,
retains command metadata, and continues with owned cleanup. The call answers at
its timeout and a Launcher command still running goes on, so cleanup waits for
it, or finds its VM with `process_list`, before deleting the profile. A
timeout does not authorize broader host cleanup.

## Profile And Artifact Boundary

An isolated live check uses a disposable profile rooted by
`PHARO_LAUNCHER_MCP_STATE_ROOT`, any of whose paths the explicit profile path
variables may move:

- `PHARO_LAUNCHER_MCP_LAUNCHER_IMAGE`
- `PHARO_LAUNCHER_MCP_IMAGES_DIR`
- `PHARO_LAUNCHER_MCP_VMS_DIR`
- `PHARO_LAUNCHER_MCP_TEMPLATE_SOURCES_DIR`
- `PHARO_LAUNCHER_MCP_INIT_SCRIPTS_DIR`
- `PHARO_LAUNCHER_MCP_LOGS_DIR`

Retain the launcher logs, the library's results, image names, image paths,
process pids, and timeout reasons before deleting disposable directories.

## What The Caller Owns

pharo-launcher-mcp gives the status, timeout, image delete, and process kill a
caller-managed live check needs. The caller owns which images and processes are
its own, approval, keeping artifacts, and cleanup that can run twice. It does
not reach past them with raw host commands.
