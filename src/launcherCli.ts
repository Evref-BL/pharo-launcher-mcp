import { spawn } from "node:child_process";
import {
  loadPharoLauncherConfig,
  type PharoLauncherConfig,
} from "./config.js";
import { resolveLauncherScript } from "./launcherScript.js";
import {
  shouldRunScriptThroughBash,
  shouldRunScriptThroughCommandShell,
} from "./platform.js";

export interface LauncherCliInvocation {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  source: "script" | "direct";
}

export interface LauncherCliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  timeoutReason?: string;
}

export interface RunLauncherCliOptions {
  config?: PharoLauncherConfig;
  timeoutMs?: number;
}

export interface BuildLauncherCliInvocationOptions {
  resolveScript?: (config: PharoLauncherConfig) => string | undefined;
  platform?: NodeJS.Platform;
  bashPath?: string;
  comspec?: string;
}

function scriptCommandAndArgs(
  scriptPath: string,
  args: readonly string[],
  platform: NodeJS.Platform,
  bashPath: string | undefined,
  comspec: string | undefined,
): Pick<LauncherCliInvocation, "command" | "args"> {
  if (shouldRunScriptThroughCommandShell(scriptPath, platform)) {
    return {
      command: comspec ?? "cmd.exe",
      args: ["/d", "/c", scriptPath, ...args],
    };
  }

  if (shouldRunScriptThroughBash(scriptPath, platform)) {
    return {
      command: bashPath ?? "bash",
      args: [scriptPath, ...args],
    };
  }

  return {
    command: scriptPath,
    args: [...args],
  };
}

export function isDetachedImageLaunch(args: readonly string[]): boolean {
  return (
    args[0] === "image" &&
    args[1] === "launch" &&
    args.includes("--detached")
  );
}

export function launcherArgsForDetachedImageLaunch(
  args: readonly string[],
): string[] {
  return args.filter((arg) => arg !== "--detached");
}

export function buildLauncherCliInvocation(
  args: readonly string[],
  config: PharoLauncherConfig = loadPharoLauncherConfig(),
  options: BuildLauncherCliInvocationOptions = {},
): LauncherCliInvocation {
  const platform = options.platform ?? process.platform;
  const launcherArgs = config.launcherConfiguration
    ? ["--configuration", config.launcherConfiguration, ...args]
    : [...args];
  const env = {
    ...process.env,
    PHARO_LAUNCHER_IMAGE: config.launcherImage,
    PHARO_LAUNCHER_VM: config.launcherVm,
    ...(config.profile
      ? {
          PHARO_LAUNCHER_MCP_PROFILE: config.profile.name,
          PHARO_LAUNCHER_MCP_STATE_ROOT: config.profile.stateRoot,
          PHARO_LAUNCHER_MCP_IMAGES_DIR: config.profile.imagesDir,
          PHARO_LAUNCHER_MCP_VMS_DIR: config.profile.vmsDir,
          PHARO_LAUNCHER_MCP_TEMPLATE_SOURCES_DIR: config.profile.templateSourcesDir,
          PHARO_LAUNCHER_MCP_INIT_SCRIPTS_DIR: config.profile.initScriptsDir,
          PHARO_LAUNCHER_MCP_LOGS_DIR: config.profile.logsDir,
        }
      : {}),
  };
  const launcherScript =
    config.launcherScript ??
    (options.resolveScript ?? ((value: PharoLauncherConfig) =>
      resolveLauncherScript({
        launcherDir: value.launcherDir,
      })))(config);

  if (launcherScript) {
    const commandAndArgs = scriptCommandAndArgs(
      launcherScript,
      launcherArgs,
      platform,
      options.bashPath,
      options.comspec ?? process.env.ComSpec,
    );

    return {
      ...commandAndArgs,
      cwd: config.launcherDir,
      env,
      source: "script",
    };
  }

  return {
    command: config.launcherVm,
    args: [
      "--headless",
      config.launcherImage,
      "--no-default-preferences",
      "clap",
      "launcher",
      ...launcherArgs,
    ],
    cwd: config.launcherDir,
    env,
    source: "direct",
  };
}

export function runLauncherCli(
  args: readonly string[],
  options: RunLauncherCliOptions = {},
): Promise<LauncherCliResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const startTime = Date.now();
  const detachedImageLaunch = isDetachedImageLaunch(args);
  const invocationArgs = detachedImageLaunch
    ? launcherArgsForDetachedImageLaunch(args)
    : args;
  const invocation = buildLauncherCliInvocation(
    invocationArgs,
    options.config ?? loadPharoLauncherConfig(),
  );

  if (detachedImageLaunch) {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();

    return Promise.resolve({
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: Date.now() - startTime,
      timedOut: false,
    });
  }

  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timeoutReason: string | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      timeoutReason = `PharoLauncher CLI timed out after ${timeoutMs}ms`;
      child.kill();
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
      resolve({
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startTime,
        timedOut,
        ...(timeoutReason ? { timeoutReason } : {}),
      });
    });
  });
}
