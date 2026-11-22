import path from "node:path";

export interface LauncherCommandTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** The Launcher command it runs; none for a tool that reads the disk. */
  buildArgs?: (input: unknown) => string[];
}

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

/**
 * A profile whose VM directory is too deep for the VM to load its own
 * modules. A `ToolInputError`, as it was before it had a class of its own, so
 * a caller that catches one catches it; its message says what to do.
 */
export class ProfileTooDeepError extends ToolInputError {
  constructor(message: string) {
    super(message);
    this.name = "ProfileTooDeepError";
  }
}

const stringSchema = { type: "string", minLength: 1 } as const;
const booleanSchema = { type: "boolean" } as const;
const displayModeSchema = {
  type: "string",
  enum: ["headless", "interactive"],
  default: "headless",
} as const;

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  } as const;
}

const emptyInputSchema = objectSchema({});

export function inputObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  return input as Record<string, unknown>;
}

export function optionalString(
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

export function requiredString(
  input: Record<string, unknown>,
  key: string,
): string {
  const value = optionalString(input, key);
  if (!value) {
    throw new ToolInputError(`${key} is required`);
  }

  return value;
}

/** A path the caller named, read from the caller's working directory. */
function optionalPath(input: Record<string, unknown>, key: string): string | undefined {
  const value = optionalString(input, key);
  return value === undefined ? undefined : path.resolve(value);
}

function optionalStringOrNumber(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  throw new ToolInputError(`${key} must be a non-empty string or number`);
}

function optionalBoolean(input: Record<string, unknown>, key: string): boolean {
  const value = input[key];
  if (value === undefined) {
    return false;
  }

  if (typeof value !== "boolean") {
    throw new ToolInputError(`${key} must be a boolean`);
  }

  return value;
}

function optionalDisplayMode(
  input: Record<string, unknown>,
): "headless" | "interactive" | undefined {
  const value = input.displayMode;
  if (value === undefined) {
    return undefined;
  }

  if (value === "headless" || value === "interactive") {
    return value;
  }

  throw new ToolInputError("displayMode must be headless or interactive");
}

function addOption(args: string[], flag: string, value: string | undefined): void {
  if (value !== undefined) {
    args.push(flag, value);
  }
}

function addFlag(args: string[], flag: string, enabled: boolean): void {
  if (enabled) {
    args.push(flag);
  }
}

// Without --no-launch PharoLauncher starts the new image and waits for it to
// quit, so the call would last as long as the image runs. Starting an image is
// image_start's.
function imageCreate(input: unknown): string[] {
  const object = inputObject(input);
  const args = ["image", "create"];
  addFlag(args, "--dev", optionalBoolean(object, "dev"));
  args.push("--no-launch");
  addOption(args, "--templateName", requiredString(object, "templateName"));
  addOption(args, "--templateCategory", optionalString(object, "templateCategory"));
  args.push(requiredString(object, "newImageName"));
  return args;
}

// Without --force PharoLauncher asks on standard input, and keeps asking: a
// call has nobody there to answer. Calling the tool is the confirmation.
function imageDelete(input: unknown): string[] {
  const object = inputObject(input);
  return ["image", "delete", "--force", requiredString(object, "imageName")];
}

function imageStart(input: unknown): string[] {
  const object = inputObject(input);
  // PharoLauncher's subcommand is still `launch`; only the tool name moved.
  const args = ["image", "launch"];
  addOption(args, "--script", optionalPath(object, "script"));
  addOption(args, "--displayMode", optionalDisplayMode(object));
  addFlag(args, "--detached", optionalBoolean(object, "detached"));
  args.push(requiredString(object, "imageName"));
  return args;
}

function imageCopy(input: unknown): string[] {
  const object = inputObject(input);
  return [
    "image",
    "copy",
    requiredString(object, "imageName"),
    requiredString(object, "newImageName"),
  ];
}

function processKill(input: unknown): string[] {
  const object = inputObject(input);
  const args = ["process", "kill"];
  const pid = optionalStringOrNumber(object, "pid");
  const imageName = optionalString(object, "imageName");

  if (pid && imageName) {
    throw new ToolInputError("Give pid or imageName, not both.");
  }

  const target = pid ?? imageName;
  if (!target) {
    throw new ToolInputError("Give the pid or the imageName of the process to kill.");
  }

  args.push(target);
  return args;
}

// One row per category, no header, the default marked: the one listing that
// names the categories alone (the STON one walks the whole template tree).
function templateCategoryList(): string[] {
  return ["template", "categories", "--brief"];
}

// STON names every template whole; the table shortens a name past 75
// characters.
function templateList(input: unknown): string[] {
  const object = inputObject(input);
  const args = ["template", "list"];
  addOption(args, "--templateCategory", optionalString(object, "templateCategory"));
  args.push("--ston");
  return args;
}

export const launcherCommandTools: LauncherCommandTool[] = [
  {
    name: "pharo_launcher_image_copy",
    description: "Copy an existing PharoLauncher image to a new image name.",
    inputSchema: objectSchema(
      { imageName: stringSchema, newImageName: stringSchema },
      ["imageName", "newImageName"],
    ),
    buildArgs: imageCopy,
  },
  {
    name: "pharo_launcher_image_create",
    description:
      "Create an image from a template. It is not started: " +
      "pharo_launcher_image_start starts it.",
    inputSchema: objectSchema(
      {
        newImageName: stringSchema,
        dev: booleanSchema,
        templateName: stringSchema,
        templateCategory: stringSchema,
      },
      ["newImageName", "templateName"],
    ),
    buildArgs: imageCreate,
  },
  {
    name: "pharo_launcher_image_delete",
    description:
      "Delete an image, its directory and the logs of its starts. Nothing " +
      "asks for a confirmation. A running image is refused: stop it first " +
      "with pharo_launcher_process_kill.",
    inputSchema: objectSchema({ imageName: stringSchema }, ["imageName"]),
    buildArgs: imageDelete,
  },
  {
    name: "pharo_launcher_image_info",
    description:
      "Describe an image of this Launcher: its path, Pharo version, " +
      "architecture, template and whether it runs.",
    inputSchema: objectSchema({ imageName: stringSchema }, ["imageName"]),
  },
  {
    name: "pharo_launcher_image_list",
    description:
      "List this Launcher's images, each with its Pharo version, architecture, " +
      "template and whether it runs. nameFilter keeps the images whose name " +
      "contains it.",
    inputSchema: objectSchema({ nameFilter: stringSchema }),
  },
  {
    name: "pharo_launcher_image_start",
    description:
      "Start an image, optionally with a script for it to run. Unless " +
      "detached, the call lasts until the image quits.",
    inputSchema: objectSchema(
      {
        imageName: stringSchema,
        script: {
          ...stringSchema,
          description:
            "A script for the image to run. A relative path is read from this " +
            "server's working directory.",
        },
        detached: booleanSchema,
        displayMode: displayModeSchema,
      },
      ["imageName"],
    ),
    buildArgs: imageStart,
  },
  {
    name: "pharo_launcher_process_kill",
    description:
      "Kill a process running an image of this Launcher, by pid or by image " +
      "name. A pid stops that process alone; an image name stops every " +
      "process running that image.",
    inputSchema: objectSchema({
      imageName: stringSchema,
      pid: { anyOf: [stringSchema, { type: "number" }] },
    }),
    buildArgs: processKill,
  },
  {
    name: "pharo_launcher_process_list",
    description:
      "List the Pharo processes running an image of this Launcher, by image " +
      "name and pid.",
    inputSchema: emptyInputSchema,
    buildArgs: () => ["process", "list"],
  },
  {
    name: "pharo_launcher_template_category_list",
    description: "List template categories.",
    inputSchema: emptyInputSchema,
    buildArgs: templateCategoryList,
  },
  {
    name: "pharo_launcher_template_list",
    description: "List image templates.",
    inputSchema: objectSchema({ templateCategory: stringSchema }),
    buildArgs: templateList,
  },
  {
    name: "pharo_launcher_template_update",
    description: "Update the template sources list.",
    inputSchema: emptyInputSchema,
    buildArgs: () => ["template", "update"],
  },
];

export const launcherCommandToolByName = new Map(
  launcherCommandTools.map((tool) => [tool.name, tool]),
);

export function buildLauncherCommandArgs(name: string, input: unknown): string[] | undefined {
  return launcherCommandToolByName.get(name)?.buildArgs?.(input);
}
