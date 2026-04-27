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
import type { PharoLauncherConfig } from "./config.js";
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
import { normalizeLauncherResult } from "./resultNormalizer.js";

const serverVersion = "0.1.1";

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

async function cliResult(
  toolName: string,
  args: string[],
  options: CallToolOptions,
): Promise<ToolResult> {
  const runner = options.runner ?? runLauncherCli;
  const result =
    toolName.startsWith("pharo_launcher_process_") && shouldUseNativeProcessTool()
      ? await runNativeProcessTool(args, options.timeoutMs)
      : await runner(args, {
          ...(options.config ? { config: options.config } : {}),
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        });
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
