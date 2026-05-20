export interface LauncherCommandTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  buildArgs: (input: unknown) => string[];
}

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

const emptyInputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

const stringSchema = { type: "string", minLength: 1 } as const;
const booleanSchema = { type: "boolean" } as const;
const confirmationSchema = {
  type: "boolean",
  const: true,
  description: "Must be true for destructive actions.",
} as const;
const formatSchema = {
  type: "string",
  enum: ["ston", "text"],
  default: "ston",
} as const;
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

const tableProperties = {
  format: formatSchema,
  brief: booleanSchema,
  rowMode: booleanSchema,
  delimiter: stringSchema,
} as const;

function inputObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  return input as Record<string, unknown>;
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new ToolInputError(`${key} must be a non-empty string`);
  }

  return value;
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = optionalString(input, key);
  if (!value) {
    throw new ToolInputError(`${key} is required`);
  }

  return value;
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

function requireConfirmation(input: Record<string, unknown>, toolName: string): void {
  if (input.confirm !== true) {
    throw new ToolInputError(`${toolName} requires confirm: true`);
  }
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

function addTableOptions(args: string[], input: Record<string, unknown>): void {
  addFlag(args, "--brief", optionalBoolean(input, "brief"));
  addFlag(args, "--rowMode", optionalBoolean(input, "rowMode"));
  addOption(args, "--delimiter", optionalString(input, "delimiter"));

  const format = optionalString(input, "format") ?? "ston";
  if (format !== "ston" && format !== "text") {
    throw new ToolInputError("format must be ston or text");
  }

  if (format === "ston") {
    args.push("--ston");
  }
}

function imageList(input: unknown): string[] {
  const object = inputObject(input);
  const args = ["image", "list"];
  addOption(args, "--nameFilter", optionalString(object, "nameFilter"));
  addTableOptions(args, object);
  return args;
}

function imageInfo(input: unknown): string[] {
  const object = inputObject(input);
  const args = ["image", "info"];
  addTableOptions(args, object);
  args.push(requiredString(object, "imageName"));
  return args;
}

function imageCreate(input: unknown): string[] {
  const object = inputObject(input);
  const args = ["image", "create"];
  addFlag(args, "--dev", optionalBoolean(object, "dev"));
  addFlag(args, "--no-launch", optionalBoolean(object, "noLaunch"));
  addOption(args, "--templateName", requiredString(object, "templateName"));
  addOption(args, "--templateCategory", optionalString(object, "templateCategory"));
  args.push(requiredString(object, "newImageName"));
  return args;
}

function imageCreateFromBuild(input: unknown): string[] {
  const object = inputObject(input);
  const args = ["image", "create", "fromBuild"];
  addOption(args, "--pharoVersion", optionalStringOrNumber(object, "pharoVersion"));
  addOption(args, "--newImageName", optionalString(object, "newImageName"));
  const buildNumber = optionalStringOrNumber(object, "buildNumber");
  if (buildNumber) {
    args.push(buildNumber);
  }
  return args;
}

function imageCreateFromPullRequest(input: unknown): string[] {
  const object = inputObject(input);
  const args = ["image", "create", "fromPR"];
  addOption(args, "--newImageName", optionalString(object, "newImageName"));
  addOption(args, "--templateName", optionalString(object, "templateName"));
  addOption(args, "--templateCategory", optionalString(object, "templateCategory"));
  const pullRequest = optionalStringOrNumber(object, "pullRequest");
  if (pullRequest) {
    args.push(pullRequest);
  }
  return args;
}

function imageCreateFromRepo(input: unknown): string[] {
  const object = inputObject(input);
  const args = ["image", "create", "fromRepo"];
  addOption(args, "--newImageName", optionalString(object, "newImageName"));
  addOption(args, "--templateName", optionalString(object, "templateName"));
  addOption(args, "--templateCategory", optionalString(object, "templateCategory"));
  addOption(args, "--subfolder", optionalString(object, "subfolder"));
  addOption(args, "--baseline", optionalString(object, "baseline"));
  addOption(args, "--group", optionalString(object, "group"));
  const repository = optionalString(object, "repository");
  if (repository) {
    args.push(repository);
  }
  return args;
}

function imageCreateFromSha(input: unknown): string[] {
  const object = inputObject(input);
  const args = ["image", "create", "fromSHA"];
  addOption(args, "--pharoVersion", optionalStringOrNumber(object, "pharoVersion"));
  addOption(args, "--newImageName", optionalString(object, "newImageName"));
  const sha = optionalString(object, "sha");
  if (sha) {
    args.push(sha);
  }
  return args;
}

function imageDelete(input: unknown): string[] {
  const object = inputObject(input);
  requireConfirmation(object, "pharo_launcher_image_delete");
  const args = ["image", "delete"];
  addFlag(args, "--force", optionalBoolean(object, "force"));
  args.push(requiredString(object, "imageName"));
  return args;
}

function imageLaunch(input: unknown): string[] {
  const object = inputObject(input);
  const args = ["image", "launch"];
  addOption(args, "--script", optionalString(object, "script"));
  addOption(args, "--displayMode", optionalDisplayMode(object));
  addFlag(args, "--detached", optionalBoolean(object, "detached"));
  args.push(requiredString(object, "imageName"));
  return args;
}

function imagePackage(input: unknown): string[] {
  const object = inputObject(input);
  const args = ["image", "package"];
  addFlag(args, "--zip", optionalBoolean(object, "zip"));
  addOption(args, "--vm", optionalString(object, "vm"));
  args.push(requiredString(object, "imageName"));
  args.push(requiredString(object, "location"));
  return args;
}

function imageRecreate(input: unknown): string[] {
  const object = inputObject(input);
  requireConfirmation(object, "pharo_launcher_image_recreate");
  return ["image", "recreate", requiredString(object, "imageName")];
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

function imageBisect(input: unknown): string[] {
  const object = inputObject(input);
  const args = ["image", "bisect"];
  addOption(args, "--pharoVersion", optionalStringOrNumber(object, "pharoVersion"));
  return args;
}

function processKill(input: unknown): string[] {
  const object = inputObject(input);
  requireConfirmation(object, "pharo_launcher_process_kill");
  const args = ["process", "kill"];
  const pid = optionalStringOrNumber(object, "pid");
  const imageName = optionalString(object, "imageName");

  if (pid && imageName) {
    throw new ToolInputError(
      "pharo_launcher_process_kill requires exactly one of pid or imageName",
    );
  }

  const target = pid ?? imageName;
  if (!target) {
    throw new ToolInputError(
      "pharo_launcher_process_kill requires pid or imageName",
    );
  }

  args.push(target);
  return args;
}

function templateCategoryList(input: unknown): string[] {
  const object = inputObject(input);
  const args = ["template", "categories"];
  addTableOptions(args, object);
  return args;
}

function templateInfo(input: unknown): string[] {
  const object = inputObject(input);
  const args = ["template", "info"];
  addOption(args, "--templateCategory", optionalString(object, "templateCategory"));
  const templateName = optionalString(object, "templateName");
  if (templateName) {
    args.push(templateName);
  }
  return args;
}

function templateList(input: unknown): string[] {
  const object = inputObject(input);
  const args = ["template", "list"];
  addOption(args, "--templateCategory", optionalString(object, "templateCategory"));
  addTableOptions(args, object);
  return args;
}

function vmDelete(input: unknown): string[] {
  const object = inputObject(input);
  requireConfirmation(object, "pharo_launcher_vm_delete");
  return ["vm", "delete", requiredString(object, "vmId")];
}

function vmInfo(input: unknown): string[] {
  const object = inputObject(input);
  const args = ["vm", "info"];
  const vmId = optionalString(object, "vmId");
  if (vmId) {
    args.push(vmId);
  }
  return args;
}

function vmList(input: unknown): string[] {
  const object = inputObject(input);
  const args = ["vm", "list"];
  addTableOptions(args, object);
  const vmId = optionalString(object, "vmId");
  if (vmId) {
    args.push(vmId);
  }
  return args;
}

function vmUpdate(input: unknown): string[] {
  const object = inputObject(input);
  const args = ["vm", "update"];
  const vmId = optionalString(object, "vmId");
  if (vmId) {
    args.push(vmId);
  }
  return args;
}

export const launcherCommandTools: LauncherCommandTool[] = [
  {
    name: "pharo_launcher_image_bisect",
    description:
      "Run PharoLauncher image bisect. This command may require interactive CLI input.",
    inputSchema: objectSchema({ pharoVersion: { anyOf: [stringSchema, { type: "number" }] } }),
    buildArgs: imageBisect,
  },
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
      "Create a new local image from a caller-selected template and image name.",
    inputSchema: objectSchema(
      {
        newImageName: stringSchema,
        dev: booleanSchema,
        noLaunch: booleanSchema,
        templateName: stringSchema,
        templateCategory: stringSchema,
      },
      ["newImageName", "templateName"],
    ),
    buildArgs: imageCreate,
  },
  {
    name: "pharo_launcher_image_create_from_build",
    description: "Create a new image from a Pharo build number.",
    inputSchema: objectSchema({
      buildNumber: { anyOf: [stringSchema, { type: "number" }] },
      pharoVersion: { anyOf: [stringSchema, { type: "number" }] },
      newImageName: stringSchema,
    }),
    buildArgs: imageCreateFromBuild,
  },
  {
    name: "pharo_launcher_image_create_from_pull_request",
    description: "Create a new image from a Pharo pull request build.",
    inputSchema: objectSchema({
      pullRequest: { anyOf: [stringSchema, { type: "number" }] },
      newImageName: stringSchema,
      templateName: stringSchema,
      templateCategory: stringSchema,
    }),
    buildArgs: imageCreateFromPullRequest,
  },
  {
    name: "pharo_launcher_image_create_from_repo",
    description: "Create a new image from a template and load a GitHub repository.",
    inputSchema: objectSchema({
      repository: stringSchema,
      newImageName: stringSchema,
      templateName: stringSchema,
      templateCategory: stringSchema,
      subfolder: stringSchema,
      baseline: stringSchema,
      group: stringSchema,
    }),
    buildArgs: imageCreateFromRepo,
  },
  {
    name: "pharo_launcher_image_create_from_sha",
    description: "Create a new image from a Pharo build commit SHA.",
    inputSchema: objectSchema({
      sha: stringSchema,
      pharoVersion: { anyOf: [stringSchema, { type: "number" }] },
      newImageName: stringSchema,
    }),
    buildArgs: imageCreateFromSha,
  },
  {
    name: "pharo_launcher_image_delete",
    description: "Delete a local image. Requires imageName and confirm: true.",
    inputSchema: objectSchema(
      {
        imageName: stringSchema,
        force: booleanSchema,
        confirm: confirmationSchema,
      },
      ["imageName", "confirm"],
    ),
    buildArgs: imageDelete,
  },
  {
    name: "pharo_launcher_image_info",
    description: "Print information about an image.",
    inputSchema: objectSchema(
      {
        imageName: stringSchema,
        ...tableProperties,
      },
      ["imageName"],
    ),
    buildArgs: imageInfo,
  },
  {
    name: "pharo_launcher_image_launch",
    description: "Launch an image, optionally with a launch script.",
    inputSchema: objectSchema(
      {
        imageName: stringSchema,
        script: stringSchema,
        detached: booleanSchema,
        displayMode: displayModeSchema,
      },
      ["imageName"],
    ),
    buildArgs: imageLaunch,
  },
  {
    name: "pharo_launcher_image_list",
    description: "List local images.",
    inputSchema: objectSchema({
      nameFilter: stringSchema,
      ...tableProperties,
    }),
    buildArgs: imageList,
  },
  {
    name: "pharo_launcher_image_package",
    description: "Create a package containing the image and launch artefacts.",
    inputSchema: objectSchema(
      {
        imageName: stringSchema,
        location: stringSchema,
        zip: booleanSchema,
        vm: stringSchema,
      },
      ["imageName", "location"],
    ),
    buildArgs: imagePackage,
  },
  {
    name: "pharo_launcher_image_recreate",
    description: "Recreate a local image. Requires imageName and confirm: true.",
    inputSchema: objectSchema(
      {
        imageName: stringSchema,
        confirm: confirmationSchema,
      },
      ["imageName", "confirm"],
    ),
    buildArgs: imageRecreate,
  },
  {
    name: "pharo_launcher_process_kill",
    description:
      "Kill a running Pharo process by image name or PID. Requires confirm: true.",
    inputSchema: objectSchema(
      {
        imageName: stringSchema,
        pid: { anyOf: [stringSchema, { type: "number" }] },
        confirm: confirmationSchema,
      },
      ["confirm"],
    ),
    buildArgs: processKill,
  },
  {
    name: "pharo_launcher_process_list",
    description: "List running Pharo image processes.",
    inputSchema: emptyInputSchema,
    buildArgs: () => ["process", "list"],
  },
  {
    name: "pharo_launcher_template_category_list",
    description: "List template categories.",
    inputSchema: objectSchema(tableProperties),
    buildArgs: templateCategoryList,
  },
  {
    name: "pharo_launcher_template_info",
    description: "Print information about an image template.",
    inputSchema: objectSchema({
      templateName: stringSchema,
      templateCategory: stringSchema,
    }),
    buildArgs: templateInfo,
  },
  {
    name: "pharo_launcher_template_list",
    description: "List image templates.",
    inputSchema: objectSchema({
      templateCategory: stringSchema,
      ...tableProperties,
    }),
    buildArgs: templateList,
  },
  {
    name: "pharo_launcher_template_update",
    description: "Update the template sources list.",
    inputSchema: emptyInputSchema,
    buildArgs: () => ["template", "update"],
  },
  {
    name: "pharo_launcher_vm_delete",
    description: "Delete a VM executable and dependencies. Requires confirm: true.",
    inputSchema: objectSchema(
      {
        vmId: stringSchema,
        confirm: confirmationSchema,
      },
      ["vmId", "confirm"],
    ),
    buildArgs: vmDelete,
  },
  {
    name: "pharo_launcher_vm_info",
    description: "Print information about a VM.",
    inputSchema: objectSchema({ vmId: stringSchema }),
    buildArgs: vmInfo,
  },
  {
    name: "pharo_launcher_vm_list",
    description: "List available VMs.",
    inputSchema: objectSchema({
      vmId: stringSchema,
      ...tableProperties,
    }),
    buildArgs: vmList,
  },
  {
    name: "pharo_launcher_vm_update",
    description: "Update a VM executable and dependencies.",
    inputSchema: objectSchema({ vmId: stringSchema }),
    buildArgs: vmUpdate,
  },
];

export const launcherCommandToolByName = new Map(
  launcherCommandTools.map((tool) => [tool.name, tool]),
);

export function buildLauncherCommandArgs(name: string, input: unknown): string[] | undefined {
  return launcherCommandToolByName.get(name)?.buildArgs(input);
}

export function rawCommandArgs(input: unknown): string[] {
  const object = inputObject(input);
  const args = object.args;
  if (!Array.isArray(args) || args.length === 0) {
    throw new ToolInputError(
      "pharo_launcher_raw_command requires a non-empty args array",
    );
  }

  if (!args.every((arg) => typeof arg === "string" && arg.length > 0)) {
    throw new ToolInputError(
      "pharo_launcher_raw_command args must be non-empty strings",
    );
  }

  if (object.confirm !== true) {
    throw new ToolInputError("pharo_launcher_raw_command requires confirm: true");
  }

  return [...args];
}

export const rawCommandTool: LauncherCommandTool = {
  name: "pharo_launcher_raw_command",
  description:
    "Run raw PharoLauncher clap args as an escape hatch. Requires confirm: true.",
  inputSchema: objectSchema(
    {
      args: {
        type: "array",
        items: stringSchema,
        minItems: 1,
      },
      confirm: confirmationSchema,
    },
    ["args", "confirm"],
  ),
  buildArgs: rawCommandArgs,
};
