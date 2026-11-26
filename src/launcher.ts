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
  InvalidInputError,
  optionalString,
  ProfileTooDeepError,
  requiredImageName,
} from "./commandCatalog.js";
import { loadPharoLauncherConfig, type PharoLauncherConfig } from "./config.js";
import type { LauncherCliRunner } from "./discovery.js";
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
import type {
  DeleteImageResult,
  KillProcessResult,
  LauncherCommandResult,
  LauncherImage,
  LauncherImageInfo,
  LauncherImageList,
  LauncherProcess,
  LauncherTemplate,
  MadeImageFailure,
  MadeImageResult,
  NameTaken,
  NoSuchImage,
  NotAnImage,
  ProcessListResult,
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
export type KillProcessInput = { pid: number; image?: never } | { image: string; pid?: never };

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
 *
 * Its methods may grow in a minor release: a program that implements it, as
 * a test double does, implements the `Pick` of the methods it calls.
 */
export interface PharoLauncher {
  /** The images, each with whether it runs; `nameFilter` keeps the names containing it. */
  listImages(input?: { nameFilter?: string }): Promise<LauncherImageList>;
  /** One image, found as every call finds it: exactly, else ignoring case. */
  imageInfo(input: { image: string }): Promise<LauncherImageInfo>;
  /**
   * Its `data` is the image, when the images directory holds it. In a
   * profile, a name an image has already is refused (`name-taken`).
   */
  createImage(input: CreateImageInput): Promise<MadeImageResult>;
  /**
   * Its `data` and `failure` are as `createImage`'s. In a profile, a source
   * that does not exist is refused (`no-such-image`).
   */
  copyImage(input: CopyImageInput): Promise<MadeImageResult>;
  /** In a profile, an image that does not exist is refused (`no-such-image`). */
  startImage(input: StartImageInput): Promise<StartImageResult>;
  /**
   * Deletes the image, without asking, and the logs of its starts. Refuses an
   * image a VM runs, and one it cannot tell, the process list failing; in a
   * profile, refuses an image that does not exist.
   */
  deleteImage(input: { image: string }): Promise<DeleteImageResult>;
  /**
   * Delete the logs of a deleted image's starts, for a caller that removed
   * its directory itself. Logs the images directory still has an image for
   * (one of the same name, or whose name makes the same file name) are kept.
   */
  deleteLaunchLogs(input: { image: string }): Promise<void>;
  /** The processes running one of this Launcher's images. */
  listProcesses(): Promise<ProcessListResult>;
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
        failure.diagnostic,
      );
    case "not-listed": {
      const lacks = failure.notAnImage
        ? `${failure.notAnImage.directory} ${whatItLacks(failure.notAnImage)}`
        : `${failure.directory} does not exist`;
      return `Pharo Launcher said it ${said}, but ${lacks} after ${Math.round(failure.waitedMs / 1000)} s.`;
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

  while (true) {
    const listed = readImageDirectory(imagesDir, newImage);
    let failure: MadeImageFailure;
    if (config.profile && listed.kind !== "image") {
      failure =
        listed.kind === "missing"
          ? { kind: "not-listed", directory: listed.directory, waitedMs: timeoutMs }
          : {
              kind: "not-listed",
              directory: listed.notAnImage.directory,
              notAnImage: listed.notAnImage,
              waitedMs: timeoutMs,
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
      failure = { kind: "not-opened", diagnostic: launcherMessage(info) };
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
    if (refusal === "unknown-category" && hasNoTemplates(configOf(options))) {
      return { ...normalized, ...noTemplates() };
    }
    return refusal ? { ...normalized, failure: { kind: refusal } } : normalized;
  }

  const made = await verifyMadeImage(newImage, options);
  if (made.ok) {
    // What a command that outlived the call wrote is no failure's.
    const { diagnostic: _diagnostic, action: _action, ...ran } = normalized;
    return { ...ran, ok: true, ...(made.image ? { data: { image: made.image } } : {}) };
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

// --- What a call refuses before running anything -----------------------------

/** What `ok: false` reports for a call refused before any Launcher command ran. */
function refused<F>(failure: F, diagnostic: string, action?: string) {
  return { ok: false as const, failure, diagnostic, ...(action ? { action } : {}) };
}

function noSuchImageDiagnostic(image: string, imagesDir: string, notAnImage?: NotAnImage): string {
  return notAnImage
    ? `There is no image ${image} in ${imagesDir}: its directory ${whatItLacks(notAnImage)}`
    : `There is no image ${image} in ${imagesDir}`;
}

/**
 * In a profile, where this package wrote the images directory itself, an
 * image a call names that is not there. Outside one the directory comes from
 * settings that can be wrong, so the Launcher's answer is the answer.
 */
function missingImage(image: string, options: PharoLauncherOptions) {
  const config = configOf(options);
  if (!config.profile) {
    return undefined;
  }
  const imagesDir = resolveImagesDirectory(config).path;
  const scan = scanImages(imagesDir);
  if (findByName(scan.images, image)) {
    return undefined;
  }
  const notAnImage = findByName(scan.notImages, image);
  const failure: NoSuchImage = { kind: "no-such-image", image, ...(notAnImage ? { notAnImage } : {}) };
  return refused(failure, noSuchImageDiagnostic(image, imagesDir, notAnImage));
}

/** In a profile, a new name an image has already, in any case. */
function takenName(newImage: string, options: PharoLauncherOptions) {
  const config = configOf(options);
  if (!config.profile) {
    return undefined;
  }
  const imagesDir = resolveImagesDirectory(config).path;
  const taken = findByName(scanImages(imagesDir).images, newImage);
  if (!taken) {
    return undefined;
  }
  const failure: NameTaken = { kind: "name-taken", image: taken.name };
  return refused(
    failure,
    `There is already an image ${taken.name} in ${imagesDir}`,
    "Pick another name, or delete that image first.",
  );
}

/** Whether a profile has no template sources yet, which only an update fetches. */
function hasNoTemplates(config: PharoLauncherConfig): boolean {
  const sourcesPath = profileTemplateSourcesFile(config);
  if (sourcesPath === undefined) {
    return false;
  }
  try {
    return fs.readFileSync(sourcesPath, "utf8").trim().length === 0;
  } catch {
    return true;
  }
}

function noTemplates() {
  return {
    ok: false as const,
    failure: { kind: "no-templates" as const },
    diagnostic: "This profile has no templates yet",
    action: "Update the templates first.",
  };
}

async function createImage(
  input: CreateImageInput,
  options: PharoLauncherOptions,
): Promise<MadeImageResult> {
  const args = commandArgs.createImage(input);
  const taken = takenName(input.image, options);
  if (taken) {
    return taken;
  }
  return madeImageCommand(args, input.image, `created ${input.image}`, options);
}

async function copyImage(
  input: CopyImageInput,
  options: PharoLauncherOptions,
): Promise<MadeImageResult> {
  const args = commandArgs.copyImage(input);
  const refused = missingImage(input.image, options) ?? takenName(input.newImage, options);
  if (refused) {
    return refused;
  }
  const result = await madeImageCommand(
    args,
    input.newImage,
    `copied ${input.image} to ${input.newImage}`,
    options,
  );

  // A #vmManager path still naming the source, which only an image the
  // Launcher launched has and which `image copy` renames already. The source
  // is named as its directory spells it, which a name in another case finds.
  // A repair that fails leaves the copy as the Launcher made it, which opens.
  if (result.ok) {
    const config = configOf(options);
    const source = config.profile
      ? (findByName(scanImages(resolveImagesDirectory(config).path).images, input.image)?.name ??
        input.image)
      : input.image;
    try {
      repairCopiedImageMetadata(config, source, input.newImage);
    } catch {
      // As the Launcher made it.
    }
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

/** As long as a Launcher command may run: the list is small, a stalled server is not. */
const templateSourcesFetchTimeoutMs = 30_000;

async function defaultFetchTemplateSources(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(templateSourcesFetchTimeoutMs) });
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
      return { kind: "unchanged", path: sourcesPath, url };
    }

    fs.mkdirSync(path.dirname(sourcesPath), { recursive: true });
    const tempPath = `${sourcesPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, body, "utf8");
    fs.renameSync(tempPath, sourcesPath);

    return { kind: present ? "updated" : "created", path: sourcesPath, url };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: present ? "kept" : "failed", path: sourcesPath, url, diagnostic: message };
  }
}

/**
 * Outside a profile, the Launcher's own `template update`. In a profile that
 * command is not run: it updates the sources.list among the Launcher's user
 * files, whatever the profile's configuration says, so it would change the
 * user's Launcher and race with any other profile's update. The profile's
 * sources.list is downloaded instead, then the Launcher is asked to read it.
 */
async function updateTemplates(options: PharoLauncherOptions): Promise<TemplateUpdateResult> {
  const sourcesPath = profileTemplateSourcesFile(configOf(options));
  if (sourcesPath === undefined) {
    const args = commandArgs.updateTemplates();
    const { data: _data, ...normalized } = normalizeLauncherResult(
      args,
      await runLauncherCommand(args, options),
    );
    return normalized;
  }

  const sources = await refreshProfileTemplateSources(sourcesPath, options);
  if (sources.kind === "failed") {
    return {
      ok: false,
      diagnostic:
        "This profile has no template sources: downloading " +
        `${sources.url} failed (${sources.diagnostic})`,
      action: `Update the templates again, or put a sources.list in ${path.dirname(sourcesPath)}.`,
      sources,
    };
  }

  // The Launcher reads the list it was given, which it may not understand.
  const probeArgs = commandArgs.listTemplates({});
  const probe = await runLauncherCommand(probeArgs, options);
  const { data: _data, ...probed } = normalizeLauncherResult(probeArgs, probe);
  return probed.ok
    ? { ...probed, sources }
    : {
        ...probed,
        diagnostic: sentenceWithMessage(
          "Pharo Launcher cannot list the templates of this profile's sources.list",
          launcherMessage(probe),
        ),
        sources,
      };
}

async function listTemplateCategories(
  options: PharoLauncherOptions,
): Promise<TemplateCategoriesResult> {
  const args = commandArgs.listTemplateCategories();
  const { data, defaultCategory, ...normalized } = normalizeLauncherResult(
    args,
    await runLauncherCommand(args, options),
  );
  return normalized.ok
    ? {
        ...normalized,
        data: {
          categories: (data as string[] | undefined) ?? [],
          ...(defaultCategory ? { defaultCategory } : {}),
        },
      }
    : normalized;
}

async function listTemplates(
  input: ListTemplatesInput,
  options: PharoLauncherOptions,
): Promise<TemplateListResult> {
  const args = commandArgs.listTemplates(input);
  const result = await runLauncherCommand(args, options);
  const { data, ...normalized } = normalizeLauncherResult(args, result);
  if (!normalized.ok) {
    if (result.timedOut || launcherRefusal(result) !== "unknown-category") {
      return normalized;
    }
    return hasNoTemplates(configOf(options))
      ? { ...normalized, ...noTemplates() }
      : { ...normalized, failure: { kind: "unknown-category" } };
  }

  const templates = (data as LauncherTemplate[] | undefined) ?? [];
  return {
    ...normalized,
    data: {
      templates:
        input.includeLocal === true ? templates : templates.filter((template) => !template.local),
    },
  };
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
  const config = configOf(options);
  if (!config.profile && input.displayMode !== undefined && input.displayMode !== null) {
    throw new InvalidInputError(
      "displayMode applies in a profile only: Pharo Launcher's own image launch has no display mode",
    );
  }
  const missing = missingImage(input.image, options);
  if (missing) {
    return missing;
  }
  assertLauncherModulePathsFit(config);
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

/**
 * A delete, and once the Launcher deleted the image, the logs of its starts.
 * Never under a running VM: in every mode, an image the reader finds is
 * checked against the process list first.
 */
async function deleteImage(
  input: { image: string },
  options: PharoLauncherOptions,
): Promise<DeleteImageResult> {
  const args = commandArgs.deleteImage(input);
  const info = await imageInfo(input, options);
  if (info.kind === "image") {
    const name = info.image.name;
    if (info.processListFailure !== undefined) {
      return refused(
        { kind: "process-list-failed" as const, diagnostic: info.processListFailure },
        `Cannot tell whether ${name} runs, so it was not deleted: ${info.processListFailure}`,
      );
    }
    const pids = info.image.pids ?? [];
    if (pids.length > 0) {
      return refused(
        { kind: "image-running" as const, pids },
        `Image ${name} runs as ${pids.length === 1 ? "pid" : "pids"} ${pids.join(", ")}`,
        "Stop it, then delete it.",
      );
    }
  } else if (configOf(options).profile) {
    const failure: NoSuchImage = {
      kind: "no-such-image",
      image: input.image,
      ...(info.kind === "not-an-image" ? { notAnImage: info.notAnImage } : {}),
    };
    return refused(
      failure,
      noSuchImageDiagnostic(input.image, info.imagesDir, failure.notAnImage),
    );
  }

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

async function listProcesses(options: PharoLauncherOptions): Promise<ProcessListResult> {
  const args = commandArgs.listProcesses();
  const { data, ...normalized } = normalizeLauncherResult(
    args,
    await runProcessCommand(args, options),
  );
  // The scope names each process as its image: every one has both.
  return normalized.ok
    ? { ...normalized, data: { processes: (data as LauncherProcess[] | undefined) ?? [] } }
    : normalized;
}

async function killProcess(
  input: KillProcessInput,
  options: PharoLauncherOptions,
): Promise<KillProcessResult> {
  const args = commandArgs.killProcess(input);
  const result = await runProcessCommand(args, options);
  const { data: _data, ...normalized } = normalizeLauncherResult(args, result);
  if (result.kill) {
    return { ...normalized, data: result.kill };
  }
  switch (result.processFailure) {
    case "no-match":
      return { ...normalized, failure: { kind: "no-such-process" } };
    case "list-failed":
      return {
        ...normalized,
        failure: { kind: "process-list-failed", diagnostic: normalized.diagnostic ?? result.stderr },
      };
    default:
      return normalized;
  }
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
  const image = requiredImageName(inputObject(input), "image");
  const imagesDir = resolveImagesDirectory(configOf(options)).path;
  const scan = scanImages(imagesDir);
  const entry = findByName(scan.images, image);
  if (!entry) {
    const notAnImage = findByName(scan.notImages, image);
    return notAnImage
      ? { kind: "not-an-image", imagesDir, notAnImage }
      : { kind: "missing", imagesDir };
  }

  const running = await processesRunning([entry], options);
  return {
    kind: "image",
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
    listImages: async (input) => listImages(input ?? {}, resolved),
    imageInfo: async (input) => imageInfo(input, resolved),
    createImage: async (input) => createImage(input, resolved),
    copyImage: async (input) => copyImage(input, resolved),
    startImage: async (input) => startImage(input, resolved),
    deleteImage: async (input) => deleteImage(input, resolved),
    deleteLaunchLogs: async (input) =>
      deleteImageLaunchLogs(config, requiredImageName(inputObject(input), "image")),
    listProcesses: async () => listProcesses(resolved),
    killProcess: async (input) => killProcess(input, resolved),
    listTemplateCategories: async () => listTemplateCategories(resolved),
    listTemplates: async (input) => listTemplates(input ?? {}, resolved),
    updateTemplates: async () => updateTemplates(resolved),
  };
}

