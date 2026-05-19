import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LauncherCliRunner } from "./discovery.js";
import { callTool } from "./server.js";

function parseJsonResult(result: Awaited<ReturnType<typeof callTool>>) {
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

function tempLauncherConfig() {
  const launcherDir = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-launcher-mcp-"));
  const launcherVm = path.join(launcherDir, "PharoConsole.exe");
  const launcherImage = path.join(launcherDir, "PharoLauncher.image");
  const launcherScript = path.join(launcherDir, "pharo-launcher.cmd");

  fs.writeFileSync(launcherVm, "");
  fs.writeFileSync(launcherImage, "");
  fs.writeFileSync(launcherScript, "");

  return {
    launcherDir,
    launcherVm,
    installationLauncherImage: launcherImage,
    launcherImage,
    launcherScript,
  };
}

function tempProfileConfig() {
  const baseConfig = tempLauncherConfig();
  const stateRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pharo-launcher-mcp-profile-"),
  );
  const profile = {
    name: "isolated",
    stateRoot,
    launcherImage: path.join(stateRoot, "launcher", "PharoLauncher.image"),
    imagesDir: path.join(stateRoot, "images"),
    vmsDir: path.join(stateRoot, "vms"),
    templateSourcesDir: path.join(stateRoot, "templates"),
    initScriptsDir: path.join(stateRoot, "init-scripts"),
    logsDir: path.join(stateRoot, "logs"),
  };

  fs.mkdirSync(path.dirname(profile.launcherImage), { recursive: true });
  fs.writeFileSync(profile.launcherImage, "");

  return {
    ...baseConfig,
    launcherImage: profile.launcherImage,
    launcherConfiguration: path.join(
      stateRoot,
      "launcher",
      "pharo-launcher-cli-config.ston",
    ),
    profile,
  };
}

