/**
 * What this package knows how to do, as functions.
 *
 * The functions are the surface: a Node program that depends on this package
 * calls them and gets typed results, and `server.ts` is an adapter that maps
 * the MCP tool names onto them.
 *
 * Scope is a config, not a process. `loadPharoLauncherConfig` takes an
 * environment object, so a caller that needs a profile passes one rather than
 * spawning a process to hold `PHARO_LAUNCHER_*` variables.
 */
import fs from "node:fs";
import path from "node:path";
import {
  launcherModulePathBudget,
  launcherModulePathBudgetMessage,
} from "./platform.js";
import {
  buildLauncherCommandArgs,
  inputObject as argumentsObject,
  optionalString,
  ProfileTooDeepError,
  requiredString,
  ToolInputError,
} from "./commandCatalog.js";
import {
  loadPharoLauncherConfig,
  type PharoLauncherConfig,
} from "./config.js";
import {
  getPharoLauncherConfigReport,
  type LauncherCliRunner,
  type PharoLauncherConfigReport,
} from "./discovery.js";
import {
  buildLauncherCliInvocation,
  launcherInvocationFailureDiagnostic,
  runLauncherCli,
} from "./launcherCli.js";
import {
  listNativeProcesses,
  runNativeProcessTool,
  type RunNativeProcessToolOptions,
} from "./processTools.js";
import { repairCopiedImageMetadata } from "./imageMetadata.js";
import { launchLogsDirectory, removeLaunchLogs } from "./launchLogs.js";
import {
  filterByName,
  findByName,
  imagesProcessScope,
  processesOfImages,
  readImageDirectory,
  readLauncherImage,
  resolveImagesDirectory,
  scanImages,
  whatItLacks,
  type ImageEntry,
} from "./imageStore.js";
import {
  launcherMessage,
  normalizeLauncherResult,
  sentenceWithMessage,
} from "./resultNormalizer.js";
import type { LauncherCliResult } from "./launcherCli.js";
import { copyImageBetweenProfiles } from "./crossProfileCopy.js";

/**
 * The shapes these functions answer with.
 *
 * They are defined in the modules that produce them, and those modules are not
 * subpaths, so without these a caller could invoke every function here and
 * name none of its results, and would have to restate their shape.
 *
 * `packageExports.test.ts` names them, so dropping one fails the typecheck.
 */
export type {
  LauncherCommandResult,
  LauncherImage,
  LauncherImageInfo,
  LauncherImageList,
  LauncherLaunchReport,
  LauncherOutputFormat,
  LauncherProcess,
  LauncherTemplate,
  MadeImageFailure,
  MadeImageResult,
  NotAnImage,
  TemplateCategoriesResult,
} from "./models.js";
export { ProfileTooDeepError, ToolInputError } from "./commandCatalog.js";
export {
  readImageDirectory,
  readLauncherImage,
  type ImageDirectory,
  type ImageEntry,
} from "./imageStore.js";
export {
  repairCopiedImageMetadataInDirectory,
  type ImageMetadataRepairResult,
} from "./imageMetadata.js";
export { sentenceWithMessage } from "./resultNormalizer.js";
export type { RunNativeProcessToolOptions } from "./processTools.js";
export type { PharoLauncherConfigReport } from "./discovery.js";
export type { CrossProfileImageCopyResult } from "./crossProfileCopy.js";
import type {
  LauncherCommandResult,
  LauncherImage,
  LauncherImageInfo,
  LauncherImageList,
  LauncherProcess,
  LauncherTemplate,
  MadeImageFailure,
  MadeImageResult,
  TemplateCategoriesResult,
} from "./models.js";

const defaultTemplateSourcesUrl =
  "https://files.pharo.org/pharo-launcher/sources.list";
const templateSourcesFileName = "sources.list";
const imageCopyVerificationTimeoutMs = 30_000;
const imageCopyVerificationPollMs = 1_000;

/** How a call reaches PharoLauncher, and what it is allowed to take. */
export interface PharoLauncherOptions {
  config?: PharoLauncherConfig;
  runner?: LauncherCliRunner;
  timeoutMs?: number;
  includeRaw?: boolean;
  imageCopyVerificationTimeoutMs?: number;
  imageCopyVerificationPollMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  templateSourcesUrl?: string;
  fetchTemplateSources?: (url: string) => Promise<string>;
  /** How processes are listed, killed and watched; tests give their own. */
  nativeProcess?: RunNativeProcessToolOptions;
}

