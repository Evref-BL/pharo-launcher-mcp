import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  loadPharoLauncherConfig,
  type PharoLauncherProfileConfig,
  type PharoLauncherConfig,
} from "./config.js";
import { resolveLauncherScript } from "./launcherScript.js";
import type { LauncherImage } from "./models.js";
import { parseLauncherOutput } from "./parser.js";
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
  bashPath?: string;
}

export interface BuildLauncherCliInvocationOptions {
  resolveScript?: (config: PharoLauncherConfig) => string | undefined;
  platform?: NodeJS.Platform;
  bashPath?: string;
  comspec?: string;
}

interface ProfileImageLaunchPlan {
  imageName: string;
  imagePath: string;
  scriptPath?: string;
  vmId: string;
  vmPath: string;
  invocation: LauncherCliInvocation;
  vmUpdated: boolean;
}

const POSIX_BASH_PATH_CANDIDATES = ["/bin/bash", "/usr/bin/bash"] as const;

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

function launcherEnvironment(config: PharoLauncherConfig): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PHARO_LAUNCHER_IMAGE: config.launcherImage,
    PHARO_LAUNCHER_VM: config.launcherVm,
    ...(config.profile
      ? {
          PHARO_LAUNCHER_MCP_PROFILE: config.profile.name,
          PHARO_LAUNCHER_MCP_STATE_ROOT: config.profile.stateRoot,
          PHARO_LAUNCHER_MCP_IMAGES_DIR: config.profile.imagesDir,
          PHARO_LAUNCHER_MCP_VMS_DIR: config.profile.vmsDir,
          PHARO_LAUNCHER_MCP_TEMPLATE_SOURCES_DIR:
            config.profile.templateSourcesDir,
          PHARO_LAUNCHER_MCP_INIT_SCRIPTS_DIR:
            config.profile.initScriptsDir,
          PHARO_LAUNCHER_MCP_LOGS_DIR: config.profile.logsDir,
        }
      : {}),
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

function resolveBashPath(platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return "bash";
  }

  return (
    POSIX_BASH_PATH_CANDIDATES.find((candidate) => fs.existsSync(candidate)) ??
    "bash"
  );
}

function diagnosticProfileLines(env: NodeJS.ProcessEnv): string[] {
  return [
    "PHARO_LAUNCHER_MCP_PROFILE",
    "PHARO_LAUNCHER_MCP_STATE_ROOT",
    "PHARO_LAUNCHER_MCP_IMAGES_DIR",
    "PHARO_LAUNCHER_MCP_VMS_DIR",
    "PHARO_LAUNCHER_MCP_TEMPLATE_SOURCES_DIR",
    "PHARO_LAUNCHER_MCP_INIT_SCRIPTS_DIR",
    "PHARO_LAUNCHER_MCP_LOGS_DIR",
  ].flatMap((key) => {
    const value = env[key];
    return value ? [`${key}: ${value}`] : [];
  });
}

export function launcherInvocationFailureDiagnostic(
  invocation: LauncherCliInvocation,
  error: Error | NodeJS.ErrnoException,
): string {
  const pathValue = invocation.env.PATH ?? process.env.PATH ?? "";

  return [
    `Failed to start PharoLauncher CLI command: ${error.message}`,
    `source: ${invocation.source}`,
    `command: ${invocation.command}`,
    `args: ${invocation.args.join(" ")}`,
    `cwd: ${invocation.cwd}`,
    `PATH: ${pathValue}`,
    ...diagnosticProfileLines(invocation.env),
  ].join("\n");
}

export function isDetachedImageLaunch(args: readonly string[]): boolean {
  return (
    args[0] === "image" &&
    args[1] === "launch" &&
    args.includes("--detached")
  );
}

function isImageLaunch(args: readonly string[]): boolean {
  return args[0] === "image" && args[1] === "launch";
}

export function launcherArgsForDetachedImageLaunch(
  args: readonly string[],
): string[] {
  return args.filter((arg) => arg !== "--detached");
}

function isImageCreateFromBuild(args: readonly string[]): boolean {
  return args[0] === "image" && args[1] === "create" && args[2] === "fromBuild";
}

