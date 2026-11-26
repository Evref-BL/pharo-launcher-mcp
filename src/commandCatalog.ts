import path from "node:path";

export interface LauncherCommandTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * An input a call cannot run with: a value of the wrong type, a required one
 * left out, an image name that is a path. Thrown, or the promise rejected,
 * before anything runs; its message says which.
 */
export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInputError";
  }
}

/**
 * A profile whose VM directory is too deep for the VM to load its own
 * modules: the `stateRoot` the caller gave is the input at fault. Its message
 * says what to do.
 */
export class ProfileTooDeepError extends InvalidInputError {
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
  description:
    "In a profile, how the VM shows the image: headless unless interactive. " +
    "Outside a profile the Launcher decides, and this is refused.",
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

/** An argument left out: absent, or `null`, which some clients send for one they do not use. */
function absent(value: unknown): value is undefined | null {
  return value === undefined || value === null;
}

export function optionalString(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  if (absent(value)) {
    return undefined;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidInputError(`${key} must be a non-empty string`);
  }

  return value;
}

export function requiredString(
  input: Record<string, unknown>,
  key: string,
): string {
  const value = optionalString(input, key);
  if (!value) {
    throw new InvalidInputError(`${key} is required`);
  }

  return value;
}

/**
 * A name of an image, never a path: the Launcher puts an image at
 * `<images>/<name>`, and a name holding a separator, or `.` or `..`, would put
 * it somewhere else, outside a profile even. Nor does it start with a dot:
 * the images directory's hidden entries are not read as images, so such an
 * image could be made and never found again.
 */
export function validImageName(name: string, key: string): string {
  if (name === "." || name === ".." || /[\\/]/.test(name)) {
    throw new InvalidInputError(`${key} must be an image name, not a path`);
  }
  if (name.startsWith(".")) {
    throw new InvalidInputError(`${key} must be an image name, which never starts with a dot`);
  }
  return name;
}

export function requiredImageName(input: Record<string, unknown>, key: string): string {
  return validImageName(requiredString(input, key), key);
}

function optionalImageName(input: Record<string, unknown>, key: string): string | undefined {
  const value = optionalString(input, key);
  return value === undefined ? undefined : validImageName(value, key);
}

/** A path the caller named, read from the caller's working directory. */
function optionalPath(input: Record<string, unknown>, key: string): string | undefined {
  const value = optionalString(input, key);
  return value === undefined ? undefined : path.resolve(value);
}

/** A pid: a whole number, given as one or as its digits. */
function optionalPid(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (absent(value)) {
    return undefined;
  }

  const pid = typeof value === "string" && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new InvalidInputError(`${key} must be a process id, a whole number`);
  }

  return pid;
}

function optionalBoolean(input: Record<string, unknown>, key: string): boolean {
  const value = input[key];
  if (absent(value)) {
    return false;
  }

  if (typeof value !== "boolean") {
    throw new InvalidInputError(`${key} must be a boolean`);
  }

  return value;
}

