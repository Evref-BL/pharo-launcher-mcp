/**
 * What this package knows how to do, as functions.
 *
 * The tool list was the surface for as long as the only caller reached it over
 * a protocol. It does not: PLexus is a Node program that already depends on
 * this package, and no agent subscribes to these names — they reach the
 * launcher through PLexus's own scoped tools. So the functions are the
 * surface, and `server.ts` is an adapter that maps thirteen names onto them.
 *
 * Scope is a config, not a process. `loadPharoLauncherConfig` takes an
 * environment object, so a caller that needs a profile passes one rather than
 * spawning a process to hold `PHARO_LAUNCHER_*` variables.
 */
import fs from "node:fs";
import path from "node:path";
import {
  buildLauncherCommandArgs,
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
  runNativeProcessTool,
  shouldUseNativeProcessTool,
} from "./processTools.js";
import { repairCopiedImageMetadata } from "./imageMetadata.js";
import { normalizeLauncherResult } from "./resultNormalizer.js";
import type { LauncherCliResult } from "./launcherCli.js";
import { copyImageBetweenProfiles } from "./crossProfileCopy.js";
import type {
  LauncherCommandResult,
  LauncherImage,
  LauncherProcess,
  LauncherTemplate,
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
}

/** The name the MCP adapter still uses for the same options. */
export type CallToolOptions = PharoLauncherOptions;

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

function imagesFromData(data: unknown): LauncherImage[] {
  if (Array.isArray(data)) {
    return data.filter(
      (item): item is LauncherImage =>
        typeof item === "object" && item !== null,
    );
  }

  if (typeof data === "object" && data !== null) {
    return [data as LauncherImage];
  }

  return [];
}

function namedImage(data: unknown, imageName: string): LauncherImage | undefined {
  return imagesFromData(data).find((image) => image.name === imageName);
}

interface ImageVerification {
  ok: boolean;
  targetImageName: string;
  attempts: number;
  elapsedMs: number;
  listedImage?: LauncherImage;
  inspectedImage?: LauncherImage;
  diagnostic?: string;
  list?: LauncherCommandResult;
  info?: LauncherCommandResult;
}

interface ImageVerificationAttempt {
  listedImage?: LauncherImage;
  inspectedImage?: LauncherImage;
  list: LauncherCommandResult;
  info?: LauncherCommandResult;
  diagnostic?: string;
}

async function inspectImageVerificationAttempt(
  runner: LauncherCliRunner,
  newImageName: string,
  operationLabel: "Copied" | "Created",
  options: PharoLauncherOptions,
): Promise<ImageVerificationAttempt> {
  const listArgs = buildLauncherCommandArgs("pharo_launcher_image_list", {
    nameFilter: newImageName,
    format: "ston",
  });
  const listResult = await runLauncherToolCommand(
    runner,
    listArgs ?? [],
    options,
  );
  const normalizedList = normalizeToolResult(
    "pharo_launcher_image_list",
    listArgs ?? [],
    listResult,
    options,
  );
  const listedImage = normalizedList.ok
    ? namedImage(normalizedList.data, newImageName)
    : undefined;

  if (!normalizedList.ok || !listedImage) {
    return {
      list: normalizedList,
      diagnostic: normalizedList.ok
        ? `${operationLabel} image did not appear in image list.`
        : `Image list failed while verifying ${operationLabel.toLowerCase()} image.`,
    };
  }

  const infoArgs = buildLauncherCommandArgs("pharo_launcher_image_info", {
    imageName: newImageName,
    format: "ston",
  });
  const infoResult = await runLauncherToolCommand(
    runner,
    infoArgs ?? [],
    options,
  );
  const normalizedInfo = normalizeToolResult(
    "pharo_launcher_image_info",
    infoArgs ?? [],
    infoResult,
    options,
  );
  const inspectedImage = normalizedInfo.ok
    ? namedImage(normalizedInfo.data, newImageName)
    : undefined;

  return {
    listedImage,
    ...(inspectedImage ? { inspectedImage } : {}),
    list: normalizedList,
    info: normalizedInfo,
    // Only a failed attempt has something to report. The success path used to
    // carry "image info failed" as well, unread by its one caller and wrong
    // for anyone who read it next.
    ...(inspectedImage
      ? {}
      : {
          diagnostic: normalizedInfo.ok
            ? `${operationLabel} image appeared in image list but could not be inspected.`
            : `${operationLabel} image appeared in image list, but image info failed.`,
        }),
  };
}

