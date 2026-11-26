# Troubleshooting

Start with the executable's own health check:

```sh
npx @evref-bl/pharo-launcher-mcp --health
```

Health checks do not invoke Pharo Launcher. They show the resolved installation,
control image, VM path, wrapper path, profile paths, and whether those paths
exist.

## Launcher Paths Are Wrong

Set the installation paths explicitly:

```sh
export PHARO_LAUNCHER_DIR="/path/to/Pharo Launcher"
export PHARO_LAUNCHER_VM="/path/to/pharo"
export PHARO_LAUNCHER_IMAGE="/path/to/PharoLauncher.image"
export PHARO_LAUNCHER_SCRIPT="/path/to/pharo-launcher.sh"
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

A `.sh` wrapper runs through `bash` and a `.cmd` one through `cmd.exe`, so its
own execute permission does not matter. A wrapper that does not start answers a
startup diagnostic with the command, args, working directory, PATH, and active
profile variables.

## Installation Validation Fails

`pharo-launcher-mcp --validate-installation` runs `--version`. If it fails:

1. Run `pharo-launcher-mcp --health` and confirm the VM and control image
   paths, under `config`.
2. In the same report, check `config.launcherScript.exists`.
3. If using a profile, confirm the installation control image exists. The
   profile control image is copied from that source before live commands.
4. Run `npx @evref-bl/pharo-launcher-mcp --version-check` to separate MCP
   client setup from Launcher startup.

## Profile Configuration Is Refused

A profile's Launcher image and generated Launcher configuration must be inside
its state root: `PHARO_LAUNCHER_MCP_STATE_ROOT`, else
`<working directory>/.pharo-launcher-mcp/<profile>`.

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

Any other path of the layout can be moved on its own. See
[Profile mode](user/profile-mode.md).

## Template List Fails In Profile Mode

Run:

```text
template_update
template_list
```

`template_update` downloads the active profile's source list, which Launcher
leaves as it is, then probes `template list`. Its answer says when the
download or the probe failed; a failed download keeps the list the profile
has. Until it ran once, a profile has no template sources, and
`template_list` and `image_create` say so.

## Image Create Or Copy Reports An Error After Launcher Succeeds

Create and copy tools check, for up to 30 s after the command, that the Launcher
can list the new image and open it. The answer is an error when it cannot, and
says which check failed:

- `Pharo Launcher said it created X, but <images>/X does not exist after 30 s`,
  or names the file `<images>/X` lacks: the images directory holds no image
  named exactly `X`, which holds `X.image` and `X.changes`. Check that the
  active profile, or the Launcher's settings outside a profile, point at the
  images directory `config` prints.
- `Pharo Launcher made X but cannot open it: …`: the Launcher's own
  `image info X` failed, with its message.

A Launcher that refused the command answers its own message: a name already
used, or a template or category it does not know.

## Image Start Is Refused Because The VM Directory Is Too Deep

Starting an image checks first that the VM's module paths fit what the VM can
open. Pharo's FFI loads a module by absolute path through a fixed 256-byte
buffer, so a module path of 256 characters or more is never opened.

The refusal names the VM directory, the length of the longest module path, and
how many characters have to go. Shorten the path to that directory: the
state root, the profile name, or `PHARO_LAUNCHER_MCP_VMS_DIR` when it is set.

It is checked before the image starts because loading such a module does not
report a missing file. It reports a missing symbol in a file that is present,
complete, and exports that symbol, which sends the reader after the wrong
thing entirely.

The budget is the VM's, not Launcher's or this server's, so a profile that
fails under one Pharo version can pass under another: the VMs' plugin file
names differ in length.

## Process List Or Kill Does Not See A Process

Process tools use native host process queries:

- Windows: PowerShell/CIM
- macOS and Linux: `ps -axo pid=,args=`

They see only the VMs running an image of this Launcher's images directory: a
process whose command line names `<images>/D/D.image`, the path spelled as the
images directory is or as its real path. A VM of another Launcher, of another
profile, or given its image by a relative path is not listed and cannot be
killed through the server. In a profile, prefer for cleanup the pid a detached
start answered, which stops that VM and nothing else; outside one, that pid is
the Launcher's own command, so take the VM's from `process_list`. An `image`
finds the image as the other tools do, exactly, else ignoring case.

## Commands Time Out

Every call waits for a Launcher command until a timeout, and the tool then
answers that Pharo Launcher did not finish within it. The command itself goes
on: an image create still downloading its template makes the image later. Only
a VM a profile's waited start runs itself is stopped. The library's result
says so with:

- `command.timedOut: true`
- `command.timeoutReason`
- `diagnostic`, what the command wrote before the timeout, else the reason

A create or copy that outlived the timeout is still checked for about 30 s:
when its image is there, the call succeeds, and the library's
`command.timedOut` stays true.

A timeout does not authorize broader host cleanup. Cleanup should use only
recorded image names, profile roots, and PIDs that the caller owns.

