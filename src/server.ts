import { createRequire } from "node:module";
import { Server, type Tool } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { launcherCommandTools, ProfileTooDeepError, InvalidInputError } from "./commandCatalog.js";
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
import { openLauncher, type CallToolOptions } from "./launcher.js";

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
// Undescribed, a path reads as one to fill in, and a model guesses it.
const profileSchema = {
  type: "object",
  description:
    "Where a profile keeps its images: its stateRoot, the directory that holds its " +
    "images/ directory, or an images directory itself as imagesDir. One of the two.",
  properties: {
    stateRoot: { ...stringSchema, description: "An absolute path." },
    imagesDir: { ...stringSchema, description: "An absolute path." },
  },
  additionalProperties: false,
} as const;
const copyBetweenProfilesInputSchema = {
  type: "object",
  properties: {
    sourceProfile: profileSchema,
    destinationProfile: profileSchema,
    image: { ...stringSchema, description: "The image to copy." },
    newImage: { ...stringSchema, description: "The copy's name, which may be the image's." },
  },
  required: ["sourceProfile", "destinationProfile", "image", "newImage"],
  additionalProperties: false,
} as const;

const tools = [
  {
    name: "config",
    description: "Say which Pharo Launcher this server runs, and where its images are.",
    inputSchema: emptyInputSchema,
  },
  {
    name: "image_copy_between_profiles",
    description:
      "Copy an image from one images directory to another, such as from a user's own " +
      "Launcher into a profile. config prints this server's own stateRoot. Every " +
      "directory must exist: the copy creates none.",
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
 * One tool call, answered in plain text. Each call opens the launcher on the
 * server's scope, read from the command's variables, and gives the answer only
 * the arguments its tool takes; any other is refused.
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
        launcher: openLauncher({ ...options, config }),
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
    if (error instanceof InvalidInputError) {
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

  // The tool table is JSON, which its `as const` and catalog types do not say.
  server.setRequestHandler("tools/list", async () => ({
    tools: [...tools] as Tool[],
  }));

  server.setRequestHandler("tools/call", async (request) =>
    callTool(request.params.name, request.params.arguments ?? {}),
  );

  return server;
}

/** Serves over stdio, in the protocol era the host's first message asks for. */
export async function startStdioServer(): Promise<void> {
  serveStdio(() => createServer());
}

