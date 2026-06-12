import fs from "node:fs";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  buildLauncherCommandArgs,
  launcherCommandTools,
  rawCommandTool,
  ToolInputError,
} from "./commandCatalog.js";
import { copyImageBetweenProfiles } from "./crossProfileCopy.js";
import {
  loadPharoLauncherConfig,
  type PharoLauncherConfig,
} from "./config.js";
import {
  getPharoLauncherConfigReport,
  getPharoLauncherHealth,
  getPharoLauncherInventory,
  getPharoLauncherVersion,
  type LauncherCliRunner,
  type PharoLauncherDeclaredImage,
  type PharoLauncherTemplateCreateRequest,
  validatePharoLauncherInstallation,
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
import type { LauncherCommandResult, LauncherImage } from "./models.js";

const serverVersion = "0.1.1";
const imageCopyVerificationTimeoutMs = 30_000;
const imageCopyVerificationPollMs = 1_000;
const defaultTemplateSourcesUrl =
  "https://files.pharo.org/pharo-launcher/sources.list";
const templateSourcesFileName = "sources.list";

const emptyInputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;
const stringSchema = { type: "string", minLength: 1 } as const;
const booleanSchema = { type: "boolean" } as const;
const declaredImageSchema = {
  type: "object",
  properties: {
    imageId: stringSchema,
    imageName: stringSchema,
    projectId: stringSchema,
    workspaceId: stringSchema,
    targetId: stringSchema,
    active: booleanSchema,
    status: stringSchema,
  },
  required: ["imageId"],
  additionalProperties: false,
} as const;
const templateCreateRequestSchema = {
  type: "object",
  properties: {
    templateName: stringSchema,
    templateCategory: stringSchema,
  },
  required: ["templateName"],
  additionalProperties: false,
} as const;
const inventoryInputSchema = {
  type: "object",
  properties: {
    declaredImages: {
      type: "array",
      items: declaredImageSchema,
      description:
        "Project/workspace-declared image handles supplied by a scoped caller.",
    },
    templateCreateRequest: {
      ...templateCreateRequestSchema,
      description:
        "Optional template image create request to evaluate for offline readiness without mutation or download.",
    },
  },
  additionalProperties: false,
} as const;
const scopedProfileSchema = {
  type: "object",
  properties: {
    stateRoot: stringSchema,
    launcherConfiguration: stringSchema,
    imagesDir: stringSchema,
    vmsDir: stringSchema,
    templateSourcesDir: stringSchema,
    initScriptsDir: stringSchema,
    logsDir: stringSchema,
    profileName: stringSchema,
  },
  additionalProperties: false,
} as const;
const copyBetweenProfilesInputSchema = {
  type: "object",
  properties: {
    sourceProfile: scopedProfileSchema,
    destinationProfile: scopedProfileSchema,
    sourceImageName: stringSchema,
    destinationImageName: stringSchema,
  },
  required: [
    "sourceProfile",
    "destinationProfile",
    "sourceImageName",
    "destinationImageName",
  ],
  additionalProperties: false,
} as const;

const tools = [
  {
    name: "pharo_launcher_health",
    description:
      "Return pharo-launcher-mcp health, resolved paths, script source, and file existence without invoking PharoLauncher.",
    inputSchema: emptyInputSchema,
  },
  {
    name: "pharo_launcher_config",
    description:
      "Return resolved PharoLauncher configuration paths, script source, and file existence.",
    inputSchema: emptyInputSchema,
  },
  {
    name: "pharo_launcher_version",
    description: "Run a harmless PharoLauncher --version call.",
    inputSchema: emptyInputSchema,
  },
  {
    name: "pharo_launcher_validate_installation",
    description:
      "Validate resolved paths and run a harmless PharoLauncher --version call.",
    inputSchema: emptyInputSchema,
  },
  {
    name: "pharo_launcher_inventory",
    description:
      "Return read-only scoped Pharo Launcher templates, versions, active profile roots, existing images, and caller-declared image handles for safe lifecycle planning.",
    inputSchema: inventoryInputSchema,
  },
  {
    name: "pharo_launcher_image_copy_between_profiles",
    description:
      "Copy a launcher image from one explicitly supplied scoped launcher profile to another explicitly supplied scoped launcher profile.",
    inputSchema: copyBetweenProfilesInputSchema,
  },
  ...launcherCommandTools,
  rawCommandTool,
] as const;

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export interface CallToolOptions {
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

function textResult(text: string, isError = false): ToolResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError } : {}),
  };
}

