import path from "node:path";
import { describe, expect, it } from "vitest";
import { commandArgs, launcherCommandTools } from "./commandCatalog.js";

const stable = "Pharo 13.0 - 64bit (stable)";

describe("launcher command catalog", () => {
  it("registers the tools, named after what they do", () => {
    expect(launcherCommandTools.map((tool) => tool.name)).toEqual([
      "image_copy",
      "image_create",
      "image_delete",
      "image_info",
      "image_list",
      "image_start",
      "process_kill",
      "process_list",
      "template_category_list",
      "template_list",
      "template_update",
    ]);
  });

  // No task drew them, and a model reads a schema as what matters.
  it.each(launcherCommandTools.map((tool) => [tool.name, tool] as const))(
    "advertises no table option, no raw output and no confirmation on %s",
    (_name, tool) => {
      const properties = Object.keys(tool.inputSchema.properties as object);
      for (const option of [
        "includeRaw",
        "format",
        "brief",
        "rowMode",
        "delimiter",
        "noLaunch",
        "force",
        "confirm",
        "dev",
      ]) {
        expect(properties).not.toContain(option);
      }
    },
  );

  it("names the image `image` in every tool that takes one", () => {
    for (const tool of launcherCommandTools) {
      const properties = Object.keys(tool.inputSchema.properties as object);
      expect(properties).not.toContain("imageName");
      expect(properties).not.toContain("newImageName");
    }
  });

  it.each([
    ["copyImage", { image: "Base", newImage: "Task" }, ["image", "copy", "Base", "Task"]],
    [
      "createImage",
      { image: "Task", template: stable },
      ["image", "create", "--no-launch", "--templateName", stable, "Task"],
    ],
    [
      "createImage",
      { image: "Task", template: stable, category: "Official distributions" },
      [
        "image",
        "create",
        "--no-launch",
        "--templateName",
        stable,
        "--templateCategory",
        "Official distributions",
        "Task",
      ],
    ],
    [
      "startImage",
      { image: "Task", script: "bootstrap.st", detached: true },
      ["image", "launch", "--script", path.resolve("bootstrap.st"), "--detached", "Task"],
    ],
    [
      "startImage",
      { image: "Task", displayMode: "interactive" },
      ["image", "launch", "--displayMode", "interactive", "Task"],
    ],
    ["deleteImage", { image: "Task" }, ["image", "delete", "--force", "Task"]],
    ["killProcess", { image: "Task" }, ["process", "kill", "--image", "Task"]],
    ["killProcess", { image: "2025" }, ["process", "kill", "--image", "2025"]],
    ["killProcess", { pid: 1234 }, ["process", "kill", "--pid", "1234"]],
    ["killProcess", { pid: "1234" }, ["process", "kill", "--pid", "1234"]],
    ["listProcesses", {}, ["process", "list"]],
    ["listTemplateCategories", {}, ["template", "categories", "--brief"]],
    [
      "listTemplates",
      { category: "Official" },
      ["template", "list", "--templateCategory", "Official", "--ston"],
    ],
    ["listTemplates", {}, ["template", "list", "--ston"]],
    ["updateTemplates", {}, ["template", "update"]],
  ] as const)("builds %s's command from %j", (name, input, expected) => {
    expect((commandArgs[name] as (input: unknown) => string[])(input)).toEqual(expected);
  });

  it.each([
    ["createImage", { image: "Task" }, "template is required"],
    ["createImage", { template: stable }, "image is required"],
    ["copyImage", { newImage: "copy" }, "image is required"],
    ["startImage", { detached: true }, "image is required"],
    ["startImage", { image: "Task", displayMode: "visible" }, "displayMode must be headless or interactive"],
    ["deleteImage", {}, "image is required"],
    ["killProcess", {}, "Give the pid or the image of the process to kill."],
    ["killProcess", { image: "Task", pid: 1234 }, "Give pid or image, not both."],
    ["killProcess", { pid: "stuck" }, "pid must be a process id, a whole number"],
    ["killProcess", { pid: 0 }, "pid must be a process id, a whole number"],
  ] as const)("refuses %s given %j", (name, input, message) => {
    expect(() => (commandArgs[name] as (input: unknown) => string[])(input)).toThrow(message);
  });

  // Without --no-launch PharoLauncher starts the new image and waits for it to
  // quit; starting is a start's.
  it("never lets image create start the image", () => {
    expect(commandArgs.createImage({ image: "Task", template: stable, noLaunch: false })).toContain(
      "--no-launch",
    );
  });

  // The caller means its own directory. Passed on as it is, the path would be
  // read from the image's directory by the profile's VM, or from
  // PharoLauncher's by PharoLauncher.
  it("reads a relative launch script from the caller's directory", () => {
    const absolute = path.resolve("elsewhere", "check.st");

    expect(commandArgs.startImage({ image: "Task", script: "check.st" })).toEqual([
      "image",
      "launch",
      "--script",
      path.join(process.cwd(), "check.st"),
      "Task",
    ]);
    expect(commandArgs.startImage({ image: "Task", script: absolute })).toEqual([
      "image",
      "launch",
      "--script",
      absolute,
      "Task",
    ]);
  });
});