async function verifyImage(
  runner: LauncherCliRunner,
  newImageName: string,
  operationLabel: "Copied" | "Created",
  options: PharoLauncherOptions,
): Promise<ImageVerification> {
  const startedAt = Date.now();
  const deadline =
    startedAt +
    (options.imageCopyVerificationTimeoutMs ?? imageCopyVerificationTimeoutMs);
  const pollMs =
    options.imageCopyVerificationPollMs ?? imageCopyVerificationPollMs;
  const wait = options.sleep ?? sleep;
  let attempts = 0;
  let lastList: LauncherCommandResult | undefined;
  let lastInfo: LauncherCommandResult | undefined;
  let diagnostic = `${operationLabel} image did not appear in image list.`;

  while (true) {
    attempts += 1;

    const attempt = await inspectImageVerificationAttempt(
      runner,
      newImageName,
      operationLabel,
      options,
    );
    lastList = attempt.list;
    lastInfo = attempt.info;

    if (attempt.listedImage && attempt.inspectedImage) {
      return {
        ok: true,
        targetImageName: newImageName,
        attempts,
        elapsedMs: Date.now() - startedAt,
        listedImage: attempt.listedImage,
        inspectedImage: attempt.inspectedImage,
        list: attempt.list,
        ...(attempt.info ? { info: attempt.info } : {}),
      };
    }

    diagnostic = attempt.diagnostic ?? diagnostic;

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }

    await wait(Math.min(pollMs, remainingMs));
  }

  return {
    ok: false,
    targetImageName: newImageName,
    attempts,
    elapsedMs: Date.now() - startedAt,
    diagnostic,
    ...(lastList ? { list: lastList } : {}),
    ...(lastInfo ? { info: lastInfo } : {}),
  };
}

export async function imageCopyResult(
  args: string[],
  options: PharoLauncherOptions,
): Promise<LauncherCommandResult> {
  const runner = options.runner ?? runLauncherCli;
  const result = await runLauncherToolCommand(runner, args, options);
  const normalized = normalizeToolResult(
    "pharo_launcher_image_copy",
    args,
    result,
    options,
  );
  const newImageName = args[3];

  if (!normalized.ok || !newImageName) {
    return normalized;
  }

  const metadataRepair = repairCopiedImageMetadata(
    options.config ?? loadPharoLauncherConfig(),
    args[2],
    newImageName,
  );
  const verification = await verifyImage(runner, newImageName, "Copied", options);
  const copyResult: LauncherCommandResult & {
    diagnostic?: string;
    metadataRepair: ReturnType<typeof repairCopiedImageMetadata>;
    copyVerification: ImageVerification;
  } = {
    ...normalized,
    ok: verification.ok,
    ...(verification.ok
      ? {
          data: {
            ...(typeof normalized.data === "object" && normalized.data !== null
              ? normalized.data
              : {}),
            targetImageName: newImageName,
            listedImage: verification.listedImage,
            inspectedImage: verification.inspectedImage,
          },
        }
      : {}),
    metadataRepair,
    ...(!verification.ok
      ? {
          diagnostic: `Image copy command exited successfully, but target image ${newImageName} was not listable and inspectable: ${verification.diagnostic}`,
        }
      : {}),
    copyVerification: verification,
  };

  return copyResult;
}

export async function imageCreateResult(
  args: string[],
  options: PharoLauncherOptions,
): Promise<LauncherCommandResult> {
  const runner = options.runner ?? runLauncherCli;
  const result = await runLauncherToolCommand(runner, args, options);
  const normalized = normalizeToolResult(
    "pharo_launcher_image_create",
    args,
    result,
    options,
  );
  const newImageName = args.at(-1);

  if (!normalized.ok || !newImageName) {
    return normalized;
  }

  const verification = await verifyImage(runner, newImageName, "Created", options);
  const createResult: LauncherCommandResult & {
    diagnostic?: string;
    createVerification: ImageVerification;
  } = {
    ...normalized,
    ok: verification.ok,
    ...(verification.ok
      ? {
          data: {
            ...(typeof normalized.data === "object" && normalized.data !== null
              ? normalized.data
              : {}),
            targetImageName: newImageName,
            listedImage: verification.listedImage,
            inspectedImage: verification.inspectedImage,
            createdImage: verification.inspectedImage,
          },
        }
      : {}),
    ...(!verification.ok
      ? {
          diagnostic: `Image create command exited successfully, but target image ${newImageName} was not listable and inspectable: ${verification.diagnostic}`,
        }
      : {}),
    createVerification: verification,
  };

  return createResult;
}