function profileScopedFromBuildDiagnostic(
  args: readonly string[],
  config: PharoLauncherConfig,
): string | undefined {
  if (!config.profile || !isImageCreateFromBuild(args)) {
    return undefined;
  }

  return [
    "Refusing profile-scoped image create fromBuild before invoking Pharo Launcher.",
    "Pharo Launcher currently applies the CLI profile imagesDirectory during creation, but fromBuild automatically launches the image without initializing PhLVirtualMachineManager from the CLI configuration.",
    `That launch can download or run VMs outside PHARO_LAUNCHER_MCP_VMS_DIR (${config.profile.vmsDir}).`,
    "Use a non-fromBuild creation path with explicit launch control, or fix Pharo Launcher to initialize the VM manager from the CLI configuration before fromBuild launch.",
  ].join("\n");
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
  const env = launcherEnvironment(config);
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
      options.bashPath ?? resolveBashPath(platform),
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

function failedResult(
  stderr: string,
  startTime: number,
  extra: Partial<LauncherCliResult> = {},
): LauncherCliResult {
  return {
    exitCode: 1,
    stdout: "",
    stderr,
    durationMs: Date.now() - startTime,
    timedOut: false,
    ...extra,
  };
}

function validateInvocationSetup(
  invocation: LauncherCliInvocation,
  startTime: number,
): LauncherCliResult | undefined {
  if (invocation.source !== "script" || !path.isAbsolute(invocation.command)) {
    return undefined;
  }

  try {
    fs.accessSync(invocation.command, fs.constants.X_OK);
    return undefined;
  } catch (error) {
    const message =
      error instanceof Error
        ? `Selected launcher shell path is missing or inaccessible before spawn: ${error.message}`
        : "Selected launcher shell path is missing or inaccessible before spawn";
    return failedResult(
      launcherInvocationFailureDiagnostic(invocation, new Error(message)),
      startTime,
    );
  }
}

function trimForDiagnostic(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function commandFailureDiagnostic(
  label: string,
  result: LauncherCliResult,
): string {
  return [
    `${label} failed.`,
    `exitCode: ${result.exitCode ?? "unknown"}`,
    `timedOut: ${result.timedOut}`,
    ...(result.timeoutReason ? [`timeoutReason: ${result.timeoutReason}`] : []),
    ...(trimForDiagnostic(result.stdout)
      ? [`stdout:\n${trimForDiagnostic(result.stdout)}`]
      : []),
    ...(trimForDiagnostic(result.stderr)
      ? [`stderr:\n${trimForDiagnostic(result.stderr)}`]
      : []),
  ].join("\n");
}

function runInvocation(
  invocation: LauncherCliInvocation,
  timeoutMs: number,
  startTime: number,
): Promise<LauncherCliResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: invocation.env,
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        exitCode: null,
        stdout: "",
        stderr: launcherInvocationFailureDiagnostic(
          invocation,
          error instanceof Error ? error : new Error(String(error)),
        ),
        durationMs: Date.now() - startTime,
        timedOut: false,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timeoutReason: string | undefined;
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    if (!stdoutStream || !stderrStream) {
      child.kill();
      resolve({
        exitCode: null,
        stdout,
        stderr: launcherInvocationFailureDiagnostic(
          invocation,
          new Error("PharoLauncher CLI spawn did not provide stdout/stderr streams"),
        ),
        durationMs: Date.now() - startTime,
        timedOut,
      });
      return;
    }
    const timeout = setTimeout(() => {
      timedOut = true;
      timeoutReason = `PharoLauncher CLI timed out after ${timeoutMs}ms`;
      child.kill();
    }, timeoutMs);

    stdoutStream.setEncoding("utf8");
    stderrStream.setEncoding("utf8");
    stdoutStream.on("data", (chunk: string) => {
      stdout += chunk;
    });
    stderrStream.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      const errnoError = error as NodeJS.ErrnoException;
      resolve({
        exitCode: null,
        stdout,
        stderr: launcherInvocationFailureDiagnostic(invocation, errnoError),
        durationMs: Date.now() - startTime,
        timedOut,
        ...(timeoutReason ? { timeoutReason } : {}),
      });
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

function parsedImagesFromInfo(stdout: string): LauncherImage[] | undefined {
  const parsed = parseLauncherOutput(
    "pharo_launcher_image_info",
    "ston",
    stdout,
  );
  if (parsed.status !== "parsed") {
    return undefined;
  }

  if (Array.isArray(parsed.data)) {
    return parsed.data.filter(
      (item): item is LauncherImage =>
        typeof item === "object" && item !== null,
    );
  }

  if (typeof parsed.data === "object" && parsed.data !== null) {
    return [parsed.data as LauncherImage];
  }

  return undefined;
}

function imageNameFromLaunchArgs(args: readonly string[]): string | undefined {
  const candidate = args.at(-1);
  return candidate && !candidate.startsWith("--") ? candidate : undefined;
}

function scriptPathFromLaunchArgs(args: readonly string[]): string | undefined {
  const scriptIndex = args.indexOf("--script");
  return scriptIndex >= 0 ? args[scriptIndex + 1] : undefined;
}

function normalizePharoVersion(value: string): string {
  const trimmed = value.trim();
  const numeric = trimmed.match(/^(\d{2,3})(?:\.(\d+))?$/);
  if (!numeric) {
    return trimmed;
  }

  const major = numeric[1];
  const minor = numeric[2] ?? (major.length === 2 ? "0" : "");
  return `${major}${minor}`;
}

function pharoVersionFromTemplate(image: LauncherImage): string | undefined {
  const template = image.originTemplate;
  const urlVersion = template?.url?.match(
    /(?:^|[/-])(\d{2,3})(?:[./-]|$)/,
  )?.[1];
  if (urlVersion) {
    return normalizePharoVersion(urlVersion);
  }

  const nameVersion = template?.name?.match(
    /\b(?:Pharo|Moose)\D*(\d{2,3}(?:\.\d+)?)/i,
  )?.[1];
  return nameVersion ? normalizePharoVersion(nameVersion) : undefined;
}

function vmArchitectureSegment(image: LauncherImage): string {
  const source = `${image.architecture ?? ""} ${image.originTemplate?.name ?? ""} ${image.originTemplate?.url ?? ""}`;
  if (/\b(?:aarch64|arm64)\b/i.test(source)) {
    return "aarch64";
  }
  if (/\b(?:x86|32\s*[- ]?\s*bit|32bit)\b/i.test(source)) {
    return "x86";
  }

  return "x64";
}

function imageVmId(image: LauncherImage | undefined): string | undefined {
  if (image?.vmId) {
    return image.vmId;
  }

  if (!image) {
    return undefined;
  }

  const pharoVersion = image.pharoVersion ?? pharoVersionFromTemplate(image);
  return pharoVersion
    ? `${pharoVersion}-${vmArchitectureSegment(image)}`
    : undefined;
}

function profileImagePath(
  profile: PharoLauncherProfileConfig,
  imageName: string,
  image: LauncherImage | undefined,
): string {
  const imagePath =
    image?.imagePath ?? path.join(imageName, `${imageName}.image`);
  return path.isAbsolute(imagePath)
    ? path.resolve(imagePath)
    : path.resolve(profile.imagesDir, imagePath);
}

function profileVmDirectory(
  profile: PharoLauncherProfileConfig,
  vmId: string,
): string | undefined {
  const vmDirectory = path.resolve(profile.vmsDir, vmId);
  return isPathInside(profile.vmsDir, vmDirectory) ? vmDirectory : undefined;
}

function profileVmExecutableCandidates(vmDirectory: string): string[] {
  return [
    path.join(vmDirectory, "Pharo.app", "Contents", "MacOS", "Pharo"),
    path.join(vmDirectory, "Pharo.exe"),
    path.join(vmDirectory, "PharoConsole.exe"),
    path.join(vmDirectory, "pharo"),
    path.join(vmDirectory, "pharo-vm", "pharo"),
  ];
}

function looksLikeVmExecutable(filePath: string): boolean {
  return /^(?:Pharo|PharoConsole|pharo)(?:\.exe)?$/i.test(
    path.basename(filePath),
  );
}

function scanForVmExecutable(vmDirectory: string): string | undefined {
  const stack = [vmDirectory];
  let visited = 0;

  while (stack.length > 0 && visited < 5_000) {
    const current = stack.pop()!;
    visited += 1;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile() && looksLikeVmExecutable(entryPath)) {
        return entryPath;
      }
    }
  }

  return undefined;
}

