import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildLauncherCommandArgs,
  launcherCommandTools,
} from "./commandCatalog.js";

describe("launcher command catalog", () => {
  it("registers the actions something asks for", () => {
    expect(launcherCommandTools.map((tool) => tool.name)).toEqual([
      "pharo_launcher_image_copy",
      "pharo_launcher_image_create",
      "pharo_launcher_image_delete",
      "pharo_launcher_image_info",
      "pharo_launcher_image_list",
      "pharo_launcher_image_start",
      "pharo_launcher_process_kill",
      "pharo_launcher_process_list",
      "pharo_launcher_template_category_list",
      "pharo_launcher_template_list",
      "pharo_launcher_template_update",
    ]);
  });

  it("covers the composable image lifecycle primitives", () => {
    const registeredToolNames = new Set(
      launcherCommandTools.map((tool) => tool.name),
    );
    const requiredToolNames = [
      "pharo_launcher_image_list",
      "pharo_launcher_template_list",
      "pharo_launcher_image_create",
      "pharo_launcher_image_copy",
      "pharo_launcher_image_start",
      "pharo_launcher_process_list",
      "pharo_launcher_process_kill",
      "pharo_launcher_image_info",
      "pharo_launcher_image_delete",
    ];

    expect(requiredToolNames.every((name) => registeredToolNames.has(name))).toBe(
      true,
    );
  });

  it("exposes the raw output opt-in on command-backed tools", () => {
    for (const tool of launcherCommandTools) {
      expect(tool.inputSchema.properties).toMatchObject({
        includeRaw: {
          type: "boolean",
        },
      });
    }
  });

  it.each([
    [
      "pharo_launcher_image_copy",
      { imageName: "Base", newImageName: "Task" },
      ["image", "copy", "Base", "Task"],
    ],
    [
      "pharo_launcher_image_create",
      {
        newImageName: "Task",
        noLaunch: true,
        templateName: "Pharo 13.0 - 64bit (stable)",
      },
      [
        "image",
        "create",
        "--no-launch",
        "--templateName",
        "Pharo 13.0 - 64bit (stable)",
        "Task",
      ],
    ],
    [
      "pharo_launcher_image_info",
      { imageName: "Task", format: "ston" },
      ["image", "info", "--ston", "Task"],
    ],
    [
      "pharo_launcher_image_start",
      { imageName: "Task", script: "bootstrap.st", detached: true },
      [
        "image",
        "launch",
        "--script",
        path.resolve("bootstrap.st"),
        "--detached",
        "Task",
      ],
    ],
    [
      "pharo_launcher_image_start",
      { imageName: "Task", displayMode: "interactive" },
      ["image", "launch", "--displayMode", "interactive", "Task"],
    ],
    [
      "pharo_launcher_image_list",
      { nameFilter: "Task", format: "text", brief: true },
      ["image", "list", "--nameFilter", "Task", "--brief"],
    ],
    [
      "pharo_launcher_process_list",
      {},
      ["process", "list"],
    ],
    [
      "pharo_launcher_template_category_list",
      { format: "ston" },
      ["template", "categories", "--ston"],
    ],
    [
      "pharo_launcher_template_list",
      { templateCategory: "Official", format: "text", rowMode: true },
      ["template", "list", "--templateCategory", "Official", "--rowMode"],
    ],
    [
      "pharo_launcher_template_update",
      {},
      ["template", "update"],
    ],
  ])("builds args for %s", (name, input, expected) => {
    expect(buildLauncherCommandArgs(name, input)).toEqual(expected);
  });

  it("requires caller-supplied names for template image creation", () => {
    expect(() =>
      buildLauncherCommandArgs("pharo_launcher_image_create", {
        newImageName: "caller-owned-image",
      }),
    ).toThrow("templateName is required");
    expect(() =>
      buildLauncherCommandArgs("pharo_launcher_image_create", {
        templateName: "Pharo 13.0 - 64bit (stable)",
      }),
    ).toThrow("newImageName is required");

    expect(
      buildLauncherCommandArgs("pharo_launcher_image_create", {
        templateName: "Pharo 13.0 - 64bit (stable)",
        newImageName: "caller-owned-image",
        noLaunch: true,
      }),
    ).toEqual([
      "image",
      "create",
      "--no-launch",
      "--templateName",
      "Pharo 13.0 - 64bit (stable)",
      "caller-owned-image",
    ]);
  });

  it("requires caller-supplied image names for image primitives", () => {
    expect(() =>
      buildLauncherCommandArgs("pharo_launcher_image_copy", {
        newImageName: "copy",
      }),
    ).toThrow("imageName is required");
    expect(() =>
      buildLauncherCommandArgs("pharo_launcher_image_info", {
        format: "ston",
      }),
    ).toThrow("imageName is required");
    expect(() =>
      buildLauncherCommandArgs("pharo_launcher_image_start", {
        detached: true,
      }),
    ).toThrow("imageName is required");
    expect(() =>
      buildLauncherCommandArgs("pharo_launcher_image_start", {
        imageName: "Task",
        displayMode: "visible",
      }),
    ).toThrow("displayMode must be headless or interactive");
  });

  it("builds destructive actions from their target alone", () => {
    expect(
      buildLauncherCommandArgs("pharo_launcher_image_delete", {
        imageName: "Task",
      }),
    ).toEqual(["image", "delete", "--force", "Task"]);

    expect(
      buildLauncherCommandArgs("pharo_launcher_process_kill", {
        imageName: "Task",
      }),
    ).toEqual(["process", "kill", "Task"]);

    expect(
      buildLauncherCommandArgs("pharo_launcher_process_kill", { pid: 1234 }),
    ).toEqual(["process", "kill", "1234"]);
  });

  // Callers built against the confirmation gate keep working: the server
  // validates no schema, so a key nothing reads is a key nothing trips over.
  it.each([{ confirm: true }, { force: true }, { force: false }])(
    "ignores %o left over from an older caller",
    (leftover) => {
      expect(
        buildLauncherCommandArgs("pharo_launcher_image_delete", {
          imageName: "Task",
          ...leftover,
        }),
      ).toEqual(["image", "delete", "--force", "Task"]);
    },
  );

  // PharoLauncher asks on standard input before a delete without --force,
  // and a call has nobody there to answer it.
  it("advertises no way to ask for a confirmation", () => {
    const deleteTool = launcherCommandTools.find(
      (tool) => tool.name === "pharo_launcher_image_delete",
    );

    expect(
      Object.keys((deleteTool?.inputSchema.properties ?? {}) as object),
    ).toEqual(["imageName", "includeRaw"]);
  });

  // The caller means its own directory. Passed on as it is, the path would be
  // read from the image's directory by the profile's VM, or from
  // PharoLauncher's by PharoLauncher.
  it("reads a relative launch script from the caller's directory", () => {
    const absolute = path.resolve("elsewhere", "check.st");

    expect(
      buildLauncherCommandArgs("pharo_launcher_image_start", {
        imageName: "Task",
        script: "check.st",
      }),
    ).toEqual([
      "image",
      "launch",
      "--script",
      path.join(process.cwd(), "check.st"),
      "Task",
    ]);
    expect(
      buildLauncherCommandArgs("pharo_launcher_image_start", {
        imageName: "Task",
        script: absolute,
      }),
    ).toEqual(["image", "launch", "--script", absolute, "Task"]);
  });

  it.each([
    "pharo_launcher_image_delete",
    "pharo_launcher_process_kill",
  ])("rejects empty input for destructive tool %s", (toolName) => {
    expect(() => buildLauncherCommandArgs(toolName, {})).toThrow();
  });

  it("rejects destructive calls without an explicit target", () => {
    expect(() =>
      buildLauncherCommandArgs("pharo_launcher_image_delete", {}),
    ).toThrow("imageName is required");
    expect(() =>
      buildLauncherCommandArgs("pharo_launcher_process_kill", {}),
    ).toThrow("requires pid or imageName");
  });

  it("rejects ambiguous process kill targets", () => {
    expect(() =>
      buildLauncherCommandArgs("pharo_launcher_process_kill", {
        imageName: "Task",
        pid: 1234,
      }),
    ).toThrow("requires exactly one of pid or imageName");
  });
});
