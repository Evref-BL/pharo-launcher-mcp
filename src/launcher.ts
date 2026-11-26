/**
 * What this package knows how to do, as functions: the implementation behind
 * the library (`library.ts`) and the MCP server (`server.ts`).
 *
 * `openLauncher` takes a resolved config and the hooks tests give; the
 * library's `openPharoLauncher` takes what a program says, and the server's
 * calls take the command's variables.
 */
import fs from "node:fs";
import path from "node:path";
import {
  launcherModulePathBudget,
  launcherModulePathBudgetMessage,
} from "./platform.js";
import {
  commandArgs,
  inputObject,
  optionalString,
  ProfileTooDeepError,
  requiredString,
} from "./commandCatalog.js";
import { loadPharoLauncherConfig, type PharoLauncherConfig } from "./config.js";
import {
  getPharoLauncherConfigReport,
  type LauncherCliRunner,
  type PharoLauncherConfigReport,
} from "./discovery.js";
import {
  buildLauncherCliInvocation,
  launcherInvocationFailureDiagnostic,
  runLauncherCli,
  type LauncherCliResult,
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
  launcherRefusal,
  normalizeLauncherResult,
  sentenceWithMessage,
} from "./resultNormalizer.js";
import {
  copyImageBetweenProfiles,
  type CopyBetweenProfilesInput,
  type CopyBetweenProfilesResult,
} from "./crossProfileCopy.js";
import type {
  KillProcessResult,
  LauncherCommandResult,
  LauncherImage,
  LauncherImageInfo,
  LauncherImageList,
  LauncherProcess,
  LauncherTemplate,
  MadeImageFailure,
  MadeImageResult,
  StartImageResult,
  TemplateCategoriesResult,
  TemplateListResult,
  TemplateSources,
  TemplateUpdateResult,
} from "./models.js";

const defaultTemplateSourcesUrl =
  "https://files.pharo.org/pharo-launcher/sources.list";
const templateSourcesFileName = "sources.list";
const imageCopyVerificationTimeoutMs = 30_000;
const imageCopyVerificationPollMs = 1_000;