function resolveProfileVmExecutable(
  profile: PharoLauncherProfileConfig,
  vmId: string,
): string | undefined {
  const vmDirectory = profileVmDirectory(profile, vmId);
  if (!vmDirectory) {
    return undefined;
  }

  const knownCandidate = profileVmExecutableCandidates(vmDirectory).find(
    (candidate) =>
      isPathInside(profile.vmsDir, candidate) && fs.existsSync(candidate),
  );
  if (knownCandidate) {
    return knownCandidate;
  }

  const scanned = scanForVmExecutable(vmDirectory);
  return scanned && isPathInside(profile.vmsDir, scanned) ? scanned : undefined;
}

async function launcherCliSubcommand(
  args: readonly string[],
  config: PharoLauncherConfig,
  timeoutMs: number,
): Promise<LauncherCliResult> {
  const invocation = buildLauncherCliInvocation(args, config);
  return runInvocation(invocation, timeoutMs, Date.now());
}

async function profileScopedImageLaunchPlan(
  args: readonly string[],
  config: PharoLauncherConfig,
  timeoutMs: number,
  startTime: number,
): Promise<ProfileImageLaunchPlan | LauncherCliResult> {
  const profile = config.profile;
  const imageName = imageNameFromLaunchArgs(args);
  if (!profile || !imageName) {
    return failedResult(
      "Profile-scoped image launch could not determine the requested image name.",
      startTime,
    );
  }

  const infoArgs = ["image", "info", "--ston", imageName];
  const infoResult = await launcherCliSubcommand(infoArgs, config, timeoutMs);
  if (infoResult.exitCode !== 0 || infoResult.timedOut) {
    return failedResult(
      [
        `Profile-scoped image launch could not inspect image ${imageName}.`,
        commandFailureDiagnostic("pharo_launcher_image_info", infoResult),
      ].join("\n"),
      startTime,
      {
        timedOut: infoResult.timedOut,
        ...(infoResult.timeoutReason
          ? { timeoutReason: infoResult.timeoutReason }
          : {}),
      },
    );
  }

  const images = parsedImagesFromInfo(infoResult.stdout);
  const image =
    images?.find((candidate) => candidate.name === imageName) ?? images?.[0];
  const imagePath = profileImagePath(profile, imageName, image);
  if (!isPathInside(profile.imagesDir, imagePath)) {
    return failedResult(
      [
        `Profile-scoped image launch refused image path outside PHARO_LAUNCHER_MCP_IMAGES_DIR (${profile.imagesDir}).`,
        `image: ${imagePath}`,
      ].join("\n"),
      startTime,
    );
  }
  if (!fs.existsSync(imagePath)) {
    return failedResult(
      [
        `Profile-scoped image launch could not find image file for ${imageName}.`,
        `expected: ${imagePath}`,
      ].join("\n"),
      startTime,
    );
  }

  const vmId = imageVmId(image);
  if (!vmId) {
    return failedResult(
      `Profile-scoped image launch could not determine a VM id for image ${imageName}.`,
      startTime,
    );
  }

  let vmPath = resolveProfileVmExecutable(profile, vmId);
  let vmUpdated = false;
  if (!vmPath) {
    const updateResult = await launcherCliSubcommand(
      ["vm", "update", vmId],
      config,
      Math.max(timeoutMs, 120_000),
    );
    vmUpdated = updateResult.exitCode === 0 && !updateResult.timedOut;
    if (!vmUpdated) {
      return failedResult(
        [
          `Profile-scoped image launch could not install VM ${vmId} inside PHARO_LAUNCHER_MCP_VMS_DIR (${profile.vmsDir}).`,
          commandFailureDiagnostic("pharo_launcher_vm_update", updateResult),
        ].join("\n"),
        startTime,
        {
          timedOut: updateResult.timedOut,
          ...(updateResult.timeoutReason
            ? { timeoutReason: updateResult.timeoutReason }
            : {}),
        },
      );
    }
    vmPath = resolveProfileVmExecutable(profile, vmId);
  }

  if (!vmPath) {
    return failedResult(
      [
        `Profile-scoped image launch could not resolve a profile-local VM executable for ${vmId} after VM update.`,
        `PHARO_LAUNCHER_MCP_VMS_DIR: ${profile.vmsDir}`,
      ].join("\n"),
      startTime,
    );
  }

  const scriptPath = scriptPathFromLaunchArgs(args);
  const invocationArgs = [
    "--headless",
    imagePath,
    ...(scriptPath ? ["eval", scriptPath] : []),
  ];
  return {
    imageName,
    imagePath,
    ...(scriptPath ? { scriptPath } : {}),
    vmId,
    vmPath,
    invocation: {
      command: vmPath,
      args: invocationArgs,
      cwd: path.dirname(imagePath),
      env: launcherEnvironment(config),
      source: "direct",
    },
    vmUpdated,
  };
}

