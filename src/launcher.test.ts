import { describe, expect, it } from "vitest";
import type { LauncherCliRunner } from "./discovery.js";
import { openPharoLauncher, type PharoLauncher } from "./launcher.js";
import { toolNames } from "./server.js";

function stdout(text: string): LauncherCliRunner {
  return async () => ({
    exitCode: 0,
    stdout: text,
    stderr: "",
    durationMs: 1,
    timedOut: false,
  });
}

// The tool names exist because MCP needs strings. The functions exist because
// a consumer in the same process does not. Neither list generates the other,
// so this is what keeps them level.
const functionForTool: Record<string, keyof PharoLauncher> = {
  pharo_launcher_config: "describeConfig",
  pharo_launcher_image_copy_between_profiles: "copyImageBetweenProfiles",
  pharo_launcher_image_copy: "copyImage",
  pharo_launcher_image_create: "createImage",
  pharo_launcher_image_delete: "deleteImage",
  pharo_launcher_image_info: "imageInfo",
  pharo_launcher_image_list: "listImages",
  pharo_launcher_image_start: "startImage",
  pharo_launcher_process_kill: "killProcess",
  pharo_launcher_process_list: "listProcesses",
  pharo_launcher_template_category_list: "listTemplateCategories",
  pharo_launcher_template_list: "listTemplates",
  pharo_launcher_template_update: "updateTemplates",
};

describe("openPharoLauncher", () => {
  it("has a function for every tool the server advertises, and no more", () => {
    const launcher = openPharoLauncher();

    for (const name of toolNames) {
      const functionName = functionForTool[name];
      expect(functionName, `${name} has no library function`).toBeDefined();
      expect(typeof launcher[functionName!]).toBe("function");
    }

    expect(Object.keys(functionForTool).sort()).toEqual([...toolNames].sort());
  });

  it("answers with the normalized result, not an MCP envelope", async () => {
    const launcher = openPharoLauncher({
      runner: stdout(
        "OrderedCollection[PhLImage{#vmManager:PhLVirtualMachineManager{#imageFile:FileLocator{#path:RelativePath['Task','Task.image']}}}]",
      ),
    });

    const result = await launcher.listImages({ nameFilter: "Task" });

    expect(result.ok).toBe(true);
    expect(result.data?.map((image) => image.name)).toEqual(["Task"]);
    expect(result).not.toHaveProperty("content");
  });

  it("builds the command the catalog says, from typed arguments", async () => {
    const calls: string[][] = [];
    const launcher = openPharoLauncher({
      runner: async (args) => {
        calls.push([...args]);
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          durationMs: 1,
          timedOut: false,
        };
      },
      // A create is not done when PharoLauncher exits: it polls until the
      // image can be listed and inspected. This one never appears, and the
      // command it built is what the test is about.
      imageCopyVerificationTimeoutMs: 0,
      sleep: async () => {},
    });

    await launcher.createImage({
      templateName: "Pharo 13.0 - 64bit",
      newImageName: "Task",
      noLaunch: true,
    });

    expect(calls[0]?.slice(0, 2)).toEqual(["image", "create"]);
    expect(calls[0]).toContain("--no-launch");
    expect(calls[0]).toContain("Task");
  });

  it("refuses what the catalog refuses", async () => {
    const launcher = openPharoLauncher();

    await expect(
      launcher.killProcess({ pid: 1234, imageName: "Task" } as never),
    ).rejects.toThrow("requires exactly one of pid or imageName");
  });

  it("scopes to a profile from an environment, with no process of its own", () => {
    const launcher = openPharoLauncher({
      env: {
        PHARO_LAUNCHER_MCP_PROFILE: "isolated",
        PHARO_LAUNCHER_MCP_STATE_ROOT: "/tmp/plexus-profile",
      },
    });

    expect(launcher.describeConfig().profile?.name).toBe("isolated");
  });
});