function jsonResult(value: unknown, isError = false): ToolResult {
  return textResult(JSON.stringify(value, null, 2), isError);
}

function runnerOptions(
  options: CallToolOptions,
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

function optionalString(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new ToolInputError(`${key} must be a non-empty string`);
  }

  return value;
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

function commandResultOptions(
  argumentsValue: unknown,
  options: CallToolOptions,
): CallToolOptions {
  const includeRaw = optionalBoolean(inputObject(argumentsValue), "includeRaw");
  return includeRaw === undefined ? options : { ...options, includeRaw };
}

function normalizeToolResult(
  toolName: string,
  args: readonly string[],
  result: LauncherCliResult,
  options: CallToolOptions,
): LauncherCommandResult {
  return normalizeLauncherResult(toolName, args, result, {
    includeRaw: options.includeRaw,
  });
}

function declaredImagesFromInput(input: unknown): PharoLauncherDeclaredImage[] {
  const object = inputObject(input);
  const declaredImages = object.declaredImages;
  if (declaredImages === undefined) {
    return [];
  }

  if (!Array.isArray(declaredImages)) {
    throw new ToolInputError("declaredImages must be an array");
  }

  return declaredImages.map((candidate, index) => {
    const image = inputObject(candidate);
    const imageId = optionalString(image, "imageId");
    if (!imageId) {
      throw new ToolInputError(`declaredImages[${index}].imageId is required`);
    }

    return {
      imageId,
      ...(optionalString(image, "imageName")
        ? { imageName: optionalString(image, "imageName") }
        : {}),
      ...(optionalString(image, "projectId")
        ? { projectId: optionalString(image, "projectId") }
        : {}),
      ...(optionalString(image, "workspaceId")
        ? { workspaceId: optionalString(image, "workspaceId") }
        : {}),
      ...(optionalString(image, "targetId")
        ? { targetId: optionalString(image, "targetId") }
        : {}),
      ...(optionalBoolean(image, "active") !== undefined
        ? { active: optionalBoolean(image, "active") }
        : {}),
      ...(optionalString(image, "status")
        ? { status: optionalString(image, "status") }
        : {}),
    };
  });
}

function templateCreateRequestFromInput(
  input: unknown,
): PharoLauncherTemplateCreateRequest | undefined {
  const object = inputObject(input);
  const value = object.templateCreateRequest;
  if (value === undefined) {
    return undefined;
  }

  const request = inputObject(value);
  const templateName = optionalString(request, "templateName");
  if (!templateName) {
    throw new ToolInputError("templateCreateRequest.templateName is required");
  }

  const templateCategory = optionalString(request, "templateCategory");
  return {
    templateName,
    ...(templateCategory ? { templateCategory } : {}),
  };
}

async function runLauncherToolCommand(
  runner: LauncherCliRunner,
  args: readonly string[],
  options: CallToolOptions,
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
  options: CallToolOptions,
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
  options: CallToolOptions,
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
    diagnostic:
      normalizedInfo.ok && !inspectedImage
        ? `${operationLabel} image appeared in image list but could not be inspected.`
        : `${operationLabel} image appeared in image list, but image info failed.`,
  };
}

async function verifyImage(
  runner: LauncherCliRunner,
  newImageName: string,
  operationLabel: "Copied" | "Created",
  options: CallToolOptions,
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

async function imageCopyResult(
  args: string[],
  options: CallToolOptions,
): Promise<ToolResult> {
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
    return jsonResult(normalized, true);
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

  return jsonResult(copyResult, !copyResult.ok);
}

async function imageCreateResult(
  args: string[],
  options: CallToolOptions,
): Promise<ToolResult> {
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
    return jsonResult(normalized, true);
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

  return jsonResult(createResult, !createResult.ok);
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
  options: CallToolOptions,
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

async function templateUpdateResult(
  args: string[],
  options: CallToolOptions,
): Promise<ToolResult> {
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
    return jsonResult(normalized, true);
  }

  const bootstrap = await ensureProfileTemplateSourcesBootstrap(
    config,
    commandOptions,
  );
  if (!bootstrap.ok) {
    return jsonResult(
      {
        ...normalized,
        ok: false,
        diagnostic: bootstrap.diagnostic,
        action:
          "Fetch or seed the active profile sources.list, then run pharo_launcher_template_update again before planning image creation.",
        templateSourcesBootstrap: bootstrap,
      },
      true,
    );
  }

  if (bootstrap.action === "not_applicable") {
    return jsonResult({
      ...normalized,
      templateSourcesBootstrap: bootstrap,
    });
  }

  const probeArgs = ["template", "list", "--ston"];
  const probeResult = normalizeToolResult(
    "pharo_launcher_template_list",
    probeArgs,
    await runLauncherToolCommand(runner, probeArgs, commandOptions),
    commandOptions,
  );
  if (!probeResult.ok) {
    return jsonResult(
      {
        ...normalized,
        ok: false,
        diagnostic:
          probeResult.diagnostic ??
          "Pharo Launcher template update completed, but template list still failed for the active profile.",
        action:
          probeResult.action ??
          "Inspect pharo_launcher_inventory diagnostics before planning image creation.",
        templateSourcesBootstrap: bootstrap,
        templateSourcesProbe: probeResult,
      },
      true,
    );
  }

  return jsonResult({
    ...normalized,
    templateSourcesBootstrap: bootstrap,
    templateSourcesProbe: probeResult,
  });
}

async function cliResult(
  toolName: string,
  args: string[],
  options: CallToolOptions,
): Promise<ToolResult> {
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
  const isError = result.exitCode !== 0 || result.timedOut;

  return jsonResult(normalizeToolResult(toolName, args, result, options), isError);
}

async function withToolInputErrorResult(
  operation: () => Promise<ToolResult> | ToolResult,
): Promise<ToolResult> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ToolInputError) {
      return jsonResult({ error: error.message }, true);
    }

    throw error;
  }
}