async function runDetachedProfileImageLaunch(
  plan: ProfileImageLaunchPlan,
  config: PharoLauncherConfig,
  args: readonly string[],
  startTime: number,
): Promise<LauncherCliResult> {
  const logPaths = detachedLaunchLogPaths(config, args, startTime);
  fs.mkdirSync(path.dirname(logPaths.stdoutPath), { recursive: true });
  const stdoutFd = fs.openSync(logPaths.stdoutPath, "a");
  let stderrFd: number | undefined;

  try {
    stderrFd = fs.openSync(logPaths.stderrPath, "a");
    const child = spawn(plan.invocation.command, plan.invocation.args, {
      cwd: plan.invocation.cwd,
      env: plan.invocation.env,
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
      windowsHide: true,
    });
    child.on("error", () => {
      // Detached launches cannot report async spawn failures to the already
      // returned result, but the listener prevents an unhandled error event.
    });
    child.unref();

    return {
      exitCode: 0,
      stdout: [
        `Detached profile-scoped Pharo image pid ${child.pid ?? "unknown"}.`,
        `image: ${plan.imagePath}`,
        `vm: ${plan.vmPath}`,
        `vmId: ${plan.vmId}`,
        `vmUpdated: ${plan.vmUpdated}`,
        `stdout: ${logPaths.stdoutPath}`,
        `stderr: ${logPaths.stderrPath}`,
      ].join("\n"),
      stderr: "",
      durationMs: Date.now() - startTime,
      timedOut: false,
    };
  } finally {
    fs.closeSync(stdoutFd);
    if (stderrFd !== undefined) {
      fs.closeSync(stderrFd);
    }
  }
}

