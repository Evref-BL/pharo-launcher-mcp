import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  loadPharoLauncherConfig,
  type PharoLauncherProfileConfig,
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

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathInside(parent: string, candidate: string): boolean {
  const normalizedParent = comparablePath(parent);
  const normalizedCandidate = comparablePath(candidate);
  const relative = path.relative(normalizedParent, normalizedCandidate);
  return (
    relative === "" ||
    (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function stonFilePath(filePath: string): string {
  const normalized = path.resolve(filePath).replaceAll("\\", "/");
  const stonPath = /^[A-Za-z]:\//.test(normalized)
    ? `/${normalized}`
    : normalized;
  return stonPath.replaceAll("'", "''");
}

function safeFileSegment(value: string): string {
  const cleaned = value.replaceAll(/[^A-Za-z0-9._-]+/g, "-");
  return cleaned.length > 0 ? cleaned : "image";
}

function detachedLaunchLogPaths(
  config: PharoLauncherConfig,
  args: readonly string[],
  startTime: number,
): { stdoutPath: string; stderrPath: string } {
  const logsDir =
    config.profile?.logsDir ?? path.join(process.cwd(), ".pharo-launcher-mcp", "logs");
  const imageName = safeFileSegment(args.at(-1) ?? "image");
  const stamp = new Date(startTime).toISOString().replaceAll(/[:.]/g, "-");
  const baseName = `${stamp}-${imageName}-launch`;

  return {
    stdoutPath: path.join(logsDir, `${baseName}.out.log`),
    stderrPath: path.join(logsDir, `${baseName}.err.log`),
  };
}

export function profileLauncherConfigurationContent(
  profile: PharoLauncherProfileConfig,
): string {
  return [
    "PharoLauncherCLIConfiguration {",
    `\t#imagesDirectory : FILE [ '${stonFilePath(profile.imagesDir)}' ],`,
    `\t#vmsDirectory : FILE [ '${stonFilePath(profile.vmsDir)}' ],`,
    "\t#launchImageFromALoginShell : true,",
    `\t#initScriptsDirectory : FILE [ '${stonFilePath(profile.initScriptsDir)}' ],`,
    `\t#templateSourcesFileLocation : FILE [ '${stonFilePath(profile.templateSourcesDir)}' ]`,
    "}",
    "",
  ].join("\n");
}

export function ensureProfileLauncherConfiguration(
  config: PharoLauncherConfig,
): void {
  if (!config.profile || !config.launcherConfiguration) {
    return;
  }

  const configurationPath = path.resolve(config.launcherConfiguration);
  const stateRoot = path.resolve(config.profile.stateRoot);
  if (!isPathInside(stateRoot, configurationPath)) {
    throw new Error(
      `Refusing launcher profile configuration outside PHARO_LAUNCHER_MCP_STATE_ROOT: ${configurationPath}`,
    );
  }

  for (const directory of [
    path.dirname(config.profile.launcherImage),
    config.profile.imagesDir,
    config.profile.vmsDir,
    config.profile.templateSourcesDir,
    config.profile.initScriptsDir,
    config.profile.logsDir,
    path.dirname(configurationPath),
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const content = profileLauncherConfigurationContent(config.profile);
  if (
    !fs.existsSync(configurationPath) ||
    fs.readFileSync(configurationPath, "utf8") !== content
  ) {
    fs.writeFileSync(configurationPath, content, "utf8");
  }
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
  const config = options.config ?? loadPharoLauncherConfig();
  ensureProfileLauncherConfiguration(config);
  const invocation = buildLauncherCliInvocation(invocationArgs, config);

  if (detachedImageLaunch) {
    const logPaths = detachedLaunchLogPaths(config, args, startTime);
    fs.mkdirSync(path.dirname(logPaths.stdoutPath), { recursive: true });
    const stdoutFd = fs.openSync(logPaths.stdoutPath, "a");
    let stderrFd: number | undefined;

    try {
      stderrFd = fs.openSync(logPaths.stderrPath, "a");
      const child = spawn(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: invocation.env,
        detached: true,
        stdio: ["ignore", stdoutFd, stderrFd],
        windowsHide: true,
      });
      child.unref();

      return Promise.resolve({
        exitCode: 0,
        stdout: [
          `Detached PharoLauncher CLI pid ${child.pid ?? "unknown"}.`,
          `stdout: ${logPaths.stdoutPath}`,
          `stderr: ${logPaths.stderrPath}`,
        ].join("\n"),
        stderr: "",
        durationMs: Date.now() - startTime,
        timedOut: false,
      });
    } finally {
      fs.closeSync(stdoutFd);
      if (stderrFd !== undefined) {
        fs.closeSync(stderrFd);
      }
    }
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