/** The options of the MCP adapter: the library's, and how long a kill waits. */
export interface CallToolOptions extends PharoLauncherOptions {
  /** How long `process_kill` waits for a killed pid to exit; 10 s. */
  processExitTimeoutMs?: number;
  /** How often it looks; every 200 ms. */
  processExitPollMs?: number;
}

function runnerOptions(
  options: PharoLauncherOptions,
): { config?: PharoLauncherConfig; timeoutMs?: number } {
  return {
    ...(options.config ? { config: options.config } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  };
}

function inputObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  return input as Record<string, unknown>;
}

function optionalBoolean(
  input: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new ToolInputError(`${key} must be a boolean`);
  }

  return value;
}

export function commandResultOptions(
  argumentsValue: unknown,
  options: PharoLauncherOptions,
): PharoLauncherOptions {
  const includeRaw = optionalBoolean(inputObject(argumentsValue), "includeRaw");
  return includeRaw === undefined ? options : { ...options, includeRaw };
}

function normalizeToolResult(
  toolName: string,
  args: readonly string[],
  result: LauncherCliResult,
  options: PharoLauncherOptions,
): LauncherCommandResult {
  return normalizeLauncherResult(toolName, args, result, {
    includeRaw: options.includeRaw,
  });
}

async function runLauncherToolCommand(
  runner: LauncherCliRunner,
  args: readonly string[],
  options: PharoLauncherOptions,
): Promise<LauncherCliResult> {
  const startTime = Date.now();
  try {
    return await runner(args, runnerOptions(options));
  } catch (error) {
    return {
      exitCode: null,
      stdout: "",
      stderr: runnerExceptionDiagnostic(args, options, error),
      durationMs: Date.now() - startTime,
      timedOut: false,
    };
  }
}

