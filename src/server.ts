import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  buildLauncherCommandArgs,
  launcherCommandTools,
  ToolInputError,
} from "./commandCatalog.js";
import { copyImageBetweenProfiles } from "./crossProfileCopy.js";
import {
  commandResultOptions,
  runCommand,
  type PharoLauncherOptions,
} from "./launcher.js";
import { getPharoLauncherConfigReport } from "./discovery.js";

// Read the version, do not keep a copy of it. The copy that used to live here
// said 0.1.1 while the package was 0.1.4, so every client was told the wrong
// version at initialize.
const serverVersion = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;

const emptyInputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;
const stringSchema = { type: "string", minLength: 1 } as const;
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
    name: "pharo_launcher_config",
    description:
      "Return resolved PharoLauncher configuration paths, script source, and file existence.",
    inputSchema: emptyInputSchema,
  },
  {
    name: "pharo_launcher_image_copy_between_profiles",
    description:
      "Copy a launcher image from one explicitly supplied scoped launcher profile to another explicitly supplied scoped launcher profile.",
    inputSchema: copyBetweenProfilesInputSchema,
  },
  ...launcherCommandTools,
] as const;

/** What the server advertises, for whoever has to stay level with it. */
export const toolNames: readonly string[] = tools.map((tool) => tool.name);

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};


function textResult(text: string, isError = false): ToolResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError } : {}),
  };
}

function jsonResult(value: unknown, isError = false): ToolResult {
  return textResult(JSON.stringify(value, null, 2), isError);
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

function profileImageCopyResult(argumentsValue: unknown): Promise<ToolResult> {
  return withToolInputErrorResult(() => {
    const result = copyImageBetweenProfiles(argumentsValue);
    return jsonResult(result, !result.ok);
  });
}

async function commandCatalogToolResult(
  name: string,
  argumentsValue: unknown,
  options: PharoLauncherOptions,
): Promise<ToolResult> {
  return withToolInputErrorResult(async () => {
    const resultOptions = commandResultOptions(argumentsValue, options);
    const commandArgs = buildLauncherCommandArgs(name, argumentsValue);
    if (commandArgs) {
      const commandResult = await runCommand(name, commandArgs, resultOptions);
      return jsonResult(commandResult, !commandResult.ok);
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
  options: PharoLauncherOptions = {},
): Promise<ToolResult> {
  switch (name) {
    case "pharo_launcher_config":
      return jsonResult(getPharoLauncherConfigReport(options.config));

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

export * from "./launcher.js";
