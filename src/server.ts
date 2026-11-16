import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { launcherCommandTools, ProfileTooDeepError, ToolInputError } from "./commandCatalog.js";
import { loadPharoLauncherConfig } from "./config.js";
import {
  failureResult,
  invalidArgumentsText,
  toolAnswers,
  toolArguments,
  unknownToolText,
  type ToolResult,
} from "./answers.js";
import { resolveImagesDirectory } from "./imageStore.js";
import { openPharoLauncher, type CallToolOptions } from "./launcher.js";

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
/** A path of a profile, where stateRoot puts it. */
function defaultsTo(place: string) {
  return { ...stringSchema, description: `Defaults to <stateRoot>/${place}.` } as const;
}
// Undescribed, every path reads as one to fill in, and a model guesses each.
const scopedProfileSchema = {
  type: "object",
  description:
    "A launcher profile, given by its stateRoot. Every other path defaults to its place " +
    "inside stateRoot: give one only when the profile keeps it elsewhere.",
  properties: {
    stateRoot: {
      ...stringSchema,
      description: "Absolute path of the directory that holds the profile's images/ directory.",
    },
    launcherConfiguration: defaultsTo("launcher/pharo-launcher-cli-config.ston"),
    imagesDir: defaultsTo("images"),
    vmsDir: defaultsTo("vms"),
    templateSourcesDir: defaultsTo("templates"),
    initScriptsDir: defaultsTo("init-scripts"),
    logsDir: defaultsTo("logs"),
    profileName: { ...stringSchema, description: "Optional. The copy does not use it." },
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
      "Say which Pharo Launcher this server runs, and where its images are.",
    inputSchema: emptyInputSchema,
  },
  {
    name: "pharo_launcher_image_copy_between_profiles",
    description:
      "Copy a launcher image from one launcher profile to another. A profile is given by its " +
      "stateRoot, the directory that holds its images/ directory; pharo_launcher_config prints " +
      "this server's own. Every profile path must exist: the copy creates none.",
    inputSchema: copyBetweenProfilesInputSchema,
  },
  ...launcherCommandTools,
] as const;

/** What the server advertises, for whoever has to stay level with it. */
export const toolNames: readonly string[] = tools.map((tool) => tool.name);

const toolByName = new Map<string, { inputSchema: { properties?: Record<string, unknown> } }>(
  tools.map((tool) => [tool.name, tool as { inputSchema: { properties?: Record<string, unknown> } }]),
);

/**
 * One tool call, answered in plain text. Each call opens the library on the
 * server's scope, asking for what the Launcher wrote, and gives the function
 * its tool maps to only the arguments that tool takes: an older caller's
 * includeRaw, format, brief, rowMode, delimiter, force, confirm or noLaunch is
 * dropped unread. The library's parser, command and raw never reach a model.
 */
export async function callTool(
  name: string,
  argumentsValue: unknown,
  options: CallToolOptions = {},
): Promise<ToolResult> {
  const tool = toolByName.get(name);
  const answer = toolAnswers[name];
  if (!tool || !answer) {
    return failureResult(unknownToolText(name));
  }

  try {
    const config = options.config ?? loadPharoLauncherConfig();
    return await answer(
      {
        launcher: openPharoLauncher({ ...options, config, includeRaw: true }),
        config,
        options: { ...options, config },
        imagesDir: resolveImagesDirectory(config).path,
      },
      toolArguments(tool.inputSchema, argumentsValue),
    );
  } catch (error) {
    // Its message says what to do, as it is.
    if (error instanceof ProfileTooDeepError) {
      return failureResult(error.message);
    }
    if (error instanceof ToolInputError) {
      return failureResult(invalidArgumentsText(name, tool.inputSchema, error));
    }

    throw error;
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