async function launcherVersionResult(
  runner: LauncherCliRunner,
  options: CallToolOptions,
): Promise<ToolResult> {
  const result = await getPharoLauncherVersion(runner, options.config);
  return jsonResult(result, !result.ok);
}

async function launcherInstallationValidationResult(
  runner: LauncherCliRunner,
  options: CallToolOptions,
): Promise<ToolResult> {
  const result = await validatePharoLauncherInstallation(
    runner,
    options.config,
  );
  return jsonResult(result, !result.ok);
}

async function launcherInventoryResult(
  runner: LauncherCliRunner,
  argumentsValue: unknown,
  options: CallToolOptions,
): Promise<ToolResult> {
  return withToolInputErrorResult(async () => {
    const templateCreateRequest =
      templateCreateRequestFromInput(argumentsValue);
    const result = await getPharoLauncherInventory(runner, options.config, {
      declaredImages: declaredImagesFromInput(argumentsValue),
      ...(templateCreateRequest ? { templateCreateRequest } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    return jsonResult(result, !result.ok);
  });
}

function profileImageCopyResult(argumentsValue: unknown): Promise<ToolResult> {
  return withToolInputErrorResult(() => {
    const result = copyImageBetweenProfiles(argumentsValue);
    return jsonResult(result, !result.ok);
  });
}

async function commandCatalogToolResult(
  name: string,
  argumentsValue: unknown,
  options: CallToolOptions,
): Promise<ToolResult> {
  return withToolInputErrorResult(async () => {
    const resultOptions = commandResultOptions(argumentsValue, options);
    const commandArgs = buildLauncherCommandArgs(name, argumentsValue);
    if (commandArgs) {
      return cliResult(name, commandArgs, resultOptions);
    }

    if (name === rawCommandTool.name) {
      return cliResult(
        name,
        rawCommandTool.buildArgs(argumentsValue),
        resultOptions,
      );
    }

    return jsonResult(
      {
        error: `Unknown tool: ${name}`,
      },
      true,
    );
  });
}

export async function callTool(
  name: string,
  argumentsValue: unknown,
  options: CallToolOptions = {},
): Promise<ToolResult> {
  const runner = options.runner ?? runLauncherCli;

  switch (name) {
    case "pharo_launcher_health":
      return jsonResult({
        version: serverVersion,
        ...getPharoLauncherHealth(options.config),
      });

    case "pharo_launcher_config":
      return jsonResult(getPharoLauncherConfigReport(options.config));

    case "pharo_launcher_version":
      return launcherVersionResult(runner, options);

    case "pharo_launcher_validate_installation":
      return launcherInstallationValidationResult(runner, options);

    case "pharo_launcher_inventory":
      return launcherInventoryResult(runner, argumentsValue, options);

    case "pharo_launcher_image_copy_between_profiles":
      return profileImageCopyResult(argumentsValue);

    default:
      return commandCatalogToolResult(name, argumentsValue, options);
  }
}

export function createServer(): Server {
  const server = new Server(
    {
      name: "pharo-launcher-mcp",
      version: serverVersion,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...tools],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callTool(request.params.name, request.params.arguments ?? {}),
  );

  return server;
}

export async function startStdioServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
