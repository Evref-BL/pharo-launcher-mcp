import { describe, expect, it } from "vitest";
import {
  buildLauncherCommandArgs,
  launcherCommandTools,
  rawCommandArgs,
} from "./commandCatalog.js";

describe("launcher command catalog", () => {
  it("registers every typed PharoLauncher action", () => {
    expect(launcherCommandTools.map((tool) => tool.name)).toEqual([
      "pharo_launcher_image_bisect",
      "pharo_launcher_image_copy",
      "pharo_launcher_image_create",
      "pharo_launcher_image_create_from_build",
      "pharo_launcher_image_create_from_pull_request",
      "pharo_launcher_image_create_from_repo",
      "pharo_launcher_image_create_from_sha",
      "pharo_launcher_image_delete",
      "pharo_launcher_image_info",
      "pharo_launcher_image_list",
      "pharo_launcher_image_package",
      "pharo_launcher_image_recreate",
      "pharo_launcher_image_start",
      "pharo_launcher_process_kill",
      "pharo_launcher_process_list",
      "pharo_launcher_template_category_list",
      "pharo_launcher_template_info",
      "pharo_launcher_template_list",
      "pharo_launcher_template_update",
      "pharo_launcher_vm_delete",
      "pharo_launcher_vm_info",
      "pharo_launcher_vm_list",
      "pharo_launcher_vm_update",
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
      "pharo_launcher_image_recreate",
      "pharo_launcher_image_package",
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
      "pharo_launcher_image_bisect",
      { pharoVersion: 130 },
      ["image", "bisect", "--pharoVersion", "130"],
    ],
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
      "pharo_launcher_image_create_from_build",
      { buildNumber: 123, pharoVersion: 130, newImageName: "Build123" },
      [
        "image",
        "create",
        "fromBuild",
        "--pharoVersion",
        "130",
        "--newImageName",
        "Build123",
        "123",
      ],
    ],
    [
      "pharo_launcher_image_create_from_pull_request",
      { pullRequest: 42, newImageName: "PR42" },
      ["image", "create", "fromPR", "--newImageName", "PR42", "42"],
    ],
    [
      "pharo_launcher_image_create_from_repo",
      {
        repository: "owner/project:branch",
        newImageName: "Repo",
        baseline: "Project",
        group: "default",
      },
      [
        "image",
        "create",
        "fromRepo",
        "--newImageName",
        "Repo",
        "--baseline",
        "Project",
        "--group",
        "default",
        "owner/project:branch",
      ],
    ],
    [
      "pharo_launcher_image_create_from_sha",
      { sha: "abcdef1", pharoVersion: 130 },
      ["image", "create", "fromSHA", "--pharoVersion", "130", "abcdef1"],
    ],
    [
      "pharo_launcher_image_info",
      { imageName: "Task", format: "ston" },
      ["image", "info", "--ston", "Task"],
    ],
    [
      "pharo_launcher_image_start",
      { imageName: "Task", script: "bootstrap.st", detached: true },
      ["image", "launch", "--script", "bootstrap.st", "--detached", "Task"],
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
      "pharo_launcher_image_package",
      { imageName: "Task", location: "C:\\out", zip: true, vm: "130-x64" },
      ["image", "package", "--zip", "--vm", "130-x64", "Task", "C:\\out"],
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
      "pharo_launcher_template_info",
      { templateName: "Pharo 13", templateCategory: "Official" },
      ["template", "info", "--templateCategory", "Official", "Pharo 13"],
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
    [
      "pharo_launcher_vm_info",
      { vmId: "130-x64" },
      ["vm", "info", "130-x64"],
    ],
    [
      "pharo_launcher_vm_list",
      { vmId: "130-x64", format: "ston" },
      ["vm", "list", "--ston", "130-x64"],
    ],
    [
      "pharo_launcher_vm_update",
      { vmId: "130-x64" },
      ["vm", "update", "130-x64"],
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
    expect(() =>
      buildLauncherCommandArgs("pharo_launcher_image_package", {
        location: "C:\\out",
      }),
    ).toThrow("imageName is required");
  });

  it("builds destructive actions from their target alone", () => {
    expect(
      buildLauncherCommandArgs("pharo_launcher_image_delete", {
        imageName: "Task",
        force: true,
      }),
    ).toEqual(["image", "delete", "--force", "Task"]);

    expect(
      buildLauncherCommandArgs("pharo_launcher_image_recreate", {
        imageName: "Task",
      }),
    ).toEqual(["image", "recreate", "Task"]);

    expect(
      buildLauncherCommandArgs("pharo_launcher_process_kill", {
        imageName: "Task",
      }),
    ).toEqual(["process", "kill", "Task"]);

    expect(
      buildLauncherCommandArgs("pharo_launcher_process_kill", { pid: 1234 }),
    ).toEqual(["process", "kill", "1234"]);

    expect(
      buildLauncherCommandArgs("pharo_launcher_vm_delete", { vmId: "130-x64" }),
    ).toEqual(["vm", "delete", "130-x64"]);
  });

  // Callers built against the confirmation gate keep working: the server
  // validates no schema, so a key nothing reads is a key nothing trips over.
  it("ignores a confirm argument left over from an older caller", () => {
    expect(
      buildLauncherCommandArgs("pharo_launcher_image_delete", {
        imageName: "Task",
        confirm: true,
      }),
    ).toEqual(["image", "delete", "Task"]);
    expect(rawCommandArgs({ args: ["image", "list"], confirm: true })).toEqual([
      "image",
      "list",
    ]);
  });

  it.each([
    "pharo_launcher_image_delete",
    "pharo_launcher_image_recreate",
    "pharo_launcher_process_kill",
    "pharo_launcher_vm_delete",
  ])("rejects empty input for destructive tool %s", (toolName) => {
    expect(() => buildLauncherCommandArgs(toolName, {})).toThrow();
  });

  it("rejects destructive calls without an explicit target", () => {
    expect(() =>
      buildLauncherCommandArgs("pharo_launcher_image_delete", {}),
    ).toThrow("imageName is required");
    expect(() =>
      buildLauncherCommandArgs("pharo_launcher_image_recreate", {}),
    ).toThrow("imageName is required");
    expect(() =>
      buildLauncherCommandArgs("pharo_launcher_process_kill", {}),
    ).toThrow("requires pid or imageName");
    expect(() =>
      buildLauncherCommandArgs("pharo_launcher_vm_delete", {}),
    ).toThrow("vmId is required");
  });

  it("rejects ambiguous process kill targets", () => {
    expect(() =>
      buildLauncherCommandArgs("pharo_launcher_process_kill", {
        imageName: "Task",
        pid: 1234,
      }),
    ).toThrow("requires exactly one of pid or imageName");
  });

  it("passes raw command args straight through", () => {
    expect(rawCommandArgs({ args: ["image", "list"] })).toEqual([
      "image",
      "list",
    ]);
    expect(() => rawCommandArgs({ args: [] })).toThrow(
      "requires a non-empty args array",
    );
  });
});