describe("callTool", () => {
  const taskImageSton =
    "OrderedCollection[PhLImage{#formatNumber:68021,#architecture:'64',#pharoVersion:'130',#originTemplate:PhLRemoteTemplate{#name:'Pharo 13',#url:URL['https://example.test/latest.zip']},#vmManager:PhLVirtualMachineManager{#imageFile:FileLocator{#path:RelativePath['Task','Task.image']}},#launchConfigurations:OrderedCollection[PhLLaunchConfiguration{#vm:PhLVirtualMachine{#id:'130-x64'}}]}]";

  it("returns health without invoking PharoLauncher", async () => {
    const runner: LauncherCliRunner = async () => {
      throw new Error("runner should not be called");
    };
    const result = await callTool("pharo_launcher_health", {}, { runner });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain("\"service\": \"pharo-launcher-mcp\"");
  });

  it("returns resolved configuration without invoking PharoLauncher", async () => {
    const runner: LauncherCliRunner = async () => {
      throw new Error("runner should not be called");
    };
    const result = await callTool("pharo_launcher_config", {}, { runner });
    const body = parseJsonResult(result);

    expect(result.isError).toBeUndefined();
    expect(body).toHaveProperty("launcherDir");
    expect(body).toHaveProperty("launcherScript");
  });

  it("runs version through the runner", async () => {
    const runner: LauncherCliRunner = async (args) => ({
      exitCode: args[0] === "--version" ? 0 : 1,
      stdout: "Pharo Launcher 3.0.1",
      stderr: "",
      durationMs: 4,
      timedOut: false,
    });
    const result = await callTool("pharo_launcher_version", {}, { runner });
    const body = parseJsonResult(result);

    expect(result.isError).toBeUndefined();
    expect(body.ok).toBe(true);
    expect(body.version).toBe("3.0.1");
  });

  it("marks validation as an MCP tool error when the harmless call fails", async () => {
    const runner: LauncherCliRunner = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "not available",
      durationMs: 4,
      timedOut: false,
    });
    const result = await callTool("pharo_launcher_validate_installation", {}, {
      runner,
    });
    const body = parseJsonResult(result);

    expect(result.isError).toBe(true);
    expect(body.ok).toBe(false);
  });

  it("exposes inventory with caller-declared image handles", async () => {
    const config = tempLauncherConfig();
    const calls: readonly string[][] = [];
    const runner: LauncherCliRunner = async (args) => {
      (calls as string[][]).push([...args]);

      return {
        exitCode: 0,
        stdout:
          args[0] === "template"
            ? "OrderedCollection[PhLRemoteTemplate{#name:'Pharo 13',#category:'stable',#url:URL['https://example.test/130/latest.zip']}]"
            : "OrderedCollection[]",
        stderr: "",
        durationMs: 4,
        timedOut: false,
      };
    };

    const result = await callTool(
      "pharo_launcher_inventory",
      {
        declaredImages: [
          {
            imageId: "dev",
            imageName: "Workspace-dev",
            workspaceId: "workspace",
          },
        ],
      },
      { runner, config },
    );
    const body = parseJsonResult(result);

    fs.rmSync(config.launcherDir, { recursive: true, force: true });
    expect(result.isError).toBeUndefined();
    expect(body).toMatchObject({
      ok: true,
      service: "pharo-launcher-mcp",
      templates: {
        installed: [],
        downloadable: [
          {
            name: "Pharo 13",
            category: "stable",
            pharoVersion: "130",
          },
        ],
      },
      images: {
        existing: [],
        declared: [
          {
            imageId: "dev",
            imageName: "Workspace-dev",
            workspaceId: "workspace",
          },
        ],
      },
    });
    expect(calls).toEqual([
      ["template", "list", "--ston"],
      ["image", "list", "--ston"],
    ]);
  });

  it("verifies copied images with list and info before reporting success", async () => {
    const calls: readonly string[][] = [];
    const runner: LauncherCliRunner = async (args) => {
      (calls as string[][]).push([...args]);

      return {
        exitCode: 0,
        stdout:
          args[0] === "image" && args[1] === "copy"
            ? "Copied"
            : taskImageSton,
        stderr: "",
        durationMs: 4,
        timedOut: false,
      };
    };

    const result = await callTool(
      "pharo_launcher_image_copy",
      {
        imageName: "Base",
        newImageName: "Task",
      },
      { runner },
    );

    expect(result.isError).toBeUndefined();
    const body = parseJsonResult(result);
    expect(body).toMatchObject({
      ok: true,
      parser: {
        status: "unsupported",
        format: "text",
      },
      raw: {
        stdout: "Copied",
        stderr: "",
        format: "text",
      },
      command: {
        args: ["image", "copy", "Base", "Task"],
        durationMs: 4,
        exitCode: 0,
      },
      data: {
        message: "Copied",
        targetImageName: "Task",
        listedImage: {
          name: "Task",
        },
        inspectedImage: {
          name: "Task",
        },
      },
      copyVerification: {
        ok: true,
        targetImageName: "Task",
        attempts: 1,
      },
    });
    expect(calls).toEqual([
      ["image", "copy", "Base", "Task"],
      ["image", "list", "--nameFilter", "Task", "--ston"],
      ["image", "info", "--ston", "Task"],
    ]);
  });

  it("fails copied images that are not discoverable", async () => {
    const calls: readonly string[][] = [];
    const runner: LauncherCliRunner = async (args) => {
      (calls as string[][]).push([...args]);

      return {
        exitCode: 0,
        stdout:
          args[0] === "image" && args[1] === "copy"
            ? "Copied"
            : "OrderedCollection[]",
        stderr: "",
        durationMs: 4,
        timedOut: false,
      };
    };

    const result = await callTool(
      "pharo_launcher_image_copy",
      {
        imageName: "Base",
        newImageName: "Task",
      },
      {
        runner,
        imageCopyVerificationTimeoutMs: 0,
        imageCopyVerificationPollMs: 0,
      },
    );
    const body = parseJsonResult(result);

    expect(result.isError).toBe(true);
    expect(body).toMatchObject({
      ok: false,
      diagnostic:
        "Image copy command exited successfully, but target image Task was not listable and inspectable: Copied image did not appear in image list.",
      raw: {
        stdout: "Copied",
        stderr: "",
      },
      copyVerification: {
        ok: false,
        targetImageName: "Task",
        attempts: 1,
        list: {
          ok: true,
          data: [],
          raw: {
            stdout: "OrderedCollection[]",
          },
        },
      },
    });
    expect(calls).toEqual([
      ["image", "copy", "Base", "Task"],
      ["image", "list", "--nameFilter", "Task", "--ston"],
    ]);
  });

  it("runs typed launcher read tools through the runner", async () => {
    const calls: readonly string[][] = [];
    const runner: LauncherCliRunner = async (args) => {
      (calls as string[][]).push([...args]);

      return {
        exitCode: 0,
        stdout: "[]",
        stderr: "",
        durationMs: 4,
        timedOut: false,
      };
    };

    const result = await callTool(
      "pharo_launcher_image_list",
      { format: "ston" },
      { runner },
    );

    expect(result.isError).toBeUndefined();
    const body = parseJsonResult(result);
    expect(body).toMatchObject({
      ok: true,
      parser: {
        status: "parsed",
        format: "ston",
      },
      raw: {
        stdout: "[]",
        stderr: "",
        format: "ston",
      },
      command: {
        args: ["image", "list", "--ston"],
        durationMs: 4,
        exitCode: 0,
      },
    });
    expect(calls).toEqual([["image", "list", "--ston"]]);
  });

  it("returns normalized data for read tools", async () => {
    const runner: LauncherCliRunner = async () => ({
      exitCode: 0,
      stdout:
        "OrderedCollection[PhLImage{#formatNumber:68021,#architecture:'64',#pharoVersion:'130',#originTemplate:PhLRemoteTemplate{#name:'Pharo 13',#url:URL['https://example.test/latest.zip']},#vmManager:PhLVirtualMachineManager{#imageFile:FileLocator{#path:RelativePath['Task','Task.image']}},#launchConfigurations:OrderedCollection[PhLLaunchConfiguration{#vm:PhLVirtualMachine{#id:'130-x64'}}]}]",
      stderr: "",
      durationMs: 4,
      timedOut: false,
    });

    const result = await callTool(
      "pharo_launcher_image_list",
      { format: "ston" },
      { runner },
    );
    const body = parseJsonResult(result);

    expect(body).toMatchObject({
      ok: true,
      data: [
        {
          name: "Task",
          architecture: "64",
          pharoVersion: "130",
          imagePath: "Task/Task.image",
          vmId: "130-x64",
        },
      ],
      raw: {
        format: "ston",
      },
      parser: {
        status: "parsed",
        format: "ston",
      },
    });
  });

  it("returns tool errors for invalid typed launcher input", async () => {
    const runner: LauncherCliRunner = async () => {
      throw new Error("runner should not be called");
    };

    const result = await callTool(
      "pharo_launcher_image_delete",
      {
        imageName: "Task",
      },
      { runner },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("requires confirm: true");
  });

  it("bootstraps scoped template sources after template update", async () => {
    const config = tempProfileConfig();
    const calls: readonly string[][] = [];
    const runner: LauncherCliRunner = async (args) => {
      (calls as string[][]).push([...args]);
      if (args[0] === "template" && args[1] === "update") {
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          durationMs: 4,
          timedOut: false,
        };
      }

      return {
        exitCode: 0,
        stdout:
          "OrderedCollection[PhLRemoteTemplate{#name:'Pharo 13',#category:'stable',#url:URL['https://example.test/130/latest.zip']}]",
        stderr: "",
        durationMs: 4,
        timedOut: false,
      };
    };

    const result = await callTool("pharo_launcher_template_update", {}, {
      config,
      runner,
      fetchTemplateSources: async () =>
        "https://files.pharo.org/image/130/latest-64.zip",
    });
    const body = parseJsonResult(result);
    const sourcesFile = path.join(config.profile.templateSourcesDir, "sources.list");

    expect(result.isError).toBeUndefined();
    expect(fs.readFileSync(sourcesFile, "utf8")).toContain("latest-64.zip");
    expect(body).toMatchObject({
      ok: true,
      command: {
        args: ["template", "update"],
      },
      templateSourcesBootstrap: {
        ok: true,
        action: "created",
        path: sourcesFile,
      },
      templateSourcesProbe: {
        ok: true,
      },
    });
    expect(calls).toEqual([
      ["template", "update"],
      ["template", "list", "--ston"],
    ]);

    fs.rmSync(config.profile.stateRoot, { recursive: true, force: true });
  });

  it("fails template update when scoped template source bootstrap fails", async () => {
    const config = tempProfileConfig();
    const calls: readonly string[][] = [];
    const runner: LauncherCliRunner = async (args) => {
      (calls as string[][]).push([...args]);

      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 4,
        timedOut: false,
      };
    };

    const result = await callTool("pharo_launcher_template_update", {}, {
      config,
      runner,
      fetchTemplateSources: async () => {
        throw new Error("network unavailable");
      },
    });
    const body = parseJsonResult(result);

    expect(result.isError).toBe(true);
    expect(body).toMatchObject({
      ok: false,
      diagnostic: expect.stringContaining("bootstrap file is missing or empty"),
      templateSourcesBootstrap: {
        ok: false,
        action: "failed",
        path: path.join(config.profile.templateSourcesDir, "sources.list"),
        error: "network unavailable",
      },
    });
    expect(calls).toEqual([["template", "update"]]);

    fs.rmSync(config.profile.stateRoot, { recursive: true, force: true });
  });

  it("keeps raw command access behind pharo_launcher_raw_command", async () => {
    const calls: readonly string[][] = [];
    const runner: LauncherCliRunner = async (args) => {
      (calls as string[][]).push([...args]);

      return {
        exitCode: 0,
        stdout: "raw",
        stderr: "",
        durationMs: 4,
        timedOut: false,
      };
    };

    const result = await callTool(
      "pharo_launcher_raw_command",
      {
        args: ["image", "list"],
        confirm: true,
      },
      { runner },
    );

    expect(result.isError).toBeUndefined();
    expect(calls).toEqual([["image", "list"]]);
  });

  it("reports unknown tools as MCP tool errors", async () => {
    const result = await callTool("missing_tool", {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Unknown tool");
  });
});