function optionalDisplayMode(
  input: Record<string, unknown>,
): "headless" | "interactive" | undefined {
  const value = input.displayMode;
  if (absent(value)) {
    return undefined;
  }

  if (value === "headless" || value === "interactive") {
    return value;
  }

  throw new InvalidInputError("displayMode must be headless or interactive");
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
// a start's.
function createImageArgs(input: unknown): string[] {
  const object = inputObject(input);
  const args = ["image", "create", "--no-launch"];
  addOption(args, "--templateName", requiredString(object, "template"));
  addOption(args, "--templateCategory", optionalString(object, "category"));
  args.push(requiredImageName(object, "image"));
  return args;
}

// Without --force PharoLauncher asks on standard input, and keeps asking: a
// call has nobody there to answer. Calling it is the confirmation.
function deleteImageArgs(input: unknown): string[] {
  return ["image", "delete", "--force", requiredImageName(inputObject(input), "image")];
}

function startImageArgs(input: unknown): string[] {
  const object = inputObject(input);
  // PharoLauncher's subcommand is `launch`.
  const args = ["image", "launch"];
  addOption(args, "--script", optionalPath(object, "script"));
  addOption(args, "--displayMode", optionalDisplayMode(object));
  addFlag(args, "--detached", optionalBoolean(object, "detached"));
  args.push(requiredImageName(object, "image"));
  return args;
}

function copyImageArgs(input: unknown): string[] {
  const object = inputObject(input);
  return ["image", "copy", requiredImageName(object, "image"), requiredImageName(object, "newImage")];
}

// Never a Launcher command: the native process tools run it, and the flag
// says what the target is, since an image may be named with digits.
function killProcessArgs(input: unknown): string[] {
  const object = inputObject(input);
  const pid = optionalPid(object, "pid");
  const image = optionalImageName(object, "image");
  if (pid !== undefined && image !== undefined) {
    throw new InvalidInputError("Give pid or image, not both.");
  }
  if (pid !== undefined) {
    return ["process", "kill", "--pid", String(pid)];
  }
  if (image !== undefined) {
    return ["process", "kill", "--image", image];
  }
  throw new InvalidInputError("Give the pid or the image of the process to kill.");
}

// STON names every template whole; the table shortens a name past 75
// characters.
function listTemplatesArgs(input: unknown): string[] {
  const args = ["template", "list"];
  addOption(args, "--templateCategory", optionalString(inputObject(input), "category"));
  args.push("--ston");
  return args;
}

/**
 * The Launcher command each call runs, its arguments read from the call's
 * input. Each refuses an input it cannot run with a `InvalidInputError`.
 */
export const commandArgs = {
  createImage: createImageArgs,
  copyImage: copyImageArgs,
  startImage: startImageArgs,
  deleteImage: deleteImageArgs,
  killProcess: killProcessArgs,
  listProcesses: (): string[] => ["process", "list"],
  // One row per category, no header, the default marked: the one listing that
  // names the categories alone (the STON one walks the whole template tree).
  listTemplateCategories: (): string[] => ["template", "categories", "--brief"],
  listTemplates: listTemplatesArgs,
  updateTemplates: (): string[] => ["template", "update"],
} as const;

const imageSchema = { ...stringSchema, description: "The image's name." } as const;

export const launcherCommandTools: LauncherCommandTool[] = [
  {
    name: "image_copy",
    description: "Copy an image of this Launcher under a new name.",
    inputSchema: objectSchema({ image: imageSchema, newImage: stringSchema }, ["image", "newImage"]),
  },
  {
    name: "image_create",
    description: "Create an image from a template. It is not started: image_start starts it.",
    inputSchema: objectSchema(
      {
        image: imageSchema,
        template: { ...stringSchema, description: "A template's name, as template_list lists it." },
        category: {
          ...stringSchema,
          description: "The template's category, when its name is in several.",
        },
      },
      ["image", "template"],
    ),
  },
  {
    name: "image_delete",
    description:
      "Delete an image, its directory and the logs of its starts. Nothing " +
      "asks for a confirmation. A running image is refused: stop it first " +
      "with process_kill.",
    inputSchema: objectSchema({ image: imageSchema }, ["image"]),
  },
  {
    name: "image_info",
    description:
      "Describe an image of this Launcher: its path, Pharo version, " +
      "architecture, template and whether it runs.",
    inputSchema: objectSchema({ image: imageSchema }, ["image"]),
  },
  {
    name: "image_list",
    description:
      "List this Launcher's images, each with its Pharo version, architecture, " +
      "template and whether it runs. nameFilter keeps the images whose name " +
      "contains it.",
    inputSchema: objectSchema({ nameFilter: stringSchema }),
  },
  {
    name: "image_start",
    description:
      "Start an image, optionally with a script for it to run. Unless " +
      "detached, the call waits for the image to quit. When the call's time " +
      "is up, a profile's image is stopped; outside a profile the call stops " +
      "waiting, and the image goes on.",
    inputSchema: objectSchema(
      {
        image: imageSchema,
        script: {
          ...stringSchema,
          description:
            "A script for the image to run. A relative path is read from this " +
            "server's working directory.",
        },
        detached: booleanSchema,
        displayMode: displayModeSchema,
      },
      ["image"],
    ),
  },
  {
    name: "process_kill",
    description:
      "Kill a process running an image of this Launcher, by pid or by image. " +
      "A pid stops that process alone; an image stops every process running it.",
    inputSchema: objectSchema({ image: imageSchema, pid: { type: "integer", minimum: 1 } }),
  },
  {
    name: "process_list",
    description: "List the Pharo processes running an image of this Launcher, by image and pid.",
    inputSchema: emptyInputSchema,
  },
  {
    name: "template_category_list",
    description: "List the template categories.",
    inputSchema: emptyInputSchema,
  },
  {
    name: "template_list",
    description: "List the templates of a category, by default the Launcher's default one.",
    inputSchema: objectSchema({ category: stringSchema }),
  },
  {
    name: "template_update",
    description: "Refresh the template list from the Pharo Launcher's sources.",
    inputSchema: emptyInputSchema,
  },
];
