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
import {
  loadPharoLauncherConfig,
  type PharoLauncherConfig,
} from "./config.js";
import {
  getPharoLauncherConfigReport,
  getPharoLauncherHealth,
  getPharoLauncherVersion,
  type LauncherCliRunner,
  validatePharoLauncherInstallation,
} from "./discovery.js";
import { runLauncherCli } from "./launcherCli.js";
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

const emptyInputSchema = {
  type: "object",
  properties: {},
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
  imageCopyVerificationTimeoutMs?: number;
  imageCopyVerificationPollMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
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

async function runLauncherToolCommand(
  runner: LauncherCliRunner,
  args: readonly string[],
  options: CallToolOptions,
): Promise<LauncherCliResult> {
  return runner(args, runnerOptions(options));
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

interface ImageCopyVerification {
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

async function verifyCopiedImage(
  runner: LauncherCliRunner,
  newImageName: string,
  options: CallToolOptions,
): Promise<ImageCopyVerification> {
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
  let diagnostic = "Copied image did not appear in image list.";

  while (true) {
    attempts += 1;

    const listArgs = buildLauncherCommandArgs("pharo_launcher_image_list", {
      nameFilter: newImageName,
      format: "ston",
    });
    const listResult = await runLauncherToolCommand(
      runner,
      listArgs ?? [],
      options,
    );
    const normalizedList = normalizeLauncherResult(
      "pharo_launcher_image_list",
      listArgs ?? [],
      listResult,
    );
    lastList = normalizedList;
    const listedImage = normalizedList.ok
      ? namedImage(normalizedList.data, newImageName)
      : undefined;

    if (normalizedList.ok && listedImage) {
      const infoArgs = buildLauncherCommandArgs("pharo_launcher_image_info", {
        imageName: newImageName,
        format: "ston",
      });
      const infoResult = await runLauncherToolCommand(
        runner,
        infoArgs ?? [],
        options,
      );
      const normalizedInfo = normalizeLauncherResult(
        "pharo_launcher_image_info",
        infoArgs ?? [],
        infoResult,
      );
      lastInfo = normalizedInfo;
      const inspectedImage = normalizedInfo.ok
        ? namedImage(normalizedInfo.data, newImageName)
        : undefined;

      if (normalizedInfo.ok && inspectedImage) {
        return {
          ok: true,
          targetImageName: newImageName,
          attempts,
          elapsedMs: Date.now() - startedAt,
          listedImage,
          inspectedImage,
          list: normalizedList,
          info: normalizedInfo,
        };
      }

      diagnostic = normalizedInfo.ok
        ? "Copied image appeared in image list but could not be inspected."
        : "Copied image appeared in image list, but image info failed.";
    } else {
      diagnostic = normalizedList.ok
        ? "Copied image did not appear in image list."
        : "Image list failed while verifying copied image.";
    }

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
  const normalized = normalizeLauncherResult(
    "pharo_launcher_image_copy",
    args,
    result,
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
  const verification = await verifyCopiedImage(runner, newImageName, options);
  const copyResult: LauncherCommandResult & {
    diagnostic?: string;
    metadataRepair: ReturnType<typeof repairCopiedImageMetadata>;
    copyVerification: ImageCopyVerification;
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

async function cliResult(
  toolName: string,
  args: string[],
  options: CallToolOptions,
): Promise<ToolResult> {
  if (toolName === "pharo_launcher_image_copy") {
    return imageCopyResult(args, options);
  }

  const runner = options.runner ?? runLauncherCli;
  const result =
    toolName.startsWith("pharo_launcher_process_") && shouldUseNativeProcessTool()
      ? await runNativeProcessTool(args, options.timeoutMs)
      : await runLauncherToolCommand(runner, args, options);
  const isError = result.exitCode !== 0 || result.timedOut;

  return jsonResult(normalizeLauncherResult(toolName, args, result), isError);
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

    case "pharo_launcher_version": {
      const result = await getPharoLauncherVersion(runner, options.config);
      return jsonResult(result, !result.ok);
    }

    case "pharo_launcher_validate_installation": {
      const result = await validatePharoLauncherInstallation(
        runner,
        options.config,
      );
      return jsonResult(result, !result.ok);
    }

    default:
      try {
        const commandArgs = buildLauncherCommandArgs(name, argumentsValue);
        if (commandArgs) {
          return cliResult(name, commandArgs, options);
        }
      } catch (error) {
        if (error instanceof ToolInputError) {
          return jsonResult({ error: error.message }, true);
        }

        throw error;
      }

      if (name === rawCommandTool.name) {
        try {
          return cliResult(
            name,
            rawCommandTool.buildArgs(argumentsValue),
            options,
          );
        } catch (error) {
          if (error instanceof ToolInputError) {
            return jsonResult({ error: error.message }, true);
          }

          throw error;
        }
      }

      return jsonResult(
        {
          error: `Unknown tool: ${name}`,
        },
        true,
      );
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
