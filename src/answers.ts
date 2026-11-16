/**
 * What each MCP tool answers: plain text, rendered from the library's object
 * the way MCP's own tools answer. A summary sentence, `Warning: …` lines,
 * `key: value` lines, then indented lists.
 *
 * The library keeps its typed objects, which PLexus reads; nothing here reaches
 * it. So every text that names a `pharo_launcher_*` tool is here, and so is
 * every check made before a call: in profile mode, where this server wrote the
 * images directory itself, a check refuses on its own; outside a profile the
 * directory comes from settings that can be wrong, so a name the reader does
 * not find goes to the Launcher, whose answer is the answer.
 */
import fs from "node:fs";
import path from "node:path";
import {
  buildLauncherCommandArgs,
  inputObject,
  optionalString,
  requiredString,
  ToolInputError,
} from "./commandCatalog.js";
import type { PharoLauncherConfig } from "./config.js";
import { profileLabel, type CrossProfileImageCopyResult } from "./crossProfileCopy.js";
import {
  findByName,
  processesOfImages,
  scanImages,
  whatItLacks,
} from "./imageStore.js";
import {
  madeImageFailureText,
  runCommand,
  type CallToolOptions,
  type PharoLauncher,
  type TemplateUpdateResult,
} from "./launcher.js";
import { isLauncherInvocationFailure } from "./launcherCli.js";
import type {
  LauncherCommandResult,
  LauncherImage,
  LauncherProcess,
  MadeImageResult,
  NotAnImage,
} from "./models.js";
import { isPidAlive } from "./processTools.js";
import { sentenceWithMessage } from "./resultNormalizer.js";

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/** What one call has to hand: the launcher it opened, and the scope it runs in. */
export interface AnswerContext {
  launcher: PharoLauncher;
  config: PharoLauncherConfig;
  options: CallToolOptions;
  /** Where this server reads images, as it resolves the path. */
  imagesDir: string;
}

type Answer = (context: AnswerContext, input: Record<string, unknown>) => Promise<ToolResult>;

const outputTailLines = 20;
const defaultProcessExitTimeoutMs = 10_000;
const defaultProcessExitPollMs = 200;

// --- How an answer reads -------------------------------------------------

function textResult(lines: ReadonlyArray<string | undefined | false>, isError = false): ToolResult {
  const text = lines.filter((line): line is string => typeof line === "string").join("\n");
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError } : {}),
  };
}

function failure(...lines: ReadonlyArray<string | undefined | false>): ToolResult {
  return textResult(lines, true);
}

/**
 * A value that carries whitespace, quoted so that where it ends is never a
 * guess, `"` and `\` escaped: `MCPTool>>inlineValueTextFor:`.
 */
