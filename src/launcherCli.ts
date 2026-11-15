import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  loadPharoLauncherConfig,
  type PharoLauncherProfileConfig,
  type PharoLauncherConfig,
} from "./config.js";
import {
  findByName,
  readLauncherImage,
  scanImages,
} from "./imageStore.js";
import { resolveLauncherScript } from "./launcherScript.js";
import type {
  LauncherImage,
  LauncherLaunchReport,
  LauncherProcess,
} from "./models.js";
import { launcherMessage, sentenceWithMessage } from "./resultNormalizer.js";
import { compactTokenText } from "./textTokens.js";
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
  /** The processes a native process list saw, or a kill aimed at. */
  processes?: LauncherProcess[];
  /** What an image start ran, once it ran something. */
  launch?: LauncherLaunchReport;
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
  displayMode: ImageLaunchDisplayMode;
  vmId: string;
  vmPath: string;
  invocation: LauncherCliInvocation;
  vmUpdated: boolean;
}

interface ProfileImageLaunchTarget {
  profile: PharoLauncherProfileConfig;
  imageName: string;
}

interface ProfileImageInspection {
  image: LauncherImage;
  imagePath: string;
}

interface ProfileVmResolution {
  vmId: string;
  vmPath: string;
  vmUpdated: boolean;
}

type ImageLaunchDisplayMode = "headless" | "interactive";

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

function changesPathForImage(imagePath: string): string {
  return /\.image$/i.test(imagePath)
    ? imagePath.replace(/\.image$/i, ".changes")
    : `${imagePath}.changes`;
}

function copyIfExists(source: string, destination: string): void {
  if (fs.existsSync(source) && !fs.existsSync(destination)) {
    fs.copyFileSync(source, destination);
  }
}

function ensureProfileLauncherImage(
  config: PharoLauncherConfig,
  profileLauncherImage: string,
): void {
  const installationLauncherImage = path.resolve(config.installationLauncherImage);
  if (!fs.existsSync(profileLauncherImage)) {
    if (!fs.existsSync(installationLauncherImage)) {
      throw new Error(
        [
          "Cannot bootstrap profile launcher image because the installation PharoLauncher image is missing.",
          `source: ${installationLauncherImage}`,
          `destination: ${profileLauncherImage}`,
        ].join("\n"),
      );
    }

    fs.copyFileSync(installationLauncherImage, profileLauncherImage);
  }

  copyIfExists(
    changesPathForImage(installationLauncherImage),
    changesPathForImage(profileLauncherImage),
  );
}

