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

interface PharoProcessRecord {
  pid: number;
  executablePath?: string;
  imagePath?: string;
  imageName?: string;
  commandLine: string;
}

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
    const child = spawn(command, [...args], {
      windowsHide: true,
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
  const script = [
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

function matchesTarget(process: PharoProcessRecord, target: string): boolean {
  return (
    String(process.pid) === target ||
    process.imageName === target ||
    process.imagePath === target ||
    process.commandLine.includes(target)
  );
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
    reason: `Native process backend is not supported on ${platform}`,
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

  throw new Error(capability.reason ?? "Native process backend is not supported");
}

export async function runNativeProcessTool(
  args: readonly string[],
  optionsOrTimeoutMs: number | RunNativeProcessToolOptions = 30_000,
): Promise<LauncherCliResult> {
  const options =
    typeof optionsOrTimeoutMs === "number"
      ? { timeoutMs: optionsOrTimeoutMs }
      : optionsOrTimeoutMs;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const capability = nativeProcessToolCapability(options.platform);
  const runCommand = options.runCommand ?? runProcessCommand;
  const killProcess = options.killProcess ?? process.kill;
  const startTime = Date.now();

  try {
    if (!capability.supported) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: capability.reason ?? "Native process backend is not supported",
        durationMs: duration(startTime),
        timedOut: false,
      };
    }

    const processes = await listNativePharoProcesses(
      capability,
      timeoutMs,
      runCommand,
    );

    if (args[0] === "process" && args[1] === "list") {
      return {
        exitCode: 0,
        stdout: processes.map(processLine).join("\n"),
        stderr: "",
        durationMs: duration(startTime),
        timedOut: false,
      };
    }

    if (args[0] === "process" && args[1] === "kill") {
      const target = args[2];
      if (!target) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "process kill requires a PID or image name",
          durationMs: duration(startTime),
          timedOut: false,
        };
      }

      const targets = processes.filter((process) => matchesTarget(process, target));
      if (targets.length === 0) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `No matching Pharo process found for ${target}`,
          durationMs: duration(startTime),
          timedOut: false,
        };
      }

      for (const targetProcess of targets) {
        killProcess(targetProcess.pid);
      }

      return {
        exitCode: 0,
        stdout: targets.map((targetProcess) => `Killed ${targetProcess.pid}`).join("\n"),
        stderr: "",
        durationMs: duration(startTime),
        timedOut: false,
      };
    }

    return {
      exitCode: 1,
      stdout: "",
      stderr: `Unsupported native process tool args: ${args.join(" ")}`,
      durationMs: duration(startTime),
      timedOut: false,
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      durationMs: duration(startTime),
      timedOut: false,
    };
  }
}