interface TemplateSourcesBootstrap {
  ok: boolean;
  action: "not_applicable" | "already_present" | "created" | "failed";
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

async function ensureProfileTemplateSourcesBootstrap(
  config: PharoLauncherConfig | undefined,
  options: PharoLauncherOptions,
): Promise<TemplateSourcesBootstrap> {
  const sourcesPath = profileTemplateSourcesFile(config);
  if (!sourcesPath) {
    return { ok: true, action: "not_applicable" };
  }

  if (nonEmptyFile(sourcesPath)) {
    return {
      ok: true,
      action: "already_present",
      path: sourcesPath,
      bytes: fs.statSync(sourcesPath).size,
    };
  }

  const url = options.templateSourcesUrl ?? defaultTemplateSourcesUrl;
  try {
    const fetchTemplateSources =
      options.fetchTemplateSources ?? defaultFetchTemplateSources;
    const body = await fetchTemplateSources(url);
    if (body.trim().length === 0) {
      throw new Error("downloaded template source list was empty");
    }

    fs.mkdirSync(path.dirname(sourcesPath), { recursive: true });
    const tempPath = `${sourcesPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, body, "utf8");
    fs.renameSync(tempPath, sourcesPath);

    return {
      ok: true,
      action: "created",
      path: sourcesPath,
      url,
      bytes: Buffer.byteLength(body, "utf8"),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      action: "failed",
      path: sourcesPath,
      url,
      diagnostic:
        "Pharo Launcher template update completed, but the active profile template source bootstrap file is missing or empty.",
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
      action:
        "Fetch or seed the active profile sources.list, then run pharo_launcher_template_update again before planning image creation.",
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
  const probeResult = normalizeToolResult(
    "pharo_launcher_template_list",
    probeArgs,
    await runLauncherToolCommand(runner, probeArgs, commandOptions),
    commandOptions,
  );
  if (!probeResult.ok) {
    return {
      ...normalized,
      ok: false,
      diagnostic:
        probeResult.diagnostic ??
        "Pharo Launcher template update completed, but template list still failed for the active profile.",
      action:
        probeResult.action ??
        "Inspect pharo_launcher_template_list diagnostics before planning image creation.",
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

  const runner = options.runner ?? runLauncherCli;
  const result =
    toolName.startsWith("pharo_launcher_process_") && shouldUseNativeProcessTool()
      ? await runNativeProcessTool(args, options.timeoutMs)
      : await runLauncherToolCommand(runner, args, options);
  return normalizeToolResult(toolName, args, result, options);
}

/** Table shape, on every command that prints one. */
export interface LauncherTableOptions {
  format?: "ston" | "text";
  brief?: boolean;
  rowMode?: boolean;
  delimiter?: string;
  includeRaw?: boolean;
}

export interface ImageCreateInput extends LauncherTableOptions {
  templateName: string;
  newImageName: string;
  templateCategory?: string;
  dev?: boolean;
  noLaunch?: boolean;
}

export interface ImageStartInput extends LauncherTableOptions {
  imageName: string;
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
  ): Promise<LauncherCommandResult<LauncherImage[]>>;
  imageInfo(
    input: { imageName: string } & LauncherTableOptions,
  ): Promise<LauncherCommandResult>;
  createImage(input: ImageCreateInput): Promise<LauncherCommandResult>;
  copyImage(
    input: { imageName: string; newImageName: string } & LauncherTableOptions,
  ): Promise<LauncherCommandResult>;
  startImage(input: ImageStartInput): Promise<LauncherCommandResult>;
  deleteImage(
    input: { imageName: string; force?: boolean } & LauncherTableOptions,
  ): Promise<LauncherCommandResult>;
  listProcesses(
    input?: LauncherTableOptions,
  ): Promise<LauncherCommandResult<LauncherProcess[]>>;
  killProcess(
    input: ({ pid: number | string } | { imageName: string }) &
      LauncherTableOptions,
  ): Promise<LauncherCommandResult>;
  listTemplateCategories(
    input?: LauncherTableOptions,
  ): Promise<LauncherCommandResult<string[]>>;
  listTemplates(
    input?: { templateCategory?: string } & LauncherTableOptions,
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
    listImages: (input) => command("pharo_launcher_image_list", input),
    imageInfo: (input) => command("pharo_launcher_image_info", input),
    createImage: (input) => command("pharo_launcher_image_create", input),
    copyImage: (input) => command("pharo_launcher_image_copy", input),
    startImage: (input) => command("pharo_launcher_image_start", input),
    deleteImage: (input) => command("pharo_launcher_image_delete", input),
    listProcesses: (input) => command("pharo_launcher_process_list", input),
    killProcess: (input) => command("pharo_launcher_process_kill", input),
    listTemplateCategories: (input) =>
      command("pharo_launcher_template_category_list", input),
    listTemplates: (input) => command("pharo_launcher_template_list", input),
    updateTemplates: (input) =>
      command("pharo_launcher_template_update", input) as Promise<
        TemplateUpdateResult
      >,
    copyImageBetweenProfiles: (input) => copyImageBetweenProfiles(input),
  };
}