export function ensureProfileLauncherConfiguration(
  config: PharoLauncherConfig,
): void {
  if (!config.profile) {
    return;
  }

  const stateRoot = path.resolve(config.profile.stateRoot);
  const profileLauncherImage = path.resolve(config.profile.launcherImage);
  if (!isPathInside(stateRoot, profileLauncherImage)) {
    throw new Error(
      `Refusing launcher profile image outside PHARO_LAUNCHER_MCP_STATE_ROOT: ${profileLauncherImage}`,
    );
  }

  const configurationPath = config.launcherConfiguration
    ? path.resolve(config.launcherConfiguration)
    : undefined;
  if (configurationPath && !isPathInside(stateRoot, configurationPath)) {
    throw new Error(
      `Refusing launcher profile configuration outside PHARO_LAUNCHER_MCP_STATE_ROOT: ${configurationPath}`,
    );
  }

  for (const directory of [
    path.dirname(profileLauncherImage),
    config.profile.imagesDir,
    config.profile.vmsDir,
    config.profile.templateSourcesDir,
    config.profile.initScriptsDir,
    config.profile.logsDir,
    ...(configurationPath ? [path.dirname(configurationPath)] : []),
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  ensureProfileLauncherImage(config, profileLauncherImage);

  if (!configurationPath) {
    return;
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

const invocationFailurePrefix = "Failed to start PharoLauncher CLI command:";

/**
 * Whether a command's error output says it never started: the lines
 * `launcherInvocationFailureDiagnostic` writes, which help with a broken
 * installation as they are.
 */
export function isLauncherInvocationFailure(text: string | undefined): boolean {
  return text?.startsWith(invocationFailurePrefix) ?? false;
}

export function launcherInvocationFailureDiagnostic(
  invocation: LauncherCliInvocation,
  error: Error | NodeJS.ErrnoException,
): string {
  const pathValue = invocation.env.PATH ?? process.env.PATH ?? "";

  return [
    `${invocationFailurePrefix} ${error.message}`,
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

/**
 * Whether the caller said which display mode it wanted.
 *
 * `imageLaunchArgsAndDisplayMode` answers `headless` when nothing was asked
 * for, so the mode it returns cannot tell a default from a request. Off the
 * profile path the difference matters: the flag is stripped before the
 * command is built, so a request that is not refused is a request silently
 * dropped, and the image opens a window the caller asked it not to.
 */
function asksForDisplayMode(args: readonly string[]): boolean {
  return args.includes("--displayMode");
}

function imageLaunchArgsAndDisplayMode(
  args: readonly string[],
  startTime: number,
): { args: string[]; displayMode: ImageLaunchDisplayMode } | LauncherCliResult {
  const displayModeIndex = args.indexOf("--displayMode");
  if (displayModeIndex < 0) {
    return { args: [...args], displayMode: "headless" };
  }

  const displayMode = args[displayModeIndex + 1];
  if (displayMode !== "headless" && displayMode !== "interactive") {
    return failedResult(
      "Profile-scoped image launch displayMode must be headless or interactive.",
      startTime,
    );
  }

  return {
    args: args.filter(
      (_arg, index) =>
        index !== displayModeIndex && index !== displayModeIndex + 1,
    ),
    displayMode,
  };
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
    (options.resolveScript ?? (() => resolveLauncherScript({})))(config);

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
  const template = image.template;
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
  if (image.architecture === "64") {
    return "x64";
  }
  if (image.architecture === "32") {
    return "x86";
  }

  const source = `${image.template?.name ?? ""} ${image.template?.url ?? ""}`;
  const lower = source.toLowerCase();
  const compact = compactTokenText(source);
  if (lower.includes("aarch64") || lower.includes("arm64")) {
    return "aarch64";
  }
  if (lower.includes("x86") || compact.includes("32bit")) {
    return "x86";
  }

  return "x64";
}

/**
 * The VM an image needs: the one its last launch used, else its Pharo version
 * with the architecture its header says (`PhLVirtualMachineManager>>vmId`),
 * else what its template's URL or name says.
 */
function imageVmId(image: LauncherImage): string | undefined {
  if (image.vmId) {
    return image.vmId;
  }

  const pharoVersion = image.pharoVersion ?? pharoVersionFromTemplate(image);
  return pharoVersion
    ? `${pharoVersion}-${vmArchitectureSegment(image)}`
    : undefined;
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

function isLauncherCliResult(
  value:
    | LauncherCliResult
    | ProfileImageLaunchTarget
    | ProfileImageInspection
    | ProfileVmResolution,
): value is LauncherCliResult {
  return "exitCode" in value;
}

function profileImageLaunchTarget(
  args: readonly string[],
  config: PharoLauncherConfig,
  startTime: number,
): ProfileImageLaunchTarget | LauncherCliResult {
  const profile = config.profile;
  const imageName = imageNameFromLaunchArgs(args);
  if (!profile || !imageName) {
    return failedResult(
      "Profile-scoped image launch could not determine the requested image name.",
      startTime,
    );
  }

  return { profile, imageName };
}

/**
 * The image to launch, read through the images directory, as every other tool
 * reads it: no Launcher boot, and every path the reader builds is inside it.
 */
function inspectProfileImageForLaunch(
  target: ProfileImageLaunchTarget,
  startTime: number,
): ProfileImageInspection | LauncherCliResult {
  const imagesDir = path.resolve(target.profile.imagesDir);
  const entry = findByName(scanImages(imagesDir).images, target.imageName);
  if (!entry) {
    return failedResult(
      `There is no image ${target.imageName} in ${imagesDir}.`,
      startTime,
    );
  }

  return { image: readLauncherImage(entry), imagePath: entry.imagePath };
}

async function resolveProfileVmForLaunch(
  target: ProfileImageLaunchTarget,
  image: LauncherImage,
  config: PharoLauncherConfig,
  timeoutMs: number,
  startTime: number,
): Promise<ProfileVmResolution | LauncherCliResult> {
  const vmId = imageVmId(image);
  if (!vmId) {
    return failedResult(
      `Cannot tell which VM ${image.name} needs: neither its meta-inf.ston, ` +
        "its pharo.version nor its template gives a Pharo version.",
      startTime,
    );
  }
  const vmsDir = path.resolve(target.profile.vmsDir);

  let vmPath = resolveProfileVmExecutable(target.profile, vmId);
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
        sentenceWithMessage(
          `Could not download VM ${vmId} into ${vmsDir}`,
          launcherMessage(updateResult),
        ),
        startTime,
        {
          timedOut: updateResult.timedOut,
          ...(updateResult.timeoutReason
            ? { timeoutReason: updateResult.timeoutReason }
            : {}),
        },
      );
    }
    vmPath = resolveProfileVmExecutable(target.profile, vmId);
  }

  if (!vmPath) {
    return failedResult(
      `VM ${vmId} was downloaded into ${path.join(vmsDir, vmId)}, ` +
        "but no Pharo executable is in it.",
      startTime,
    );
  }

  return { vmId, vmPath, vmUpdated };
}

async function profileScopedImageLaunchPlan(
  args: readonly string[],
  config: PharoLauncherConfig,
  timeoutMs: number,
  startTime: number,
  displayMode: ImageLaunchDisplayMode,
): Promise<ProfileImageLaunchPlan | LauncherCliResult> {
  const target = profileImageLaunchTarget(args, config, startTime);
  if (isLauncherCliResult(target)) {
    return target;
  }

  const inspection = inspectProfileImageForLaunch(target, startTime);
  if (isLauncherCliResult(inspection)) {
    return inspection;
  }

  const vm = await resolveProfileVmForLaunch(
    target,
    inspection.image,
    config,
    timeoutMs,
    startTime,
  );
  if (isLauncherCliResult(vm)) {
    return vm;
  }

  const scriptPath = scriptPathFromLaunchArgs(args);
  const invocationArgs = [
    ...(displayMode === "headless" ? ["--headless"] : []),
    inspection.imagePath,
    ...(scriptPath ? ["eval", scriptPath] : []),
  ];
  return {
    imageName: target.imageName,
    imagePath: inspection.imagePath,
    ...(scriptPath ? { scriptPath } : {}),
    displayMode,
    vmId: vm.vmId,
    vmPath: vm.vmPath,
    invocation: {
      command: vm.vmPath,
      args: invocationArgs,
      cwd: path.dirname(inspection.imagePath),
      env: launcherEnvironment(config),
      source: "direct",
    },
    vmUpdated: vm.vmUpdated,
  };
}

// Both launch paths detach the same way, so they detach here. A detached
// child outlives this call and its error event arrives after the result has
// gone back, so the one moment this can tell a launch from a failure to
// launch is right after spawn: no pid means nothing is running.
function spawnDetached(
  invocation: LauncherCliInvocation,
  logPaths: { stdoutPath: string; stderrPath: string },
  startTime: number,
  describe: (pid: number) => string[],
  report: (
    pid: number,
    logs: { stdout: string; stderr: string },
  ) => LauncherLaunchReport,
): LauncherCliResult {
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

    if (child.pid === undefined) {
      return failedResult(
        launcherInvocationFailureDiagnostic(
          invocation,
          new Error("Detached launch did not start: the spawn returned no pid"),
        ),
        startTime,
      );
    }

    return {
      exitCode: 0,
      stdout: [
        ...describe(child.pid),
        `stdout: ${logPaths.stdoutPath}`,
        `stderr: ${logPaths.stderrPath}`,
      ].join("\n"),
      stderr: "",
      durationMs: Date.now() - startTime,
      timedOut: false,
      launch: report(child.pid, {
        stdout: logPaths.stdoutPath,
        stderr: logPaths.stderrPath,
      }),
    };
  } finally {
    fs.closeSync(stdoutFd);
    if (stderrFd !== undefined) {
      fs.closeSync(stderrFd);
    }
  }
}

function runDetachedProfileImageLaunch(
  plan: ProfileImageLaunchPlan,
  config: PharoLauncherConfig,
  args: readonly string[],
  startTime: number,
): LauncherCliResult {
  return spawnDetached(
    plan.invocation,
    detachedLaunchLogPaths(config, args, startTime),
    startTime,
    // PLexus reads these lines from raw.stdout, word for word.
    (pid) => [
      `Detached profile-scoped Pharo image pid ${pid}.`,
      `image: ${plan.imagePath}`,
      `displayMode: ${plan.displayMode}`,
      `vm: ${plan.vmPath}`,
      `vmId: ${plan.vmId}`,
      `vmUpdated: ${plan.vmUpdated}`,
    ],
    (pid, logs) => ({ ...vmLaunchReport(plan), pid, logs }),
  );
}

function vmLaunchReport(
  plan: ProfileImageLaunchPlan,
): Extract<LauncherLaunchReport, { by: "vm" }> {
  return {
    by: "vm",
    imagePath: plan.imagePath,
    displayMode: plan.displayMode,
    vmPath: plan.vmPath,
    vmId: plan.vmId,
    vmUpdated: plan.vmUpdated,
  };
}

/** Whether a command ran at all: one that never started has no exit code. */
function ran(result: LauncherCliResult): boolean {
  return result.exitCode !== null || result.timedOut;
}

async function runProfileScopedImageLaunch(
  args: readonly string[],
  config: PharoLauncherConfig,
  timeoutMs: number,
  startTime: number,
  detached: boolean,
  displayMode: ImageLaunchDisplayMode,
): Promise<LauncherCliResult> {
  ensureProfileLauncherConfiguration(config);
  const plan = await profileScopedImageLaunchPlan(
    args,
    config,
    timeoutMs,
    startTime,
    displayMode,
  );

  if ("exitCode" in plan) {
    return plan;
  }

  const setupFailure = validateInvocationSetup(plan.invocation, startTime);
  if (setupFailure) {
    return setupFailure;
  }

  if (detached) {
    return runDetachedProfileImageLaunch(plan, config, args, startTime);
  }

  const result = await runInvocation(plan.invocation, timeoutMs, startTime);
  return {
    ...result,
    ...(ran(result)
      ? {
          launch: {
            ...vmLaunchReport(plan),
            output: { stdout: result.stdout, stderr: result.stderr },
          },
        }
      : {}),
    // PLexus reads these lines from raw.stdout, word for word.
    stdout: [
      `Profile-scoped Pharo image launch.`,
      `image: ${plan.imagePath}`,
      `displayMode: ${plan.displayMode}`,
      `vm: ${plan.vmPath}`,
      `vmId: ${plan.vmId}`,
      `vmUpdated: ${plan.vmUpdated}`,
      result.stdout,
    ]
      .filter((line) => line.length > 0)
      .join("\n"),
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
  const imageLaunchOptions = isImageLaunch(invocationArgs)
    ? imageLaunchArgsAndDisplayMode(invocationArgs, startTime)
    : { args: [...invocationArgs], displayMode: "headless" as const };
  if ("exitCode" in imageLaunchOptions) {
    return Promise.resolve(imageLaunchOptions);
  }
  const launcherArgs = imageLaunchOptions.args;
  const config = options.config ?? loadPharoLauncherConfig();
  if (!config.profile && isImageLaunch(launcherArgs) && asksForDisplayMode(args)) {
    return Promise.resolve(
      failedResult(
        "displayMode needs a scoped launcher profile. PharoLauncher's own " +
          "image launch has no display mode, so the mode can only be applied " +
          "where this server launches the VM itself.",
        startTime,
      ),
    );
  }

  if (config.profile && isImageLaunch(launcherArgs)) {
    return runProfileScopedImageLaunch(
      launcherArgs,
      config,
      timeoutMs,
      startTime,
      detachedImageLaunch,
      imageLaunchOptions.displayMode,
    );
  }

  ensureProfileLauncherConfiguration(config);
  const invocation = buildLauncherCliInvocation(launcherArgs, config, {
    bashPath: options.bashPath,
  });
  const setupFailure = validateInvocationSetup(invocation, startTime);
  if (setupFailure) {
    return Promise.resolve(setupFailure);
  }

  if (detachedImageLaunch) {
    return Promise.resolve(
      spawnDetached(
        invocation,
        detachedLaunchLogPaths(config, args, startTime),
        startTime,
        (pid) => [`Detached PharoLauncher CLI pid ${pid}.`],
        (pid, logs) => ({ by: "launcher", pid, logs }),
      ),
    );
  }

  const result = runInvocation(invocation, timeoutMs, startTime);
  return isImageLaunch(launcherArgs)
    ? result.then((ended) =>
        ran(ended) ? { ...ended, launch: { by: "launcher" } } : ended,
      )
    : result;
}