async function runProfileScopedImageLaunch(
  args: readonly string[],
  config: PharoLauncherConfig,
  timeoutMs: number,
  startTime: number,
  detached: boolean,
): Promise<LauncherCliResult> {
  ensureProfileLauncherConfiguration(config);
  const plan = await profileScopedImageLaunchPlan(
    args,
    config,
    timeoutMs,
    startTime,
  );

  if ("exitCode" in plan) {
    return plan;
  }

  if (detached) {
    const setupFailure = validateInvocationSetup(
      plan.invocation,
      startTime,
    );
    if (setupFailure) {
      return setupFailure;
    }
    return runDetachedProfileImageLaunch(plan, config, args, startTime);
  }

  const setupFailure = validateInvocationSetup(plan.invocation, startTime);
  if (setupFailure) {
    return setupFailure;
  }
  return runInvocation(plan.invocation, timeoutMs, startTime);
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
  const scopedFromBuildDiagnostic = profileScopedFromBuildDiagnostic(
    invocationArgs,
    config,
  );
  if (scopedFromBuildDiagnostic) {
    return Promise.resolve({
      exitCode: 1,
      stdout: "",
      stderr: scopedFromBuildDiagnostic,
      durationMs: Date.now() - startTime,
      timedOut: false,
    });
  }
  if (config.profile && isImageLaunch(invocationArgs)) {
    return runProfileScopedImageLaunch(
      invocationArgs,
      config,
      timeoutMs,
      startTime,
      detachedImageLaunch,
    );
  }

  ensureProfileLauncherConfiguration(config);
  const invocation = buildLauncherCliInvocation(invocationArgs, config, {
    bashPath: options.bashPath,
  });
  const setupFailure = validateInvocationSetup(invocation, startTime);
  if (setupFailure) {
    return Promise.resolve(setupFailure);
  }

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
      child.on("error", () => {
        // Detached launches cannot report async spawn failures to the already
        // returned result, but the listener prevents an unhandled error event.
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

  return runInvocation(invocation, timeoutMs, startTime);
}