function runnerExceptionDiagnostic(
  args: readonly string[],
  options: PharoLauncherOptions,
  error: unknown,
): string {
  const normalizedError = error instanceof Error ? error : new Error(String(error));

  try {
    const invocation = buildLauncherCliInvocation(
      args,
      options.config ?? loadPharoLauncherConfig(),
    );
    return launcherInvocationFailureDiagnostic(invocation, normalizedError);
  } catch (contextError) {
    const contextMessage =
      contextError instanceof Error ? contextError.message : String(contextError);
    return [
      `Failed to start PharoLauncher CLI command: ${normalizedError.message}`,
      `args: ${args.join(" ")}`,
      `diagnosticContextError: ${contextMessage}`,
    ].join("\n");
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type MadeImage =
  | { ok: true; image?: LauncherImage }
  | { ok: false; failure: MadeImageFailure };

/**
 * Why a create or copy made no image, in a sentence. `said` is what the
 * Launcher said it did (`created X`, `copied X to Y`), and `newImageName` the
 * image it made, each written as the caller writes names.
 */
export function madeImageFailureText(
  failure: MadeImageFailure,
  said: string,
  newImageName: string,
): string {
  if (failure.kind === "not-opened") {
    return sentenceWithMessage(
      `Pharo Launcher made ${newImageName} but cannot open it`,
      failure.message,
    );
  }

  const lacks = failure.notAnImage
    ? `${failure.notAnImage.directory} ${whatItLacks(failure.notAnImage)}`
    : `${failure.directory} does not exist`;
  return `Pharo Launcher said it ${said}, but ${lacks} after ${failure.seconds} s.`;
}

/**
 * Whether the Launcher can list the image a create or copy made, and open it,
 * polled until it can or the time is up.
 *
 * In profile mode, where the server wrote the images directory itself, listed
 * is the directory holding the image under the exact new name (the Launcher
 * makes `baseDirectory / targetName`). Outside a profile the directory read
 * from the settings can be wrong, so only the Launcher is asked: `image info`
 * finds the image by its name, ignoring case. Either way, opened is `image
 * info` exiting 0, which still catches a meta-inf.ston it cannot read.
 */
async function verifyMadeImage(
  runner: LauncherCliRunner,
  newImageName: string,
  config: PharoLauncherConfig,
  options: PharoLauncherOptions,
): Promise<MadeImage> {
  const imagesDir = resolveImagesDirectory(config).path;
  const timeoutMs =
    options.imageCopyVerificationTimeoutMs ?? imageCopyVerificationTimeoutMs;
  const pollMs = options.imageCopyVerificationPollMs ?? imageCopyVerificationPollMs;
  const wait = options.sleep ?? sleep;
  const deadline = Date.now() + timeoutMs;
  const seconds = Math.round(timeoutMs / 1000);

  while (true) {
    const listed = readImageDirectory(imagesDir, newImageName);
    let failure: MadeImageFailure;
    if (config.profile && listed.kind !== "image") {
      failure =
        listed.kind === "missing"
          ? { kind: "not-listed", directory: listed.directory, seconds }
          : {
              kind: "not-listed",
              directory: listed.notAnImage.directory,
              notAnImage: listed.notAnImage,
              seconds,
            };
    } else {
      const info = await runLauncherToolCommand(
        runner,
        ["image", "info", newImageName],
        options,
      );
      if (info.exitCode === 0 && !info.timedOut) {
        const made = readImageDirectory(imagesDir, newImageName);
        return {
          ok: true,
          ...(made.kind === "image" ? { image: readLauncherImage(made.image) } : {}),
        };
      }
      failure = { kind: "not-opened", message: launcherMessage(info) };
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return { ok: false, failure };
    }
    await wait(Math.min(pollMs, remainingMs));
  }
}

/**
 * A create or copy, once its image is checked. A run past the call's timeout
 * is checked too, since the Launcher goes on: when the image is there the
 * call succeeds and `command.timedOut` stays true; when it is not, it fails
 * as the timeout it is.
 */
function madeImageResult(
  normalized: LauncherCommandResult,
  made: MadeImage,
  timedOut: boolean,
  said: string,
  newImageName: string,
): MadeImageResult {
  const { data: _data, diagnostic, action, ...rest } = normalized;
  if (made.ok) {
    return { ...rest, ok: true, data: made.image ? { image: made.image } : {} };
  }

  return timedOut
    ? {
        ...rest,
        ...(diagnostic === undefined ? {} : { diagnostic }),
        ...(action === undefined ? {} : { action }),
      }
    : {
        ...rest,
        ok: false,
        diagnostic: madeImageFailureText(made.failure, said, newImageName),
        failure: made.failure,
      };
}

async function madeImageCommand(
  toolName: "pharo_launcher_image_copy" | "pharo_launcher_image_create",
  args: string[],
  newImageName: string | undefined,
  said: string,
  options: PharoLauncherOptions,
): Promise<{
  result: MadeImageResult;
  config: PharoLauncherConfig;
}> {
  const runner = options.runner ?? runLauncherCli;
  const config = options.config ?? loadPharoLauncherConfig();
  const commandOptions = { ...options, config };
  const result = await runLauncherToolCommand(runner, args, commandOptions);
  const normalized = normalizeToolResult(toolName, args, result, commandOptions);

  // A command that exited non-zero refused: there is nothing to check.
  if (!newImageName || !(normalized.ok || result.timedOut)) {
    const { data: _data, ...refused } = normalized;
    return { result: refused, config };
  }

  const made = await verifyMadeImage(runner, newImageName, config, commandOptions);
  return {
    result: madeImageResult(normalized, made, result.timedOut, said, newImageName),
    config,
  };
}

export async function imageCopyResult(
  args: string[],
  options: PharoLauncherOptions,
): Promise<MadeImageResult> {
  const imageName = args[2];
  const newImageName = args[3];
  const { result, config } = await madeImageCommand(
    "pharo_launcher_image_copy",
    args,
    newImageName,
    `copied ${imageName} to ${newImageName}`,
    options,
  );

  // A #vmManager path still naming the source, which only an image the
  // Launcher launched has and which `image copy` renames already.
  if (result.ok && imageName && newImageName) {
    repairCopiedImageMetadata(config, imageName, newImageName);
  }

  return result;
}

export async function imageCreateResult(
  args: string[],
  options: PharoLauncherOptions,
): Promise<MadeImageResult> {
  const newImageName = args.at(-1);
  const { result } = await madeImageCommand(
    "pharo_launcher_image_create",
    args,
    newImageName,
    `created ${newImageName}`,
    options,
  );

  return result;
}

/**
 * What a template update did to the profile's sources.list: downloaded it
 * where there was none (`created`), replaced it with a newer one
 * (`updated`), found it current (`already_present`), kept it when the
 * download failed (`kept`), or failed with none to keep (`failed`).
 */
interface TemplateSourcesBootstrap {
  ok: boolean;
  action: "not_applicable" | "already_present" | "created" | "updated" | "kept" | "failed";
  path?: string;
  url?: string;
  bytes?: number;
  diagnostic?: string;
  error?: string;
}

function profileTemplateSourcesFile(
  config: PharoLauncherConfig | undefined,
): string | undefined {
  return config?.profile
    ? path.join(config.profile.templateSourcesDir, templateSourcesFileName)
    : undefined;
}

function nonEmptyFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

async function defaultFetchTemplateSources(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
  }

  return response.text();
}

/**
 * Downloads the template sources list into the profile on every update, as
 * the Launcher keeps its own up to date: the profile's copy is otherwise the
 * one its first update fetched, and the official templates' names and labels
 * move with each Pharo release. A download that fails keeps the copy there
 * is, which still lists templates offline.
 */
async function ensureProfileTemplateSourcesBootstrap(
  config: PharoLauncherConfig | undefined,
  options: PharoLauncherOptions,
): Promise<TemplateSourcesBootstrap> {
  const sourcesPath = profileTemplateSourcesFile(config);
  if (!sourcesPath) {
    return { ok: true, action: "not_applicable" };
  }

  const present = nonEmptyFile(sourcesPath);
  const url = options.templateSourcesUrl ?? defaultTemplateSourcesUrl;
  try {
    const fetchTemplateSources =
      options.fetchTemplateSources ?? defaultFetchTemplateSources;
    const body = await fetchTemplateSources(url);
    if (body.trim().length === 0) {
      throw new Error("downloaded template source list was empty");
    }
    const bytes = Buffer.byteLength(body, "utf8");
    if (present && fs.readFileSync(sourcesPath, "utf8") === body) {
      return { ok: true, action: "already_present", path: sourcesPath, url, bytes };
    }

    fs.mkdirSync(path.dirname(sourcesPath), { recursive: true });
    const tempPath = `${sourcesPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, body, "utf8");
    fs.renameSync(tempPath, sourcesPath);

    return { ok: true, action: present ? "updated" : "created", path: sourcesPath, url, bytes };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (present) {
      return {
        ok: true,
        action: "kept",
        path: sourcesPath,
        url,
        bytes: fs.statSync(sourcesPath).size,
        error: message,
      };
    }
    return {
      ok: false,
      action: "failed",
      path: sourcesPath,
      url,
      diagnostic:
        `Refreshed the template list, but this profile still has no template ` +
        `sources: downloading ${url} failed (${message}).`,
      error: message,
    };
  }
}

/** What a template update reports beyond the command it ran. */
export interface TemplateUpdateResult extends LauncherCommandResult {
  templateSourcesBootstrap?: Awaited<
    ReturnType<typeof ensureProfileTemplateSourcesBootstrap>
  >;
  templateSourcesProbe?: LauncherCommandResult;
}

export async function templateUpdateResult(
  args: string[],
  options: PharoLauncherOptions,
): Promise<TemplateUpdateResult> {
  const runner = options.runner ?? runLauncherCli;
  const config = options.config ?? loadPharoLauncherConfig();
  const commandOptions = {
    ...options,
    config,
  };
  const result = await runLauncherToolCommand(runner, args, commandOptions);
  const normalized = normalizeToolResult(
    "pharo_launcher_template_update",
    args,
    result,
    commandOptions,
  );

  if (!normalized.ok) {
    return normalized;
  }

  const bootstrap = await ensureProfileTemplateSourcesBootstrap(
    config,
    commandOptions,
  );
  if (!bootstrap.ok) {
    return {
      ...normalized,
      ok: false,
      diagnostic: bootstrap.diagnostic,
      action: `Update the templates again, or put a sources.list in ${path.dirname(
        bootstrap.path ?? "",
      )}.`,
      templateSourcesBootstrap: bootstrap,
    };
  }

  if (bootstrap.action === "not_applicable") {
    return {
      ...normalized,
      templateSourcesBootstrap: bootstrap,
    };
  }

  const probeArgs = ["template", "list", "--ston"];
  const probe = await runLauncherToolCommand(runner, probeArgs, commandOptions);
  const probeResult = normalizeToolResult(
    "pharo_launcher_template_list",
    probeArgs,
    probe,
    commandOptions,
  );
  if (!probeResult.ok) {
    return {
      ...normalized,
      ok: false,
      diagnostic: sentenceWithMessage(
        "Refreshed the template list, but Pharo Launcher still cannot list templates",
        launcherMessage(probe),
      ),
      templateSourcesBootstrap: bootstrap,
      templateSourcesProbe: probeResult,
    };
  }

  return {
    ...normalized,
    templateSourcesBootstrap: bootstrap,
    templateSourcesProbe: probeResult,
  };
}

/** A delete, and once the Launcher deleted the image, the logs of its starts. */
export async function imageDeleteResult(
  args: string[],
  options: PharoLauncherOptions,
): Promise<LauncherCommandResult> {
  const runner = options.runner ?? runLauncherCli;
  const config = options.config ?? loadPharoLauncherConfig();
  const commandOptions = { ...options, config };
  const result = await runLauncherToolCommand(runner, args, commandOptions);
  const normalized = normalizeToolResult(
    "pharo_launcher_image_delete",
    args,
    result,
    commandOptions,
  );
  const imageName = args.at(-1);
  if (normalized.ok && imageName) {
    deleteImageLaunchLogs(config, imageName);
  }
  return normalized;
}

function deleteImageLaunchLogs(config: PharoLauncherConfig, imageName: string): void {
  removeLaunchLogs(
    launchLogsDirectory(config),
    resolveImagesDirectory(config).path,
    imageName,
  );
}

export async function runCommand(
  toolName: string,
  args: string[],
  options: PharoLauncherOptions,
): Promise<LauncherCommandResult> {
  if (toolName === "pharo_launcher_image_copy") {
    return imageCopyResult(args, options);
  }
  if (toolName === "pharo_launcher_image_create") {
    return imageCreateResult(args, options);
  }
  if (toolName === "pharo_launcher_template_update") {
    return templateUpdateResult(args, options);
  }
  if (toolName === "pharo_launcher_image_delete") {
    return imageDeleteResult(args, options);
  }

  if (toolName.startsWith("pharo_launcher_process_")) {
    return normalizeToolResult(
      toolName,
      args,
      await runProcessCommand(args, options),
      options,
    );
  }

  const runner = options.runner ?? runLauncherCli;
  const result = await runLauncherToolCommand(runner, args, options);
  return normalizeToolResult(toolName, args, result, options);
}

function nativeProcessOptions(
  options: PharoLauncherOptions,
): RunNativeProcessToolOptions {
  return {
    ...options.nativeProcess,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  };
}

/**
 * The process tools, always on the native process list: the Launcher's own
 * shortens a path over 75 characters, so nothing could be matched in it.
 *
 * In profile mode they see the VMs running one of the profile's images, so a
 * caller in an isolated profile can neither list nor kill the user's own.
 * Outside a profile they see every Pharo VM on the machine, as on 0.4.1.
 */
function runProcessCommand(
  args: string[],
  options: PharoLauncherOptions,
): Promise<LauncherCliResult> {
  const config = options.config ?? loadPharoLauncherConfig();
  const nativeOptions = nativeProcessOptions(options);
  return runNativeProcessTool(
    args,
    nativeOptions,
    config.profile
      ? imagesProcessScope(
          resolveImagesDirectory(config).path,
          nativeOptions.platform,
        )
      : undefined,
  );
}

type ImageProcesses = { processes: LauncherProcess[] } | { failure: string };

/** The VMs running these images, or why the process list failed. */
async function processesRunning(
  images: readonly ImageEntry[],
  options: PharoLauncherOptions,
): Promise<ImageProcesses> {
  if (images.length === 0) {
    return { processes: [] };
  }

  const nativeOptions = nativeProcessOptions(options);
  try {
    return {
      processes: processesOfImages(
        images,
        await listNativeProcesses(nativeOptions),
        nativeOptions.platform,
      ),
    };
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) };
  }
}

function imageWithPids(
  entry: ImageEntry,
  running: ImageProcesses,
): LauncherImage {
  const image = readLauncherImage(entry);
  if ("failure" in running) {
    return image;
  }

  const pids = running.processes
    .filter((process) => process.imageName === entry.name)
    .map((process) => process.pid)
    .sort((left, right) => left - right);
  return { ...image, pids };
}

/**
 * This Launcher's images, read from its images directory, each with whether
 * it runs. No Launcher call, in every mode.
 */
export async function listImagesResult(
  input: unknown,
  options: PharoLauncherOptions,
): Promise<LauncherImageList> {
  const nameFilter = optionalString(argumentsObject(input), "nameFilter");
  const imagesDir = resolveImagesDirectory(
    options.config ?? loadPharoLauncherConfig(),
  ).path;
  const scan = scanImages(imagesDir);
  const images = filterByName(scan.images, nameFilter);
  const running = await processesRunning(images, options);

  return {
    imagesDir,
    images: images.map((entry) => imageWithPids(entry, running)),
    notImages: filterByName(scan.notImages, nameFilter),
    ...("failure" in running ? { processListFailure: running.failure } : {}),
  };
}

/** One image of this Launcher, found as every tool finds it. */
export async function imageInfoResult(
  input: unknown,
  options: PharoLauncherOptions,
): Promise<LauncherImageInfo> {
  const imageName = requiredString(argumentsObject(input), "imageName");
  const imagesDir = resolveImagesDirectory(
    options.config ?? loadPharoLauncherConfig(),
  ).path;
  const scan = scanImages(imagesDir);
  const entry = findByName(scan.images, imageName);
  if (!entry) {
    const notAnImage = findByName(scan.notImages, imageName);
    return { found: false, imagesDir, ...(notAnImage ? { notAnImage } : {}) };
  }

  const running = await processesRunning([entry], options);
  return {
    found: true,
    imagesDir,
    image: imageWithPids(entry, running),
    ...("failure" in running ? { processListFailure: running.failure } : {}),
  };
}

/**
 * What every call takes beside its own arguments: whether its result carries
 * what the Launcher wrote, as `raw`.
 */
export interface LauncherTableOptions {
  includeRaw?: boolean;
}

export interface ImageCreateInput extends LauncherTableOptions {
  templateName: string;
  newImageName: string;
  templateCategory?: string;
  dev?: boolean;
}

export interface ImageStartInput extends LauncherTableOptions {
  imageName: string;
  /** Relative to the calling process's working directory. */
  script?: string;
  detached?: boolean;
  /** Profile mode only: PharoLauncher's own image launch has no display mode. */
  displayMode?: "headless" | "interactive";
}

/**
 * What this package does, named as what it does.
 *
 * Every call builds its arguments through the same catalog the MCP tools use,
 * so the two cannot disagree about what `image create` takes. The types are
 * the thing a caller gets here and does not get over a protocol.
 */
export interface PharoLauncher {
  describeConfig(): PharoLauncherConfigReport;
  listImages(
    input?: { nameFilter?: string } & LauncherTableOptions,
  ): Promise<LauncherImageList>;
  imageInfo(
    input: { imageName: string } & LauncherTableOptions,
  ): Promise<LauncherImageInfo>;
  /**
   * Its `data` is `{ image?: LauncherImage }`, the image when the images
   * directory holds it, and `failure` says why a command that exited 0 made
   * none.
   */
  createImage(input: ImageCreateInput): Promise<MadeImageResult>;
  /** Its `data` and `failure` are as `createImage`'s. */
  copyImage(
    input: { imageName: string; newImageName: string } & LauncherTableOptions,
  ): Promise<MadeImageResult>;
  startImage(input: ImageStartInput): Promise<LauncherCommandResult>;
  /** Deletes the logs of the image's starts too. */
  deleteImage(
    input: { imageName: string } & LauncherTableOptions,
  ): Promise<LauncherCommandResult>;
  /**
   * Delete the logs of a deleted image's starts, for a caller that removed
   * its directory itself. Logs the images directory still has an image for
   * (one of the same name, or whose name makes the same file name) are kept.
   */
  deleteLaunchLogs(input: { imageName: string }): void;
  listProcesses(
    input?: LauncherTableOptions,
  ): Promise<LauncherCommandResult<LauncherProcess[]>>;
  killProcess(
    input: ({ pid: number | string } | { imageName: string }) &
      LauncherTableOptions,
  ): Promise<LauncherCommandResult>;
  /** The categories in the Launcher's order, and which is its default. */
  listTemplateCategories(
    input?: LauncherTableOptions,
  ): Promise<TemplateCategoriesResult>;
  /**
   * The templates of a category, in the Launcher's order. Those it keeps on
   * disk (`local`) are left out unless `includeLocal` asks for them: the
   * Launcher keeps a copy of every template it downloads under the same name,
   * in a category of its own (`Templates`), so every template downloaded once
   * would otherwise be listed under one name in two categories. Naming a
   * category does not change it, since the copies are in a category too. The
   * templates the user made from an
   * image are left out too: the Launcher keeps them in the same category, of
   * the same class, so nothing tells them from its copies.
   */
  listTemplates(
    input?: { templateCategory?: string; includeLocal?: boolean } & LauncherTableOptions,
  ): Promise<LauncherCommandResult<LauncherTemplate[]>>;
  updateTemplates(input?: LauncherTableOptions): Promise<TemplateUpdateResult>;
  copyImageBetweenProfiles(
    input: unknown,
  ): ReturnType<typeof copyImageBetweenProfiles>;
}

export interface OpenPharoLauncherOptions extends PharoLauncherOptions {
  /**
   * Resolve the installation and the profile from this environment rather
   * than from `process.env`, which is how a caller scopes a call to a profile
   * without a process of its own.
   */
  env?: NodeJS.ProcessEnv;
}

/** The longest path anything under this directory already has. */
function longestDescendantLength(directory: string): number | undefined {
  if (!fs.existsSync(directory)) {
    return undefined;
  }

  let longest = 0;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        longest = Math.max(longest, full.length);
      }
    }
  };

  walk(directory);
  return longest === 0 ? undefined : longest;
}

/**
 * Refuse to start an image the VM could not load its own modules for.
 *
 * Starting it anyway reports a missing symbol in a file that is present and
 * correct, which is a long way from the profile root being too deep.
 */
function assertLauncherModulePathsFit(
  config: PharoLauncherConfig | undefined,
): void {
  // Resolved the way runCommand resolves it: a launcher opened with no
  // arguments has no config until a call loads one, and the profile this
  // check is about lives in it.
  const vmsDirectory = (config ?? loadPharoLauncherConfig())?.profile?.vmsDir;
  if (vmsDirectory === undefined) {
    return;
  }

  const budget = launcherModulePathBudget(vmsDirectory, longestDescendantLength);
  if (!budget.ok) {
    throw new ProfileTooDeepError(launcherModulePathBudgetMessage(budget));
  }
}

export function openPharoLauncher(
  options: OpenPharoLauncherOptions = {},
): PharoLauncher {
  const { env, ...rest } = options;
  const config =
    options.config ??
    (env ? loadPharoLauncherConfig({ ...process.env, ...env }) : undefined);
  const resolved: PharoLauncherOptions = {
    ...rest,
    ...(config ? { config } : {}),
  };

  async function command<T>(
    toolName: string,
    input: unknown,
  ): Promise<LauncherCommandResult<T>> {
    const args = buildLauncherCommandArgs(toolName, input ?? {});
    if (!args) {
      throw new ToolInputError(`Unknown launcher command: ${toolName}`);
    }

    return (await runCommand(
      toolName,
      args,
      commandResultOptions(input ?? {}, resolved),
    )) as LauncherCommandResult<T>;
  }

  return {
    describeConfig: () => getPharoLauncherConfigReport(resolved.config),
    listImages: async (input) => listImagesResult(input ?? {}, resolved),
    imageInfo: async (input) => imageInfoResult(input, resolved),
    createImage: (input) => command("pharo_launcher_image_create", input),
    copyImage: (input) => command("pharo_launcher_image_copy", input),
    // A function that answers a promise refuses with one, not with a throw.
    startImage: async (input) => {
      assertLauncherModulePathsFit(resolved.config);
      return command("pharo_launcher_image_start", input);
    },
    deleteImage: (input) => command("pharo_launcher_image_delete", input),
    deleteLaunchLogs: (input) =>
      deleteImageLaunchLogs(
        resolved.config ?? loadPharoLauncherConfig(),
        requiredString(argumentsObject(input), "imageName"),
      ),
    listProcesses: (input) => command("pharo_launcher_process_list", input),
    killProcess: (input) => command("pharo_launcher_process_kill", input),
    listTemplateCategories: (input) =>
      command("pharo_launcher_template_category_list", input) as Promise<
        TemplateCategoriesResult
      >,
    listTemplates: async (input) => {
      const result = await command<LauncherTemplate[]>("pharo_launcher_template_list", input);
      return input?.includeLocal === true || result.data === undefined
        ? result
        : { ...result, data: result.data.filter((template) => !template.local) };
    },
    updateTemplates: (input) =>
      command("pharo_launcher_template_update", input) as Promise<
        TemplateUpdateResult
      >,
    copyImageBetweenProfiles: (input) => copyImageBetweenProfiles(input),
  };
}
