import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { LauncherCliRunner } from "./discovery.js";
import { callTool, createServer } from "./server.js";
import { cliMetaInf, psRunner, writeImage } from "./testing/images.js";

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

function writeProfileImage(stateRoot: string, imageName: string): void {
  const directory = path.join(stateRoot, "images", imageName);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${imageName}.image`), "");
  fs.writeFileSync(
    path.join(directory, "meta-inf.ston"),
    [
      "PhLImage {",
      "\t#vmManager : PhLVirtualMachineManager {",
      "\t\t#imageFile : FileLocator {",
      `\t\t\t#path : RelativePath [ '${imageName}', '${imageName}.image' ],`,
      "\t\t\t#origin : #launcherImagesLocation",
      "\t\t}",
      "\t}",
      "}",
      "",
    ].join("\n"),
  );
}

function removeConfig(config: ReturnType<typeof tempProfileConfig>): void {
  fs.rmSync(config.profile.stateRoot, { recursive: true, force: true });
  fs.rmSync(config.launcherDir, { recursive: true, force: true });
}

function writeCreatedImage(imagesDir: string, imageName: string): void {
  writeImage(imagesDir, imageName, {
    metaInf: cliMetaInf("Pharo 13", "https://example.test/130/latest.zip"),
    pharoVersion: "130",
  });
}