export function inlineValue(value: string): string {
  return /\s/.test(value) ? `"${value.replace(/["\\]/g, (char) => `\\${char}`)}"` : value;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

/** A sentence's end: no second period after a message that ends with one. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return trimmed.endsWith(".") ? trimmed : `${trimmed}.`;
}

/** A message set inside a sentence, in parentheses or before a semicolon. */
function clause(text: string): string {
  return text.trim().replace(/\.$/, "");
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** `A, B or C`. */
function alternatives(items: readonly string[]): string {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
}

/** The last lines a process wrote, under the label PLexus uses for them. */
function outputTail(label: string, text: string | undefined): string[] {
  const trimmed = text?.trim();
  if (!trimmed) {
    return [];
  }

  const lines = trimmed.split(/\r?\n/).slice(-outputTailLines);
  return [label, ...lines.map((line) => (line.trimEnd() ? `  ${line.trimEnd()}` : ""))];
}

function outputTails(output: { stdout?: string; stderr?: string } | undefined): string[] {
  return [
    ...outputTail("Its output ends with:", output?.stdout),
    ...outputTail("Its error output ends with:", output?.stderr),
  ];
}

interface Entry {
  name: string;
  attributes: Array<[string, string | undefined]>;
}

/**
 * A list: its label, naming the attributes every entry has with the same
 * value when there are two entries or more, then one entry per line, its name
 * first. `MCPTool>>entriesTextOn:for:labelled:indent:`.
 */
function entries(label: string, list: readonly Entry[], shareable: readonly string[] = []): string[] {
  if (list.length === 0) {
    return [];
  }

  const shared =
    list.length < 2
      ? []
      : shareable.filter((key) => {
          const first = list[0]!.attributes.find(([name]) => name === key)?.[1];
          return (
            first !== undefined &&
            list.every((entry) => entry.attributes.find(([name]) => name === key)?.[1] === first)
          );
        });
  const pair = ([key, value]: [string, string]) => `${key}=${inlineValue(value)}`;
  const sharedPairs = shared.map((key) =>
    pair([key, list[0]!.attributes.find(([name]) => name === key)![1]!]),
  );

  return [
    sharedPairs.length > 0 ? `${label} (each ${sharedPairs.join(" ")}):` : `${label}:`,
    ...list.map((entry) =>
      [
        `  ${inlineValue(entry.name)}`,
        ...entry.attributes
          .filter(
            (attribute): attribute is [string, string] =>
              attribute[1] !== undefined && !shared.includes(attribute[0]),
          )
          .map(pair),
      ].join(" "),
    ),
  ];
}

// --- Shared texts -----------------------------------------------------

function callSeconds(options: CallToolOptions): number {
  return Math.round((options.timeoutMs ?? 30_000) / 1000);
}

/**
 * A Launcher command that failed: past the call's timeout, never started, or
 * refused, in its own words.
 */
function launcherFailureText(
  operation: string,
  result: LauncherCommandResult,
  context: AnswerContext,
): string {
  if (result.command.timedOut) {
    return `Pharo Launcher did not finish ${operation} within ${callSeconds(context.options)} s.`;
  }
  if (isLauncherInvocationFailure(result.diagnostic)) {
    return result.diagnostic!;
  }

  return sentenceWithMessage(
    `Pharo Launcher could not ${operation}`,
    result.diagnostic ??
      (result.command.signal
        ? `it was killed by signal ${result.command.signal}`
        : `it exited with ${result.command.exitCode ?? "no exit code"}`),
  );
}

/** A sentence after a message, on a line of its own when the message has several. */
function followedBy(text: string, after: string): string {
  return `${text}${text.includes("\n") ? "\n" : " "}${after}`;
}

/** The text `image_info`, `image_start`, `image_delete` and a copy's source share. */
function noImageText(imageName: string, imagesDir: string, notAnImage?: NotAnImage): string {
  return notAnImage
    ? `There is no image ${inlineValue(imageName)} in ${imagesDir}: its directory ${whatItLacks(notAnImage)}.`
    : `There is no image ${inlineValue(imageName)} in ${imagesDir}. pharo_launcher_image_list says which images there are.`;
}

function takenNameText(image: { name: string }, imagesDir: string): string {
  return (
    `There is already an image ${inlineValue(image.name)} in ${imagesDir}. ` +
    "Pick another name, or delete it first with pharo_launcher_image_delete."
  );
}

function noTemplatesYet(config: PharoLauncherConfig): boolean {
  if (!config.profile) {
    return false;
  }

  try {
    return (
      fs.readFileSync(path.join(config.profile.templateSourcesDir, "sources.list"), "utf8").trim()
        .length === 0
    );
  } catch {
    return true;
  }
}

const noTemplatesYetText = "There are no templates yet: call pharo_launcher_template_update first.";

function rawOutput(result: LauncherCommandResult): string {
  return `${result.raw?.stdout ?? ""}\n${result.raw?.stderr ?? ""}\n${result.diagnostic ?? ""}`;
}

function timedOutWarning(result: LauncherCommandResult, context: AnswerContext): string | undefined {
  return result.command.timedOut
    ? `Warning: Pharo Launcher needed more than the call's ${callSeconds(context.options)} s, but finished.`
    : undefined;
}

/**
 * A create or copy that did not make its image. `operation` is what it was
 * asked (`create image X`), `said` what the Launcher said it did (`created
 * X`), and `newImageName` the image it made, names written as answers write
 * them.
 */
function madeImageFailure(
  operation: string,
  said: string,
  newImageName: string,
  result: MadeImageResult,
  context: AnswerContext,
): ToolResult {
  // Exited 0, but never listed or never opened.
  if (result.failure) {
    return failure(madeImageFailureText(result.failure, said, newImageName));
  }

  const output = rawOutput(result);
  if (/not found, please enter a correct category name/i.test(output)) {
    return noTemplatesYet(context.config)
      ? failure(noTemplatesYetText)
      : failure(
          followedBy(
            launcherFailureText(operation, result, context),
            "pharo_launcher_template_category_list says which categories there are.",
          ),
        );
  }
  if (/not found, please enter a correct (?:short )?template name/i.test(output)) {
    return failure(
      followedBy(
        launcherFailureText(operation, result, context),
        "pharo_launcher_template_list says which templates there are.",
      ),
    );
  }

  return failure(launcherFailureText(operation, result, context));
}

// --- The images ---------------------------------------------------------

/** The Pharo version as Pharo says it: "140" is 14.0 and "61" is 6.1; anything else as it is. */
export function pharoVersionText(raw: string | undefined): string | undefined {
  return raw !== undefined && /^\d{2,3}$/.test(raw) ? `${raw.slice(0, -1)}.${raw.slice(-1)}` : raw;
}

function imageAttributes(image: LauncherImage): Array<[string, string | undefined]> {
  return [
    ["pharo", pharoVersionText(image.pharoVersion)],
    ["architecture", image.architecture],
    ["template", image.template?.name],
  ];
}

const answerConfig: Answer = async (context) => {
  const report = context.launcher.describeConfig();
  const launcherDir = path.resolve(report.launcherDir.path);
  const imagesDir = report.imagesDir;
  const profile = report.profile;
  let first: string;
  if (!report.discovery.selected.usable) {
    const candidates = [
      ...new Set(report.discovery.candidates.map((candidate) => path.resolve(candidate.launcherDir.path))),
    ];
    first =
      `No usable Pharo Launcher in ${alternatives(candidates)}. ` +
      "Install it, or set PHARO_LAUNCHER_DIR to where it is.";
  } else if (profile) {
    first = `Pharo Launcher ${launcherDir}, profile ${inlineValue(profile.name)}.`;
  } else if (imagesDir.source === "default" && imagesDir.settingsFile && !fs.existsSync(imagesDir.settingsFile)) {
    first = `Pharo Launcher ${launcherDir}, with its default settings: ${imagesDir.settingsFile} does not exist yet.`;
  } else if (imagesDir.source === "default") {
    first = `Pharo Launcher ${launcherDir}, with the settings in ${imagesDir.settingsFile}, which name no images directory.`;
  } else {
    first = `Pharo Launcher ${launcherDir}, with the settings in ${imagesDir.settingsFile}.`;
  }

  return textResult([
    first,
    profile && `stateRoot: ${path.resolve(profile.stateRoot.path)}`,
    `images: ${imagesDir.path}`,
  ]);
};

const answerImageList: Answer = async (context, input) => {
  const nameFilter = optionalString(input, "nameFilter");
  const list = await context.launcher.listImages(nameFilter === undefined ? {} : { nameFilter });
  const scan = scanImages(list.imagesDir);
  const dir = list.imagesDir;
  const total = scan.images.length;
  const shown = list.images.length;
  const filter = nameFilter === undefined ? undefined : inlineValue(nameFilter);
  const summary = !scan.exists
    ? `No images in ${dir}, which does not exist.`
    : total === 0
      ? `No images in ${dir}.`
      : filter === undefined
        ? `${total} ${plural(total, "image")} in ${dir}.`
        : `${shown} of ${total} ${plural(total, "image")} in ${dir} match ${filter}.`;

  return textResult([
    summary,
    ...list.notImages.map(
      (directory) =>
        `Warning: ${inlineValue(directory.name)} is not an image: ${directory.directory} ${whatItLacks(directory)}.`,
    ),
    list.processListFailure !== undefined &&
      `Warning: cannot tell which images run: ${sentence(list.processListFailure)}`,
    ...entries(
      "images",
      list.images.map((image) => ({
        name: image.name,
        attributes: [
          ...imageAttributes(image),
          ["pids", image.pids && image.pids.length > 0 ? image.pids.join(",") : undefined],
        ],
      })),
      ["pharo", "architecture", "template"],
    ),
  ]);
};

function runsText(image: LauncherImage): string {
  const pids = image.pids ?? [];
  return pids.length === 1 ? `runs as pid ${pids[0]}` : `runs as pids ${pids.join(", ")}`;
}

const answerImageInfo: Answer = async (context, input) => {
  const imageName = requiredString(input, "imageName");
  const info = await context.launcher.imageInfo({ imageName });
  if (!info.found) {
    return failure(noImageText(imageName, info.imagesDir, info.notAnImage));
  }

  const image = info.image;
  const name = inlineValue(image.name);
  const first =
    info.processListFailure !== undefined
      ? `Image ${name}.`
      : (image.pids?.length ?? 0) === 0
        ? `Image ${name} is not running.`
        : `Image ${name} ${runsText(image)}.`;

  return textResult([
    first,
    info.processListFailure !== undefined &&
      `Warning: cannot tell whether it runs: ${sentence(info.processListFailure)}`,
    `path: ${image.imagePath}`,
    image.pharoVersion && `pharo: ${pharoVersionText(image.pharoVersion)}`,
    image.architecture && `architecture: ${image.architecture}`,
    image.template && `template: ${image.template.name}`,
    image.template?.url && `templateUrl: ${image.template.url}`,
    `modified: ${image.modified}`,
  ]);
};

function madeImageLines(image: LauncherImage | undefined, withVersions: boolean): string[] {
  if (!image) {
    return [];
  }

  return [
    `path: ${image.imagePath}`,
    ...(withVersions
      ? [
          image.pharoVersion && `pharo: ${pharoVersionText(image.pharoVersion)}`,
          image.architecture && `architecture: ${image.architecture}`,
        ].filter((line): line is string => Boolean(line))
      : []),
  ];
}

const answerImageCreate: Answer = async (context, input) => {
  buildLauncherCommandArgs("pharo_launcher_image_create", input);
  const newImageName = requiredString(input, "newImageName");
  const templateName = optionalString(input, "templateName");
  if (context.config.profile) {
    const taken = findByName(scanImages(context.imagesDir).images, newImageName);
    if (taken) {
      return failure(takenNameText(taken, context.imagesDir));
    }
  }

  const result = await context.launcher.createImage(
    input as unknown as Parameters<PharoLauncher["createImage"]>[0],
  );
  if (!result.ok) {
    const name = inlineValue(newImageName);
    return madeImageFailure(`create image ${name}`, `created ${name}`, name, result, context);
  }

  const image = (result.data as { image?: LauncherImage } | undefined)?.image;
  const template = image?.template?.name ?? templateName;
  const name = inlineValue(image?.name ?? newImageName);
  return textResult([
    template ? `Created image ${name} from template ${template}.` : `Created image ${name}.`,
    timedOutWarning(result, context),
    ...madeImageLines(image, true),
  ]);
};

const answerImageCopy: Answer = async (context, input) => {
  buildLauncherCommandArgs("pharo_launcher_image_copy", input);
  const imageName = requiredString(input, "imageName");
  const newImageName = requiredString(input, "newImageName");
  if (context.config.profile) {
    const scan = scanImages(context.imagesDir);
    if (!findByName(scan.images, imageName)) {
      return failure(noImageText(imageName, context.imagesDir, findByName(scan.notImages, imageName)));
    }
    const taken = findByName(scan.images, newImageName);
    if (taken) {
      return failure(takenNameText(taken, context.imagesDir));
    }
  }

  const result = await context.launcher.copyImage({ imageName, newImageName });
  if (!result.ok) {
    const copied = `${inlineValue(imageName)} to ${inlineValue(newImageName)}`;
    return madeImageFailure(
      `copy image ${copied}`,
      `copied ${copied}`,
      inlineValue(newImageName),
      result,
      context,
    );
  }

  const image = (result.data as { image?: LauncherImage } | undefined)?.image;
  return textResult([
    `Copied image ${inlineValue(imageName)} to ${inlineValue(image?.name ?? newImageName)}.`,
    timedOutWarning(result, context),
    ...madeImageLines(image, false),
  ]);
};

const answerImageDelete: Answer = async (context, input) => {
  buildLauncherCommandArgs("pharo_launcher_image_delete", input);
  const imageName = requiredString(input, "imageName");
  const info = await context.launcher.imageInfo({ imageName });
  let name = inlineValue(imageName);
  if (info.found) {
    name = inlineValue(info.image.name);
    if (info.processListFailure !== undefined) {
      return failure(
        `Cannot tell whether ${name} runs (${clause(info.processListFailure)}), so it was not deleted.`,
      );
    }
    if ((info.image.pids?.length ?? 0) > 0) {
      return failure(
        `Image ${name} ${runsText(info.image)}: stop it with pharo_launcher_process_kill, then delete it.`,
      );
    }
  } else if (context.config.profile) {
    return failure(noImageText(imageName, info.imagesDir, info.notAnImage));
  }

  const result = await context.launcher.deleteImage({ imageName });
  return result.ok
    ? textResult([`Deleted image ${name}.`])
    : failure(launcherFailureText(`delete image ${name}`, result, context));
};

/** How a start the call waited for ended: past the call's time, by a signal, or with an exit code. */
function endedText(name: string, command: LauncherCommandResult["command"], seconds: number): string {
  if (command.timedOut) {
    return (
      `${name} did not quit within ${seconds} s and was stopped: a start that is not ` +
      "detached lasts as long as the call. Pass detached: true to leave it running."
    );
  }
  return command.signal
    ? `${name} was killed by signal ${command.signal}.`
    : `${name} quit with exit code ${command.exitCode}.`;
}

function endedWell(command: LauncherCommandResult["command"]): boolean {
  return !command.timedOut && !command.signal && command.exitCode === 0;
}

const answerImageStart: Answer = async (context, input) => {
  buildLauncherCommandArgs("pharo_launcher_image_start", input);
  const imageName = requiredString(input, "imageName");
  const detached = input.detached === true;
  const hasScript = input.script !== undefined;
  const scan = scanImages(context.imagesDir);
  const entry = findByName(scan.images, imageName);
  if (context.config.profile && !entry) {
    return failure(noImageText(imageName, context.imagesDir, findByName(scan.notImages, imageName)));
  }

  const result = await context.launcher.startImage(
    input as unknown as Parameters<PharoLauncher["startImage"]>[0],
  );
  const name = inlineValue(entry?.name ?? imageName);
  // What ran, once something ran: none for a launch refused before it.
  const launch = result.launch;
  const logs = launch?.logs && `logs: ${launch.logs.stdout} and ${launch.logs.stderr}`;

  if (launch?.by === "vm") {
    const mode = launch.displayMode === "interactive" ? "with its window" : "headless";
    const downloaded = launch.vmUpdated ? `Downloaded VM ${launch.vmId} for it first.` : undefined;
    // Pharo 13 prints its usage and exits 0; Pharo 14 prints it and exits 1.
    const nothingToRun =
      launch.displayMode === "headless" &&
      !hasScript &&
      "A headless image with no script has nothing to run and quits: " +
        "pass a script, or displayMode: interactive.";
    if (detached) {
      return textResult([`Started ${name} ${mode}, detached, as pid ${launch.pid}.`, downloaded, nothingToRun, logs]);
    }
    return textResult(
      [
        endedText(name, result.command, callSeconds(context.options)),
        downloaded,
        nothingToRun,
        ...outputTails(launch.output),
      ],
      !endedWell(result.command),
    );
  }

  if (launch?.by === "launcher" && detached && result.ok) {
    return textResult([
      `Pharo Launcher is starting ${name} (its own pid ${launch.pid}); ` +
        "pharo_launcher_process_list shows the image's VM once it runs.",
      logs,
    ]);
  }

  // Outside a profile the Launcher's exit code is the image's only when the
  // reader knows the image; a timeout or a signal ended the Launcher.
  if (launch?.by === "launcher" && !detached && entry && !result.command.timedOut && !result.command.signal) {
    return textResult(
      [`${name} quit with exit code ${result.command.exitCode}.`, ...outputTails(result.raw)],
      result.command.exitCode !== 0,
    );
  }

  if (result.ok) {
    return textResult([`${name} quit with exit code 0.`, ...outputTails(result.raw)]);
  }
  // A launch the library refused says why itself; the Launcher's refusal is quoted.
  return failure(
    launch === undefined && result.diagnostic
      ? result.diagnostic
      : launcherFailureText(`start image ${name}`, result, context),
  );
};

// --- Between profiles ---------------------------------------------------------

function verificationClause(result: CrossProfileImageCopyResult): string {
  const diagnostic = result.verification?.diagnostic ?? result.diagnostic ?? "";
  const text = clause(diagnostic);
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * What to give instead of a profile path that does not exist. config prints
 * this server's own stateRoot only, so another's is said by what it holds.
 */
function profilePathAdvice(result: CrossProfileImageCopyResult): string {
  const missing = result.missingProfilePaths ?? [];
  const override = (each: (typeof missing)[number]): boolean =>
    each.given && each.field !== "stateRoot" && result[each.profile].stateRoot !== undefined;
  return [
    missing.some((each) => !override(each)) &&
      " A profile's stateRoot is the directory that holds its images/ directory; " +
        "pharo_launcher_config prints this server's own.",
    missing.some(override) &&
      " Leave out every path but stateRoot unless the profile keeps it elsewhere: " +
        "each defaults to its place inside stateRoot.",
  ]
    .filter(Boolean)
    .join("");
}

const answerCopyBetweenProfiles: Answer = async (context, input) => {
  const result = context.launcher.copyImageBetweenProfiles(input);
  const source = inlineValue(result.sourceImageName);
  const destination = inlineValue(result.destinationImageName);
  const from = profileLabel(result.sourceProfile);
  const to = profileLabel(result.destinationProfile);
  const renamed = result.destinationImageName === result.sourceImageName ? "" : ` as ${destination}`;
  if (result.ok) {
    return textResult([
      `Copied image ${source} from ${from} to ${to}${renamed}.`,
      `path: ${result.destinationImage.imageFile.path}`,
    ]);
  }

  const sourceDirectory = result.sourceImage.directory;
  switch (result.failure) {
    case "profile-path-missing":
      return failure(`Cannot copy image ${source}: ${result.diagnostic}${profilePathAdvice(result)}`);
    case "source-missing":
    case "source-image-missing":
    case "source-metadata-missing":
      return failure(
        `Cannot copy image ${source}: ${sourceDirectory} is not a Launcher image ` +
          `(${clause(result.diagnostic ?? "")}).`,
      );
    case "destination-exists":
      return failure(
        `Cannot copy image ${source} to ${result.destinationImage.directory}: that path ` +
          "already exists, and a copy never replaces it. Pick another destinationImageName, " +
          "or remove it first.",
      );
    case "preflight":
      return failure(
        `Cannot copy image ${source}: the copy did not check out (${verificationClause(result)}), ` +
          "so it was removed.",
      );
    case "post-move":
      return failure(
        `Copied image ${source}, but the copy at ${result.destinationImage.directory} is not a ` +
          `Launcher image (${verificationClause(result)}). It was left in place; delete it ` +
          "before copying again.",
      );
    case "exception": {
      const left = result.cleanup.temporaryDirectory;
      return failure(
        sentenceWithMessage(
          `Cannot copy image ${source} to ${to}`,
          result.error ?? result.diagnostic ?? "it failed",
        ),
        left !== undefined && fs.existsSync(left) && `It left ${left} behind.`,
      );
    }
    default:
      return failure(result.message ?? result.diagnostic ?? `Cannot copy image ${source}.`);
  }
};

// --- The processes -----------------------------------------------------------

type ScopedProcesses = { processes: LauncherProcess[] } | { failure: string };

/**
 * The processes running an image of the images directory this server reads,
 * in every mode: in profile mode the library's list already is; outside a
 * profile it holds every Pharo VM, and the adapter keeps those.
 */
async function scopedProcesses(context: AnswerContext): Promise<ScopedProcesses> {
  const result = await context.launcher.listProcesses();
  if (!result.ok) {
    return { failure: result.diagnostic ?? "the process list failed" };
  }

  const processes = result.data ?? [];
  return {
    processes: context.config.profile
      ? processes
      : processesOfImages(
          scanImages(context.imagesDir).images,
          processes,
          context.options.nativeProcess?.platform,
        ),
  };
}

function listFailureText(reason: string): string {
  return sentenceWithMessage("Could not list processes", reason);
}

const answerProcessList: Answer = async (context) => {
  const scoped = await scopedProcesses(context);
  if ("failure" in scoped) {
    return failure(listFailureText(scoped.failure));
  }

  const count = scoped.processes.length;
  const dir = context.imagesDir;
  return textResult([
    count === 0
      ? `No process runs an image in ${dir}.`
      : count === 1
        ? `1 process runs an image in ${dir}.`
        : `${count} processes run images in ${dir}.`,
    ...entries(
      "processes",
      scoped.processes.map((process) => ({
        name: process.imageName ?? "",
        attributes: [["pid", String(process.pid)]],
      })),
    ),
  ]);
};

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Waits for each pid to exit, polling, as PLexus's stop waits: a delete
 * right after a kill would otherwise meet a VM still exiting. The pids still
 * there when the time is up.
 */
async function stillRunning(pids: readonly number[], options: CallToolOptions): Promise<number[]> {
  const isAlive = options.nativeProcess?.isAlive ?? isPidAlive;
  const timeoutMs = options.processExitTimeoutMs ?? defaultProcessExitTimeoutMs;
  const pollMs = options.processExitPollMs ?? defaultProcessExitPollMs;
  const wait = options.sleep ?? sleep;
  let alive = pids.filter(isAlive);
  for (let waited = 0; alive.length > 0 && waited < timeoutMs; waited += pollMs) {
    await wait(Math.min(pollMs, timeoutMs - waited));
    alive = alive.filter(isAlive);
  }

  return alive;
}

/** What a kill that failed said, without the pid it already names. */
function killMessage(pid: number, result: LauncherCommandResult): string {
  const diagnostic = result.diagnostic ?? `it exited with ${result.command.exitCode}`;
  return clause(diagnostic.replace(new RegExp(`^Could not kill pid ${pid}: `), ""));
}

const answerProcessKill: Answer = async (context, input) => {
  buildLauncherCommandArgs("pharo_launcher_process_kill", input);
  const pidInput = input.pid;
  const imageName = optionalString(input, "imageName");
  let pid: number | undefined;
  if (pidInput !== undefined) {
    pid = Number(pidInput);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !/^\d+$/.test(String(pidInput).trim())) {
      throw new ToolInputError("pid must be a process id, a whole number");
    }
  }

  const scoped = await scopedProcesses(context);
  if ("failure" in scoped) {
    return failure(listFailureText(scoped.failure));
  }

  const image =
    imageName === undefined ? undefined : findByName(scanImages(context.imagesDir).images, imageName);
  const targets =
    pid !== undefined
      ? scoped.processes.filter((process) => process.pid === pid)
      : image
        ? scoped.processes.filter((process) => process.imageName === image.name)
        : [];
  if (targets.length === 0) {
    return failure(
      pid !== undefined
        ? `No process of an image in ${context.imagesDir} has pid ${pid}. pharo_launcher_process_list says which run.`
        : `No process runs image ${inlineValue(image?.name ?? imageName!)}. pharo_launcher_process_list says which run.`,
    );
  }

  // One pid per call: outside a profile the library sees every Pharo VM, and
  // would match a name among all of them.
  const isAlive = context.options.nativeProcess?.isAlive ?? isPidAlive;
  const killed: number[] = [];
  const failures: string[] = [];
  for (const target of targets) {
    const result = await context.launcher.killProcess({ pid: target.pid });
    if (result.ok || !isAlive(target.pid)) {
      killed.push(target.pid);
    } else {
      failures.push(`could not kill pid ${target.pid}: ${killMessage(target.pid, result)}`);
    }
  }

  const seconds = Math.round(
    (context.options.processExitTimeoutMs ?? defaultProcessExitTimeoutMs) / 1000,
  );
  const remaining = await stillRunning(killed, context.options);
  const stopped = killed.filter((each) => !remaining.includes(each));
  failures.push(...remaining.map((each) => `pid ${each} still runs ${seconds} s after being killed`));

  const name = inlineValue(targets[0]!.imageName ?? "");
  const killedClause =
    stopped.length === 0
      ? undefined
      : `Killed ${name} (${plural(stopped.length, "pid")} ${stopped.join(", ")})`;
  const clauses = [killedClause, ...failures].filter((each): each is string => Boolean(each));
  const text = `${capitalized(clauses.join("; "))}.`;
  return failures.length === 0 ? textResult([text]) : failure(text);
};

// --- The templates ------------------------------------------------------------

const answerTemplateCategoryList: Answer = async (context) => {
  const result = await context.launcher.listTemplateCategories();
  if (!result.ok) {
    return failure(launcherFailureText("list template categories", result, context));
  }

  const categories = result.data ?? [];
  const count = categories.length;
  if (count === 0) {
    return textResult(["No template categories."]);
  }

  return textResult([
    result.defaultCategory
      ? `${count} template ${plural(count, "category", "categories")}; ${result.defaultCategory} is the default.`
      : `${count} template ${plural(count, "category", "categories")}.`,
    "categories:",
    ...categories.map((category) => `  ${category}`),
  ]);
};

const answerTemplateList: Answer = async (context, input) => {
  const templateCategory = optionalString(input, "templateCategory");
  // What the Launcher lists, its copies of downloaded templates and the
  // user's own included.
  const result = await context.launcher.listTemplates({
    ...(templateCategory === undefined ? {} : { templateCategory }),
    includeLocal: true,
  });
  if (!result.ok) {
    const notFound = /Image template category '(.*?)' not found/.exec(rawOutput(result));
    if (notFound && !result.command.timedOut) {
      return noTemplatesYet(context.config)
        ? failure(noTemplatesYetText)
        : failure(
            `There is no template category ${notFound[1]}. ` +
              "pharo_launcher_template_category_list lists them.",
          );
    }

    return failure(launcherFailureText("list templates", result, context));
  }

  const names = (result.data ?? []).map((template) => template.name ?? "");
  const where = templateCategory ?? "the default category";
  if (names.length === 0) {
    return textResult([`No templates in ${where}.`]);
  }

  return textResult([
    `${names.length} ${plural(names.length, "template")} in ${where}.`,
    "templates:",
    ...names.map((name) => `  ${name}`),
  ]);
};

const answerTemplateUpdate: Answer = async (context) => {
  const result: TemplateUpdateResult = await context.launcher.updateTemplates();
  const bootstrap = result.templateSourcesBootstrap;
  if (result.ok) {
    return textResult([
      bootstrap?.action === "created"
        ? `Refreshed the template list, and downloaded this profile's sources.list from ${bootstrap.url}.`
        : "Refreshed the template list.",
    ]);
  }

  if (bootstrap?.action === "failed") {
    return failure(
      "Refreshed the template list, but this profile still has no template sources: " +
        `downloading ${bootstrap.url} failed (${clause(bootstrap.error ?? "")}). ` +
        "Call pharo_launcher_template_update again, or put a sources.list in " +
        `${path.dirname(bootstrap.path ?? "")}.`,
    );
  }
  if (result.templateSourcesProbe && !result.templateSourcesProbe.ok && result.diagnostic) {
    return failure(result.diagnostic);
  }

  return failure(launcherFailureText("refresh the template list", result, context));
};

/** The answer of each tool, by name: the table PLexus mirrors with functions. */
export const toolAnswers: Readonly<Record<string, Answer>> = {
  pharo_launcher_config: answerConfig,
  pharo_launcher_image_copy_between_profiles: answerCopyBetweenProfiles,
  pharo_launcher_image_copy: answerImageCopy,
  pharo_launcher_image_create: answerImageCreate,
  pharo_launcher_image_delete: answerImageDelete,
  pharo_launcher_image_info: answerImageInfo,
  pharo_launcher_image_list: answerImageList,
  pharo_launcher_image_start: answerImageStart,
  pharo_launcher_process_kill: answerProcessKill,
  pharo_launcher_process_list: answerProcessList,
  pharo_launcher_template_category_list: answerTemplateCategoryList,
  pharo_launcher_template_list: answerTemplateList,
  pharo_launcher_template_update: answerTemplateUpdate,
};

/**
 * Arguments an earlier release took and this one does not: an older caller
 * still passes them, and they now change nothing, so they are dropped
 * rather than refused.
 */
const retiredArguments = new Set([
  "brief",
  "confirm",
  "delimiter",
  "force",
  "format",
  "includeRaw",
  "noLaunch",
  "rowMode",
]);

/**
 * Only the arguments a tool's schema names. One it never took is refused,
 * as MCP and PLexus refuse it; one an earlier release took is dropped.
 */
export function toolArguments(
  schema: { properties?: Record<string, unknown> },
  argumentsValue: unknown,
): Record<string, unknown> {
  const given = inputObject(argumentsValue);
  const named = new Set(Object.keys(schema.properties ?? {}));
  const unknown = Object.keys(given).filter((key) => !named.has(key) && !retiredArguments.has(key));
  if (unknown.length > 0) {
    throw new ToolInputError(`${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not accepted here`);
  }
  return Object.fromEntries(
    Object.keys(schema.properties ?? {})
      .filter((key) => given[key] !== undefined)
      .map((key) => [key, given[key]]),
  );
}

/** `Invalid arguments for <tool>. <the error.> It takes <its arguments>.` */
export function invalidArgumentsText(
  toolName: string,
  schema: { properties?: Record<string, unknown> },
  error: ToolInputError,
): string {
  const properties = Object.keys(schema.properties ?? {});
  return (
    `Invalid arguments for ${toolName}. ${sentence(error.message)} ` +
    (properties.length === 0 ? "It takes no arguments." : `It takes ${properties.join(", ")}.`)
  );
}

export function unknownToolText(toolName: string): string {
  return `There is no tool ${toolName}.`;
}

export { failure as failureResult };