/** A config, how long a command may take, and the hooks tests give. */
export interface PharoLauncherOptions {
  config?: PharoLauncherConfig;
  timeoutMs?: number;
  runner?: LauncherCliRunner;
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

// --- What a call takes --------------------------------------------------

export interface CreateImageInput {
  /** The new image's name. */
  image: string;
  /** A template's name, as `listTemplates` lists it. */
  template: string;
  /** The template's category, when its name is in several. */
  category?: string;
}

export interface CopyImageInput {
  image: string;
  newImage: string;
}

export interface StartImageInput {
  image: string;
  /** A script for the image to run; relative to the calling process's working directory. */
  script?: string;
  /** Leave the image running rather than wait for it to quit. */
  detached?: boolean;
  /** Profile mode only: PharoLauncher's own image launch has no display mode. */
  displayMode?: "headless" | "interactive";
}

/** A pid stops that process alone; an image stops every process running it. */
export type KillProcessInput = { pid: number } | { image: string };

export interface ListTemplatesInput {
  /** The Launcher's default category when left out. */
  category?: string;
  /**
   * Also the templates the Launcher keeps on disk: its copies of the remote
   * ones it downloaded, and those the user made from an image.
   */
  includeLocal?: boolean;
}

/**
 * What this package does, named as what it does. The types are what a caller
 * gets here and does not get over a protocol.
 */
export interface PharoLauncher {
  /** Which Launcher it runs, and where its images are. */
  describeConfig(): PharoLauncherConfigReport;
  /** The images, each with whether it runs; `nameFilter` keeps the names containing it. */
  listImages(input?: { nameFilter?: string }): Promise<LauncherImageList>;
  imageInfo(input: { image: string }): Promise<LauncherImageInfo>;
  /** Its `data` is the image, when the images directory holds it. */
  createImage(input: CreateImageInput): Promise<MadeImageResult>;
  /** Its `data` and `failure` are as `createImage`'s. */
  copyImage(input: CopyImageInput): Promise<MadeImageResult>;
  startImage(input: StartImageInput): Promise<StartImageResult>;
  /** Deletes the logs of the image's starts too. */
  deleteImage(input: { image: string }): Promise<LauncherCommandResult>;
  /**
   * Delete the logs of a deleted image's starts, for a caller that removed
   * its directory itself. Logs the images directory still has an image for
   * (one of the same name, or whose name makes the same file name) are kept.
   */
  deleteLaunchLogs(input: { image: string }): void;
  /** The processes running one of this Launcher's images. */
  listProcesses(): Promise<LauncherCommandResult<LauncherProcess[]>>;
  /** Kills among the processes `listProcesses` sees. */
  killProcess(input: KillProcessInput): Promise<KillProcessResult>;
  /** The categories in the Launcher's order, and which is its default. */
  listTemplateCategories(): Promise<TemplateCategoriesResult>;
  /**
   * The templates of a category, in the Launcher's order. Those it keeps on
   * disk (`local`) are left out unless `includeLocal` asks for them: the
   * Launcher keeps a copy of every template it downloads under the same name,
   * so every template downloaded once would otherwise be listed twice. The
   * templates the user made from an image are left out with them, since
   * nothing in the listing tells the two apart.
   */
  listTemplates(input?: ListTemplatesInput): Promise<TemplateListResult>;
  /** Refreshes the template list; in a profile, downloads its sources.list first. */
  updateTemplates(): Promise<TemplateUpdateResult>;
  /**
   * Copy an image from one images directory to another, such as from the
   * user's own Launcher into a profile. Nothing runs: the files are copied and
   * checked.
   */
  copyImageBetweenProfiles(input: CopyBetweenProfilesInput): Promise<CopyBetweenProfilesResult>;
}

// --- Running a command ----------------------------------------------------

function configOf(options: PharoLauncherOptions): PharoLauncherConfig {
  return options.config ?? loadPharoLauncherConfig();
}

async function runLauncherCommand(
  args: readonly string[],
  options: PharoLauncherOptions,
): Promise<LauncherCliResult> {
  const runner = options.runner ?? runLauncherCli;
  const startTime = Date.now();
  try {
    return await runner(args, {
      config: configOf(options),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
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
    return launcherInvocationFailureDiagnostic(
      buildLauncherCliInvocation(args, configOf(options)),
      normalizedError,
    );
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

// --- Making an image -------------------------------------------------------

type MadeImage =
  | { ok: true; image?: LauncherImage }
  | { ok: false; failure: MadeImageFailure };

/**
 * Why a create or copy made no image, in a sentence. `said` is what the
 * Launcher said it did (`created X`, `copied X to Y`), and `newImage` the
 * image it made, each written as the caller writes names. Undefined for a
 * template or category the Launcher did not know, which a caller says its own
 * way.
 */
export function madeImageFailureText(
  failure: MadeImageFailure,
  said: string,
  newImage: string,
): string | undefined {
  switch (failure.kind) {
    case "not-opened":
      return sentenceWithMessage(
        `Pharo Launcher made ${newImage} but cannot open it`,
        failure.message,
      );
    case "not-listed": {
      const lacks = failure.notAnImage
        ? `${failure.notAnImage.directory} ${whatItLacks(failure.notAnImage)}`
        : `${failure.directory} does not exist`;
      return `Pharo Launcher said it ${said}, but ${lacks} after ${failure.seconds} s.`;
    }
    default:
      return undefined;
  }
}

/**
 * Whether the Launcher can list the image a create or copy made, and open it,
 * polled until it can or the time is up.
 *
 * In profile mode, where this package wrote the images directory itself,
 * listed is the directory holding the image under the exact new name (the
 * Launcher makes `baseDirectory / targetName`). Outside a profile the
 * directory read from the settings can be wrong, so only the Launcher is
 * asked: `image info` finds the image by its name, ignoring case. Either way,
 * opened is `image info` exiting 0, which still catches a meta-inf.ston it
 * cannot read.
 */
async function verifyMadeImage(
  newImage: string,
  options: PharoLauncherOptions,
): Promise<MadeImage> {
  const config = configOf(options);
  const imagesDir = resolveImagesDirectory(config).path;
  const timeoutMs = options.imageCopyVerificationTimeoutMs ?? imageCopyVerificationTimeoutMs;
  const pollMs = options.imageCopyVerificationPollMs ?? imageCopyVerificationPollMs;
  const wait = options.sleep ?? sleep;
  const deadline = Date.now() + timeoutMs;
  const seconds = Math.round(timeoutMs / 1000);

  while (true) {
    const listed = readImageDirectory(imagesDir, newImage);
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
      const info = await runLauncherCommand(["image", "info", newImage], options);
      if (info.exitCode === 0 && !info.timedOut) {
        const made = readImageDirectory(imagesDir, newImage);
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
async function madeImageCommand(
  args: string[],
  newImage: string,
  said: string,
  options: PharoLauncherOptions,
): Promise<MadeImageResult> {
  const result = await runLauncherCommand(args, options);
  const { data: _data, ...normalized } = normalizeLauncherResult(args, result);

  // A command that exited non-zero refused: there is nothing to check.
  if (!normalized.ok && !result.timedOut) {
    const refusal = launcherRefusal(result);
    return refusal ? { ...normalized, failure: { kind: refusal } } : normalized;
  }

  const made = await verifyMadeImage(newImage, options);
  if (made.ok) {
    return { ...normalized, ok: true, ...(made.image ? { data: { image: made.image } } : {}) };
  }
  return result.timedOut
    ? normalized
    : {
        ...normalized,
        ok: false,
        diagnostic: madeImageFailureText(made.failure, said, newImage),
        failure: made.failure,
      };
}

async function createImage(
  input: CreateImageInput,
  options: PharoLauncherOptions,
): Promise<MadeImageResult> {
  const args = commandArgs.createImage(input);
  return madeImageCommand(args, input.image, `created ${input.image}`, options);
}

async function copyImage(
  input: CopyImageInput,
  options: PharoLauncherOptions,
): Promise<MadeImageResult> {
  const args = commandArgs.copyImage(input);
  const result = await madeImageCommand(
    args,
    input.newImage,
    `copied ${input.image} to ${input.newImage}`,
    options,
  );

  // A #vmManager path still naming the source, which only an image the
  // Launcher launched has and which `image copy` renames already.
  if (result.ok) {
    repairCopiedImageMetadata(configOf(options), input.image, input.newImage);
  }

  return result;
}

// --- The templates ------------------------------------------------------------

function profileTemplateSourcesFile(config: PharoLauncherConfig): string | undefined {
  return config.profile
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
async function refreshProfileTemplateSources(
  sourcesPath: string,
  options: PharoLauncherOptions,
): Promise<TemplateSources> {
  const present = nonEmptyFile(sourcesPath);
  const url = options.templateSourcesUrl ?? defaultTemplateSourcesUrl;
  try {
    const fetchTemplateSources = options.fetchTemplateSources ?? defaultFetchTemplateSources;
    const body = await fetchTemplateSources(url);
    if (body.trim().length === 0) {
      throw new Error("downloaded template source list was empty");
    }
    if (present && fs.readFileSync(sourcesPath, "utf8") === body) {
      return { outcome: "unchanged", path: sourcesPath, url };
    }

    fs.mkdirSync(path.dirname(sourcesPath), { recursive: true });
    const tempPath = `${sourcesPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, body, "utf8");
    fs.renameSync(tempPath, sourcesPath);

    return { outcome: present ? "updated" : "created", path: sourcesPath, url };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { outcome: present ? "kept" : "failed", path: sourcesPath, url, error: message };
  }
}

async function updateTemplates(options: PharoLauncherOptions): Promise<TemplateUpdateResult> {
  const args = commandArgs.updateTemplates();
  const result = await runLauncherCommand(args, options);
  const { data: _data, ...normalized } = normalizeLauncherResult(args, result);
  const sourcesPath = profileTemplateSourcesFile(configOf(options));
  if (!normalized.ok || sourcesPath === undefined) {
    return normalized;
  }

  const sources = await refreshProfileTemplateSources(sourcesPath, options);
  if (sources.outcome === "failed") {
    return {
      ...normalized,
      ok: false,
      diagnostic:
        "Refreshed the template list, but this profile still has no template " +
        `sources: downloading ${sources.url} failed (${sources.error}).`,
      action: `Update the templates again, or put a sources.list in ${path.dirname(sourcesPath)}.`,
      sources,
    };
  }

  // The Launcher reads the list it was given, which it may not understand.
  const probeArgs = commandArgs.listTemplates({});
  const probe = await runLauncherCommand(probeArgs, options);
  if (!normalizeLauncherResult(probeArgs, probe).ok) {
    return {
      ...normalized,
      ok: false,
      diagnostic: sentenceWithMessage(
        "Refreshed the template list, but Pharo Launcher still cannot list templates",
        launcherMessage(probe),
      ),
      sources,
    };
  }

  return { ...normalized, sources };
}

async function listTemplateCategories(
  options: PharoLauncherOptions,
): Promise<TemplateCategoriesResult> {
  const args = commandArgs.listTemplateCategories();
  return normalizeLauncherResult(
    args,
    await runLauncherCommand(args, options),
  ) as TemplateCategoriesResult;
}

async function listTemplates(
  input: ListTemplatesInput,
  options: PharoLauncherOptions,
): Promise<TemplateListResult> {
  const args = commandArgs.listTemplates(input);
  const result = await runLauncherCommand(args, options);
  const normalized = normalizeLauncherResult(args, result) as LauncherCommandResult<
    LauncherTemplate[]
  >;
  if (!normalized.ok) {
    return !result.timedOut && launcherRefusal(result) === "unknown-category"
      ? { ...normalized, failure: { kind: "unknown-category" } }
      : normalized;
  }

  return input.includeLocal === true || normalized.data === undefined
    ? normalized
    : { ...normalized, data: normalized.data.filter((template) => !template.local) };
}

// --- Starting and deleting -------------------------------------------------------

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
function assertLauncherModulePathsFit(config: PharoLauncherConfig): void {
  const vmsDirectory = config.profile?.vmsDir;
  if (vmsDirectory === undefined) {
    return;
  }

  const budget = launcherModulePathBudget(vmsDirectory, longestDescendantLength);
  if (!budget.ok) {
    throw new ProfileTooDeepError(launcherModulePathBudgetMessage(budget));
  }
}

async function startImage(
  input: StartImageInput,
  options: PharoLauncherOptions,
): Promise<StartImageResult> {
  const args = commandArgs.startImage(input);
  assertLauncherModulePathsFit(configOf(options));
  const result = await runLauncherCommand(args, options);
  const { data: _data, ...normalized } = normalizeLauncherResult(args, result);
  const launch =
    result.launch?.by === "launcher" && !result.launch.pid && !result.launch.logs
      ? { ...result.launch, output: { stdout: result.stdout, stderr: result.stderr } }
      : result.launch;
  return launch ? { ...normalized, launch } : normalized;
}

function deleteImageLaunchLogs(config: PharoLauncherConfig, image: string): void {
  removeLaunchLogs(launchLogsDirectory(config), resolveImagesDirectory(config).path, image);
}

/** A delete, and once the Launcher deleted the image, the logs of its starts. */
async function deleteImage(
  input: { image: string },
  options: PharoLauncherOptions,
): Promise<LauncherCommandResult> {
  const args = commandArgs.deleteImage(input);
  const result = await runLauncherCommand(args, options);
  const { data: _data, ...normalized } = normalizeLauncherResult(args, result);
  if (normalized.ok) {
    deleteImageLaunchLogs(configOf(options), input.image);
  }
  return normalized;
}

// --- The processes ----------------------------------------------------------------

function nativeProcessOptions(options: PharoLauncherOptions): RunNativeProcessToolOptions {
  return {
    ...options.nativeProcess,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  };
}

/**
 * The process commands, always on the native process list: the Launcher's own
 * shortens a path over 75 characters, so nothing could be matched in it. They
 * see the VMs running one of this Launcher's images, in a profile as outside
 * one, so a call can neither list nor kill a VM it has no image for.
 */
function runProcessCommand(
  args: string[],
  options: PharoLauncherOptions,
): Promise<LauncherCliResult> {
  const nativeOptions = nativeProcessOptions(options);
  return runNativeProcessTool(
    args,
    nativeOptions,
    imagesProcessScope(resolveImagesDirectory(configOf(options)).path, nativeOptions.platform),
  );
}

async function listProcesses(
  options: PharoLauncherOptions,
): Promise<LauncherCommandResult<LauncherProcess[]>> {
  const args = commandArgs.listProcesses();
  return normalizeLauncherResult(
    args,
    await runProcessCommand(args, options),
  ) as LauncherCommandResult<LauncherProcess[]>;
}

async function killProcess(
  input: KillProcessInput,
  options: PharoLauncherOptions,
): Promise<KillProcessResult> {
  const args = commandArgs.killProcess(input);
  const result = await runProcessCommand(args, options);
  const { data: _data, ...normalized } = normalizeLauncherResult(args, result);
  return result.kill ? { ...normalized, data: result.kill } : normalized;
}

// --- The images on disk ------------------------------------------------------

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

function imageWithPids(entry: ImageEntry, running: ImageProcesses): LauncherImage {
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
async function listImages(
  input: { nameFilter?: string },
  options: PharoLauncherOptions,
): Promise<LauncherImageList> {
  const nameFilter = optionalString(inputObject(input), "nameFilter");
  const imagesDir = resolveImagesDirectory(configOf(options)).path;
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

/** One image of this Launcher, found as every call finds it. */
async function imageInfo(
  input: { image: string },
  options: PharoLauncherOptions,
): Promise<LauncherImageInfo> {
  const image = requiredString(inputObject(input), "image");
  const imagesDir = resolveImagesDirectory(configOf(options)).path;
  const scan = scanImages(imagesDir);
  const entry = findByName(scan.images, image);
  if (!entry) {
    const notAnImage = findByName(scan.notImages, image);
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

// --- Opening it ----------------------------------------------------------------

/**
 * The launcher on a config, resolved once: from `options.config`, else from
 * the command's variables. A function that answers a promise refuses with
 * one, not with a throw.
 */
export function openLauncher(options: PharoLauncherOptions = {}): PharoLauncher {
  const resolved: PharoLauncherOptions = { ...options, config: configOf(options) };
  const config = resolved.config!;

  return {
    describeConfig: () => getPharoLauncherConfigReport(config),
    listImages: async (input) => listImages(input ?? {}, resolved),
    imageInfo: async (input) => imageInfo(input, resolved),
    createImage: async (input) => createImage(input, resolved),
    copyImage: async (input) => copyImage(input, resolved),
    startImage: async (input) => startImage(input, resolved),
    deleteImage: async (input) => deleteImage(input, resolved),
    deleteLaunchLogs: (input) =>
      deleteImageLaunchLogs(config, requiredString(inputObject(input), "image")),
    listProcesses: async () => listProcesses(resolved),
    killProcess: async (input) => killProcess(input, resolved),
    listTemplateCategories: async () => listTemplateCategories(resolved),
    listTemplates: async (input) => listTemplates(input ?? {}, resolved),
    updateTemplates: async () => updateTemplates(resolved),
    copyImageBetweenProfiles: async (input) => copyImageBetweenProfiles(input),
  };
}