describe("callTool", () => {

  it("announces the version the package was published with", async () => {
    const packaged = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    const client = new Client({ name: "probe", version: "0.0.0" }, {});
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await createServer().connect(serverTransport);
    await client.connect(clientTransport);

    // The health tool used to report this. Initialize is where it lives now,
    // and it is still read from package.json rather than kept by hand.
    expect(client.getServerVersion()?.version).toBe(packaged.version);
    await client.close();
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

  it("verifies copied images with the images directory and image info", async () => {
    const config = tempProfileConfig();
    const calls: string[][] = [];
    const runner: LauncherCliRunner = async (args) => {
      calls.push([...args]);
      if (args[1] === "copy") {
        writeCreatedImage(config.profile.imagesDir, "Task");
      }

      return { exitCode: 0, stdout: "Copied", stderr: "", durationMs: 4, timedOut: false };
    };

    try {
      const result = await callTool(
        "pharo_launcher_image_copy",
        { imageName: "Base", newImageName: "Task" },
        { runner, config },
      );

      expect(result.isError).toBeUndefined();
      expect(parseJsonResult(result)).toMatchObject({
        ok: true,
        command: { args: ["image", "copy", "Base", "Task"], exitCode: 0 },
        data: { image: { name: "Task", pharoVersion: "130" } },
      });
      expect(calls).toEqual([
        ["image", "copy", "Base", "Task"],
        ["image", "info", "Task"],
      ]);
    } finally {
      removeConfig(config);
    }
  });

  it("fails copied images that are not in the images directory", async () => {
    const config = tempProfileConfig();
    const calls: string[][] = [];
    const runner: LauncherCliRunner = async (args) => {
      calls.push([...args]);
      return { exitCode: 0, stdout: "Copied", stderr: "", durationMs: 4, timedOut: false };
    };

    try {
      const result = await callTool(
        "pharo_launcher_image_copy",
        { imageName: "Base", newImageName: "Task" },
        { runner, config, imageCopyVerificationTimeoutMs: 0, imageCopyVerificationPollMs: 0 },
      );

      expect(result.isError).toBe(true);
      expect(parseJsonResult(result)).toMatchObject({
        ok: false,
        diagnostic: `Pharo Launcher said it copied Base to Task, but ${path.join(config.profile.imagesDir, "Task")} does not exist after 0 s.`,
      });
      expect(calls).toEqual([["image", "copy", "Base", "Task"]]);
    } finally {
      removeConfig(config);
    }
  });

  it("copies images between explicit profiles without using the active profile", async () => {
    const sourceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pharo-launcher-mcp-source-profile-"),
    );
    const destinationRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pharo-launcher-mcp-destination-profile-"),
    );
    const runner: LauncherCliRunner = async () => {
      throw new Error("runner should not be called");
    };
    writeProfileImage(sourceRoot, "Base");

    const result = await callTool(
      "pharo_launcher_image_copy_between_profiles",
      {
        sourceProfile: {
          stateRoot: sourceRoot,
          profileName: "source",
        },
        destinationProfile: {
          stateRoot: destinationRoot,
          profileName: "destination",
        },
        sourceImageName: "Base",
        destinationImageName: "Task",
      },
      { runner },
    );
    const body = parseJsonResult(result);

    expect(result.isError).toBeUndefined();
    expect(body).toMatchObject({
      ok: true,
      operation: "copy_between_profiles",
      sourceImageName: "Base",
      destinationImageName: "Task",
      sourceProfile: {
        profileName: "source",
        stateRoot: sourceRoot,
        imagesDir: path.join(sourceRoot, "images"),
      },
      destinationProfile: {
        profileName: "destination",
        stateRoot: destinationRoot,
        imagesDir: path.join(destinationRoot, "images"),
      },
      destinationImage: {
        imageName: "Task",
        imageFile: {
          exists: true,
          kind: "file",
        },
      },
      verification: {
        ok: true,
        destinationImageFileExists: true,
      },
    });

    fs.rmSync(sourceRoot, { recursive: true, force: true });
    fs.rmSync(destinationRoot, { recursive: true, force: true });
  });

  it("rejects copy between profiles when either profile is not explicit", async () => {
    const runner: LauncherCliRunner = async () => {
      throw new Error("runner should not be called");
    };
    const destinationRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pharo-launcher-mcp-destination-profile-"),
    );
    try {
      const result = await callTool(
        "pharo_launcher_image_copy_between_profiles",
        {
          sourceProfile: {},
          destinationProfile: {
            stateRoot: destinationRoot,
          },
          sourceImageName: "Base",
          destinationImageName: "Task",
        },
        { runner },
      );

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain(
        "sourceProfile must include stateRoot or explicit launcherConfiguration",
      );
    } finally {
      fs.rmSync(destinationRoot, { recursive: true, force: true });
    }
  });

  it("verifies created template images with the images directory and image info", async () => {
    const config = tempProfileConfig();
    const calls: string[][] = [];
    const runner: LauncherCliRunner = async (args) => {
      calls.push([...args]);
      if (args[1] === "create") {
        writeCreatedImage(config.profile.imagesDir, "Task");
      }

      return { exitCode: 0, stdout: "Created", stderr: "", durationMs: 4, timedOut: false };
    };

    try {
      const result = await callTool(
        "pharo_launcher_image_create",
        { templateName: "Pharo 13", newImageName: "Task", noLaunch: false },
        { runner, config },
      );

      expect(result.isError).toBeUndefined();
      expect(parseJsonResult(result)).toMatchObject({
        ok: true,
        command: {
          args: ["image", "create", "--no-launch", "--templateName", "Pharo 13", "Task"],
          exitCode: 0,
        },
        data: {
          image: {
            name: "Task",
            pharoVersion: "130",
            architecture: "64",
            template: { name: "Pharo 13" },
          },
        },
      });
      expect(calls).toEqual([
        ["image", "create", "--no-launch", "--templateName", "Pharo 13", "Task"],
        ["image", "info", "Task"],
      ]);
    } finally {
      removeConfig(config);
    }
  });

  it("returns a structured tool error when image create runner setup throws", async () => {
    const config = tempProfileConfig();
    const runner: LauncherCliRunner = async () => {
      throw new Error("spawn bash ENOENT");
    };

    try {
      const result = await callTool(
        "pharo_launcher_image_create",
        {
          templateName: "Pharo 13",
          newImageName: "Task",
          noLaunch: true,
        },
        { runner, config },
      );
      const body = parseJsonResult(result);

    expect(result.isError).toBe(true);
    expect(body).toMatchObject({
      ok: false,
      diagnostic: expect.stringContaining("spawn bash ENOENT"),
      command: {
        args: [
          "image",
            "create",
            "--no-launch",
            "--templateName",
            "Pharo 13",
            "Task",
          ],
          exitCode: null,
        },
      });
      expect(String(body.diagnostic)).toContain("command:");
      expect(String(body.diagnostic)).toContain("args:");
      expect(String(body.diagnostic)).toContain(
        `PHARO_LAUNCHER_MCP_STATE_ROOT: ${config.profile.stateRoot}`,
      );
      expect(String(body.diagnostic)).toContain(
        `PHARO_LAUNCHER_MCP_LOGS_DIR: ${config.profile.logsDir}`,
      );
    } finally {
      fs.rmSync(config.profile.stateRoot, { recursive: true, force: true });
      fs.rmSync(config.launcherDir, { recursive: true, force: true });
    }
  });

  it("fails created template images that are not in the images directory", async () => {
    const config = tempProfileConfig();
    const calls: string[][] = [];
    const runner: LauncherCliRunner = async (args) => {
      calls.push([...args]);
      return { exitCode: 0, stdout: "Created", stderr: "", durationMs: 4, timedOut: false };
    };

    try {
      const result = await callTool(
        "pharo_launcher_image_create",
        { templateName: "Pharo 13", newImageName: "Task" },
        { runner, config, imageCopyVerificationTimeoutMs: 0, imageCopyVerificationPollMs: 0 },
      );

      expect(result.isError).toBe(true);
      expect(parseJsonResult(result)).toMatchObject({
        ok: false,
        diagnostic: `Pharo Launcher said it created Task, but ${path.join(config.profile.imagesDir, "Task")} does not exist after 0 s.`,
      });
      expect(calls).toEqual([
        ["image", "create", "--no-launch", "--templateName", "Pharo 13", "Task"],
      ]);
    } finally {
      removeConfig(config);
    }
  });

  it("reads image_list from the images directory, not the Launcher", async () => {
    const config = tempProfileConfig();
    const runner: LauncherCliRunner = async () => {
      throw new Error("runner should not be called");
    };
    const imagePath = path.join(config.profile.imagesDir, "Task", "Task.image");
    writeCreatedImage(config.profile.imagesDir, "Task");

    try {
      const result = await callTool(
        "pharo_launcher_image_list",
        { format: "ston", includeRaw: true },
        {
          runner,
          config,
          nativeProcess: {
            platform: "linux",
            runCommand: psRunner([`71513 /vms/130-x64/pharo --headless ${imagePath}`]),
          },
        },
      );

      expect(result.isError).toBeUndefined();
      expect(parseJsonResult(result)).toEqual({
        imagesDir: config.profile.imagesDir,
        images: [
          {
            name: "Task",
            imagePath,
            pharoVersion: "130",
            architecture: "64",
            template: { name: "Pharo 13", url: "https://example.test/130/latest.zip" },
            modified: expect.any(String),
            pids: [71513],
          },
        ],
        notImages: [],
      });
    } finally {
      removeConfig(config);
    }
  });

  it("reads image_info from the images directory, an error when it is not there", async () => {
    const config = tempProfileConfig();
    const runner: LauncherCliRunner = async () => {
      throw new Error("runner should not be called");
    };
    writeCreatedImage(config.profile.imagesDir, "Task");
    const options = {
      runner,
      config,
      nativeProcess: { platform: "linux" as const, runCommand: psRunner([]) },
    };

    try {
      const found = await callTool("pharo_launcher_image_info", { imageName: "task" }, options);
      const missing = await callTool("pharo_launcher_image_info", { imageName: "Base" }, options);

      expect(found.isError).toBeUndefined();
      expect(parseJsonResult(found)).toMatchObject({
        found: true,
        image: { name: "Task", pids: [] },
      });
      expect(missing.isError).toBe(true);
      expect(parseJsonResult(missing)).toEqual({
        found: false,
        imagesDir: config.profile.imagesDir,
      });
    } finally {
      removeConfig(config);
    }
  });

  it("returns tool errors for invalid typed launcher input", async () => {
    const runner: LauncherCliRunner = async () => {
      throw new Error("runner should not be called");
    };

    const result = await callTool(
      "pharo_launcher_image_delete",
      {
        imageName: 42,
      },
      { runner },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "imageName must be a non-empty string",
    );
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
      diagnostic: expect.stringContaining("this profile still has no template sources"),
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

  it.each([
    "pharo_launcher_health",
    "pharo_launcher_version",
    "pharo_launcher_validate_installation",
    "pharo_launcher_inventory",
    "pharo_launcher_raw_command",
    "pharo_launcher_image_bisect",
    "pharo_launcher_image_package",
    "pharo_launcher_image_recreate",
    "pharo_launcher_image_create_from_build",
    "pharo_launcher_image_create_from_pull_request",
    "pharo_launcher_image_create_from_repo",
    "pharo_launcher_image_create_from_sha",
    "pharo_launcher_template_info",
    "pharo_launcher_vm_list",
    "pharo_launcher_vm_info",
    "pharo_launcher_vm_update",
    "pharo_launcher_vm_delete",
  ])("no longer answers for %s", async (name) => {
    const result = await callTool(name, {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Unknown tool");
  });

  it("reports unknown tools as MCP tool errors", async () => {
    const result = await callTool("missing_tool", {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Unknown tool");
  });
});
