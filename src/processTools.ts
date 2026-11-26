import { spawn } from "node:child_process";
import path from "node:path";
import type { LauncherCliResult } from "./launcherCli.js";
import {
  afterLeadingDigits,
  hasCaseInsensitiveSuffix,
  leadingDigits,
  quotedValues,
  whitespaceTokens,
} from "./textTokens.js";

type ProcessBackendId = "windows-powershell" | "posix-ps" | "unsupported";

interface WindowsProcessRecord {
  ProcessId?: number;
  ExecutablePath?: string;
  CommandLine?: string;
}

/**
 * A Pharo process of the machine, as its command line shows it: the image it
 * names, when it names one, read from that line alone.
 */
export interface NativeProcess {
  pid: number;
  commandLine: string;
  executablePath?: string;
  imagePath?: string;
  imageName?: string;
}

type PharoProcessRecord = NativeProcess;

export interface NativeProcessToolCapability {
  platform: NodeJS.Platform;
  backend: ProcessBackendId;
  supported: boolean;
  reason?: string;
}

export type NativeProcessCommandRunner = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<string>;

export interface RunNativeProcessToolOptions {
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  runCommand?: NativeProcessCommandRunner;
  killProcess?: (pid: number) => void;
  /** Whether a pid still runs; by default `process.kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean;
}

/**
 * Which of the machine's Pharo processes a call sees, and what a kill given an
 * image name stops among them.
 */
export interface NativeProcessScope {
  select(processes: readonly NativeProcess[]): NativeProcess[];
  imageTargets(
    processes: readonly NativeProcess[],
    imageName: string,
  ): NativeProcess[];
}

/** Every Pharo VM on the machine, an image named as its command line names it. */
export const machineWideProcessScope: NativeProcessScope = {
  select: (processes) => [...processes],
  imageTargets: (processes, target) =>
    processes.filter(
      (process) => process.imageName === target || process.imagePath === target,
    ),
};

/** Whether a pid runs: signal 0 checks without killing, `ESRCH` is gone. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function duration(startTime: number): number {
  return Date.now() - startTime;
}

function basenameWithoutImageExtension(imagePath: string): string {
  return path.basename(imagePath).replace(/\.image$/i, "");
}

function mentionsPharoRuntime(commandLine: string): boolean {
  const lower = commandLine.toLowerCase();
  return lower.includes("pharo") || lower.includes("squeak");
}

function imagePathFromCommandLine(commandLine: string): string | undefined {
  const quoted = quotedValues(commandLine).find((value) =>
    hasCaseInsensitiveSuffix(value, ".image"),
  );
  return (
    quoted ??
    whitespaceTokens(commandLine).find((value) =>
      hasCaseInsensitiveSuffix(value, ".image"),
    )
  );
}

function processLine(process: PharoProcessRecord): string {
  return [
    String(process.pid),
    process.executablePath ? `"${process.executablePath}"` : undefined,
    process.imagePath ? `"${process.imagePath}"` : undefined,
    `"${process.commandLine.replaceAll('"', "'")}"`,
  ]
    .filter(Boolean)
    .join(" ");
}

function runProcessCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Under the C locale ps writes a non-ASCII byte as `M-CM-)`, and no image
    // path matches a command line spelled so.
    const child = spawn(command, [...args], {
      windowsHide: true,
      env: { ...process.env, LC_ALL: "C.UTF-8" },
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(
        new Error(`${command} process query timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      if (exitCode === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr.trim() || `${command} exited with ${exitCode}`));
      }
    });
  });
}

function parseWindowsProcessJson(source: string): WindowsProcessRecord[] {
  const trimmed = source.trim();
  if (!trimmed) {
    return [];
  }

  const parsed = JSON.parse(trimmed) as
    | WindowsProcessRecord
    | WindowsProcessRecord[]
    | null;
  if (!parsed) {
    return [];
  }

  return Array.isArray(parsed) ? parsed : [parsed];
}

async function listWindowsPharoProcesses(
  timeoutMs: number,
  runCommand: NativeProcessCommandRunner,
): Promise<PharoProcessRecord[]> {
  // Windows PowerShell writes in the console's code page unless told.
  const script = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;",
    "$processes = Get-CimInstance Win32_Process |",
    "Where-Object { $_.CommandLine -and $_.CommandLine -match '\\.image' -and ($_.Name -match 'Pharo|Squeak') } |",
    "Select-Object ProcessId, ExecutablePath, CommandLine;",
    "$processes | ConvertTo-Json -Compress",
  ].join(" ");
  const json = await runCommand(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    timeoutMs,
  );

  return parseWindowsProcessJson(json)
    .map((record) => {
      const commandLine = record.CommandLine ?? "";
      const imagePath = imagePathFromCommandLine(commandLine);
      const pid = record.ProcessId;

      if (!pid || !commandLine) {
        return undefined;
      }

      return {
        pid,
        commandLine,
        ...(record.ExecutablePath
          ? { executablePath: record.ExecutablePath }
          : {}),
        ...(imagePath
          ? {
              imagePath,
              imageName: basenameWithoutImageExtension(imagePath),
            }
          : {}),
      };
    })
    .filter((process): process is PharoProcessRecord => Boolean(process));
}

function executablePathFromCommandLine(commandLine: string): string | undefined {
  const quoted = commandLine.match(/^"([^"]+)"/)?.[1];

  return quoted ?? commandLine.match(/^(\S+)/)?.[1];
}

export function parsePosixProcessTable(source: string): PharoProcessRecord[] {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): PharoProcessRecord | undefined => {
      const pidText = leadingDigits(line);
      const commandLine = afterLeadingDigits(line);
      if (!pidText || !commandLine) {
        return undefined;
      }

      const pid = Number(pidText);
      const imagePath = imagePathFromCommandLine(commandLine);
      if (!pid || !imagePath || !mentionsPharoRuntime(commandLine)) {
        return undefined;
      }
      const executablePath = executablePathFromCommandLine(commandLine);

      return {
        pid,
        commandLine,
        ...(executablePath ? { executablePath } : {}),
        imagePath,
        imageName: basenameWithoutImageExtension(imagePath),
      };
    })
    .filter((process): process is PharoProcessRecord => Boolean(process));
}

async function listPosixPharoProcesses(
  timeoutMs: number,
  runCommand: NativeProcessCommandRunner,
): Promise<PharoProcessRecord[]> {
  const stdout = await runCommand("ps", ["-axo", "pid=,args="], timeoutMs);

  return parsePosixProcessTable(stdout);
}

export function nativeProcessToolCapability(
  platform: NodeJS.Platform = process.platform,
): NativeProcessToolCapability {
  if (platform === "win32") {
    return {
      platform,
      backend: "windows-powershell",
      supported: true,
    };
  }

  if (platform === "darwin" || platform === "linux") {
    return {
      platform,
      backend: "posix-ps",
      supported: true,
    };
  }

  return {
    platform,
    backend: "unsupported",
    supported: false,
    reason: `listing processes is not supported on ${platform}`,
  };
}

export function shouldUseNativeProcessTool(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return nativeProcessToolCapability(platform).supported;
}

async function listNativePharoProcesses(
  capability: NativeProcessToolCapability,
  timeoutMs: number,
  runCommand: NativeProcessCommandRunner,
): Promise<PharoProcessRecord[]> {
  if (capability.backend === "windows-powershell") {
    return listWindowsPharoProcesses(timeoutMs, runCommand);
  }

  if (capability.backend === "posix-ps") {
    return listPosixPharoProcesses(timeoutMs, runCommand);
  }

  throw new Error(capability.reason ?? "listing processes is not supported");
}

/**
 * The machine's Pharo processes: each line of the native list that names a
 * `.image` and mentions pharo or squeak. Throws why it cannot list them.
 */
export async function listNativeProcesses(
  options: RunNativeProcessToolOptions = {},
): Promise<NativeProcess[]> {
  return listNativePharoProcesses(
    nativeProcessToolCapability(options.platform),
    options.timeoutMs ?? 30_000,
    options.runCommand ?? runProcessCommand,
  );
}

interface KillFailure {
  pid: number;
  diagnostic: string;
}

/**
 * Kill every target, and say which kills failed. A pid gone meanwhile
 * (`ESRCH`) is stopped, which is what the kill was for.
 */
function killEach(
  targets: readonly NativeProcess[],
  killProcess: (pid: number) => void,
): { killed: number[]; failures: KillFailure[] } {
  const killed: number[] = [];
  const failures: KillFailure[] = [];
  for (const { pid } of targets) {
    try {
      killProcess(pid);
      killed.push(pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        killed.push(pid);
      } else {
        failures.push({
          pid,
          diagnostic: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return { killed, failures };
}

export async function runNativeProcessTool(
  args: readonly string[],
  optionsOrTimeoutMs: number | RunNativeProcessToolOptions = 30_000,
  scope: NativeProcessScope = machineWideProcessScope,
): Promise<LauncherCliResult> {
  const options =
    typeof optionsOrTimeoutMs === "number"
      ? { timeoutMs: optionsOrTimeoutMs }
      : optionsOrTimeoutMs;
  const killProcess = options.killProcess ?? ((pid: number) => process.kill(pid));
  const startTime = Date.now();
  const failed = (stderr: string): LauncherCliResult => ({
    exitCode: 1,
    stdout: "",
    stderr,
    durationMs: duration(startTime),
    timedOut: false,
  });

  try {
    const processes = scope.select(await listNativeProcesses(options));

    if (args[0] === "process" && args[1] === "list") {
      return {
        exitCode: 0,
        stdout: processes.map(processLine).join("\n"),
        stderr: "",
        durationMs: duration(startTime),
        timedOut: false,
        processes,
      };
    }

    if (args[0] === "process" && args[1] === "kill") {
      // The target's kind is its flag: an image may be named with digits.
      const [, , flag, target] = args;
      if ((flag !== "--pid" && flag !== "--image") || !target) {
        return failed("process kill requires --pid or --image");
      }

      const targets =
        flag === "--pid"
          ? processes.filter((process) => String(process.pid) === target)
          : scope.imageTargets(processes, target);
      if (targets.length === 0) {
        return { ...failed(`No matching Pharo process found for ${target}`), processFailure: "no-match" };
      }

      const { killed, failures } = killEach(targets, killProcess);
      return {
        exitCode: failures.length === 0 ? 0 : 1,
        stdout: killed.map((pid) => `Killed ${pid}`).join("\n"),
        stderr: failures
          .map(({ pid, diagnostic }) => `Could not kill pid ${pid}: ${diagnostic}`)
          .join("\n"),
        durationMs: duration(startTime),
        timedOut: false,
        processes: targets,
        kill: { killed, failures },
      };
    }

    return failed(`Unsupported native process tool args: ${args.join(" ")}`);
  } catch (error) {
    return {
      ...failed(error instanceof Error ? error.message : String(error)),
      processFailure: "list-failed",
    };
  }
}
