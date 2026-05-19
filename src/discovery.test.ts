import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getPharoLauncherConfigReport,
  getPharoLauncherHealth,
  getPharoLauncherInventory,
  getPharoLauncherVersion,
  validatePharoLauncherInstallation,
  type LauncherCliRunner,
} from "./discovery.js";
import { loadPharoLauncherConfig } from "./config.js";

const tempDirs: string[] = [];

function tempLauncherConfig() {
  const launcherDir = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-launcher-mcp-"));
  tempDirs.push(launcherDir);

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
  const config = tempLauncherConfig();
  const stateRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pharo-launcher-mcp-profile-"),
  );
  tempDirs.push(stateRoot);

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
  const launcherConfiguration = path.join(
    stateRoot,
    "launcher",
    "pharo-launcher-cli-config.ston",
  );

  for (const directory of [
    path.dirname(profile.launcherImage),
    profile.imagesDir,
    profile.vmsDir,
    profile.templateSourcesDir,
    profile.initScriptsDir,
    profile.logsDir,
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(profile.launcherImage, "");
  fs.writeFileSync(launcherConfiguration, "");

  return {
    ...config,
    launcherImage: profile.launcherImage,
    launcherConfiguration,
    profile,
  };
}

function tempMacOSAppBundle() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-launcher-app-"));
  tempDirs.push(root);
  const appPath = path.join(root, "PharoLauncher.app");
  const executablePath = path.join(appPath, "Contents", "MacOS", "Pharo");
  const imagePath = path.join(
    appPath,
    "Contents",
    "Resources",
    "PharoLauncher.image",
  );
  fs.mkdirSync(path.dirname(executablePath), { recursive: true });
  fs.mkdirSync(path.dirname(imagePath), { recursive: true });
  fs.writeFileSync(executablePath, "");
  fs.writeFileSync(imagePath, "");

  return {
    appPath,
    executablePath,
    imagePath,
  };
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("PharoLauncher discovery", () => {
  it("reports resolved paths, existence, and script source", () => {
    const config = tempLauncherConfig();
    const report = getPharoLauncherConfigReport(config);

    expect(report.launcherDir.exists).toBe(true);
    expect(report.launcherVm.exists).toBe(true);
    expect(report.installationLauncherImage.exists).toBe(true);
    expect(report.launcherImage.exists).toBe(true);
    expect(report.launcherScript.path).toBe(config.launcherScript);
    expect(report.launcherScript.source).toBe("env");
    expect(report.launcherScript.exists).toBe(true);
  });

  it("reports installation discovery source and attempted candidates", () => {
    const appBundle = tempMacOSAppBundle();
    const config = loadPharoLauncherConfig(
      {
        HOME: "/Users/ada",
      },
      "darwin",
      {
        macOSAppBundleCandidates: [
          {
            source: "macos-user-app",
            path: "/Users/ada/Applications/PharoLauncher.app",
          },
          {
            source: "macos-system-app",
            path: appBundle.appPath,
          },
        ],
      },
    );
    const report = getPharoLauncherConfigReport(config);

    expect(report.discovery.source).toBe("macos-system-app");
    expect(report.discovery.selected).toMatchObject({
      source: "macos-system-app",
      launcherDir: { path: appBundle.appPath, exists: true },
      launcherVm: { path: appBundle.executablePath, exists: true },
      installationLauncherImage: { path: appBundle.imagePath, exists: true },
      usable: true,
    });
    expect(report.discovery.candidates.map((candidate) => candidate.source)).toEqual([
      "macos-user-app",
      "macos-system-app",
      "platform-default",
    ]);
  });

  it("reports launcher profile paths when a profile is active", () => {
    const config = tempLauncherConfig();
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-launcher-mcp-profile-"));
    tempDirs.push(stateRoot);
    const profileLauncherImage = path.join(
      stateRoot,
      "launcher",
      "PharoLauncher.image",
    );
    fs.mkdirSync(path.dirname(profileLauncherImage), { recursive: true });
    fs.writeFileSync(profileLauncherImage, "");

    const report = getPharoLauncherConfigReport({
      ...config,
      launcherImage: profileLauncherImage,
      launcherConfiguration: "isolated",
      profile: {
        name: "isolated",
        stateRoot,
        launcherImage: profileLauncherImage,
        imagesDir: path.join(stateRoot, "images"),
        vmsDir: path.join(stateRoot, "vms"),
        templateSourcesDir: path.join(stateRoot, "templates"),
        initScriptsDir: path.join(stateRoot, "init-scripts"),
        logsDir: path.join(stateRoot, "logs"),
      },
    });

    expect(report.launcherConfiguration).toBe("isolated");
    expect(report.profile?.name).toBe("isolated");
    expect(report.profile?.launcherImage.exists).toBe(true);
    expect(report.profile?.imagesDir.path).toBe(path.join(stateRoot, "images"));
  });

  it("marks health ok only when required paths and script exist", () => {
    const report = getPharoLauncherHealth(tempLauncherConfig());

    expect(report.ok).toBe(true);
    expect(report.service).toBe("pharo-launcher-mcp");
  });

  it("runs version through a harmless --version call", async () => {
    const calls: readonly string[][] = [];
    const runner: LauncherCliRunner = async (args) => {
      (calls as string[][]).push([...args]);

      return {
        exitCode: 0,
        stdout: "Pharo Launcher 3.0.1",
        stderr: "",
        durationMs: 12,
        timedOut: false,
      };
    };

    const report = await getPharoLauncherVersion(runner, tempLauncherConfig());

    expect(calls).toEqual([["--version"]]);
    expect(report.ok).toBe(true);
    expect(report.version).toBe("3.0.1");
    expect(report.command.durationMs).toBe(12);
  });

  it("validates paths and harmless CLI result together", async () => {
    const runner: LauncherCliRunner = async () => ({
      exitCode: 0,
      stdout: "Pharo Launcher 3.0.1",
      stderr: "",
      durationMs: 10,
      timedOut: false,
    });

    const report = await validatePharoLauncherInstallation(
      runner,
      tempLauncherConfig(),
    );

    expect(report.ok).toBe(true);
    expect(report.harmlessCliCall.args).toEqual(["--version"]);
    expect(report.harmlessCliCall.ok).toBe(true);
  });

  it("reports validation failures from the harmless CLI call", async () => {
    const runner: LauncherCliRunner = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "boom",
      durationMs: 10,
      timedOut: false,
    });

    const report = await validatePharoLauncherInstallation(
      runner,
      tempLauncherConfig(),
    );

    expect(report.ok).toBe(false);
    expect(report.harmlessCliCall.ok).toBe(false);
    expect(report.harmlessCliCall.result?.stderr).toBe("boom");
  });

  it("reports scoped template, version, image, declaration, and profile inventory", async () => {
    const config = tempProfileConfig();
    fs.writeFileSync(
      path.join(config.profile.templateSourcesDir, "local.ston"),
      "OrderedCollection[PhLTemplate{#name:'Pharo 12',#category:'stable',#url:URL['https://example.test/120/latest.zip']}]",
    );

    const calls: readonly string[][] = [];
    const runner: LauncherCliRunner = async (args) => {
      (calls as string[][]).push([...args]);

      return {
        exitCode: 0,
        stdout:
          args[0] === "template"
            ? "OrderedCollection[PhLRemoteTemplate{#name:'Pharo 13',#category:'stable',#url:URL['https://example.test/130/latest.zip']}]"
            : "OrderedCollection[PhLImage{#formatNumber:68021,#architecture:'64',#pharoVersion:'130',#originTemplate:PhLRemoteTemplate{#name:'Pharo 13',#url:URL['https://example.test/130/latest.zip']},#vmManager:PhLVirtualMachineManager{#imageFile:FileLocator{#path:RelativePath['Task','Task.image']}},#launchConfigurations:OrderedCollection[PhLLaunchConfiguration{#vm:PhLVirtualMachine{#id:'130-x64'}}]}]",
        stderr: "",
        durationMs: 5,
        timedOut: false,
      };
    };

    const report = await getPharoLauncherInventory(runner, config, {
      declaredImages: [
        {
          imageId: "dev",
          imageName: "Task",
          projectId: "project",
          workspaceId: "workspace",
          targetId: "target",
          active: true,
          status: "declared",
        },
      ],
    });

    expect(report.ok).toBe(true);
    expect(report.profiles.active).toMatchObject({
      id: "profile:isolated",
      active: true,
      name: "isolated",
      stateRoot: { path: config.profile.stateRoot, exists: true },
      imagesRoot: { path: config.profile.imagesDir, exists: true },
      vmRoot: { path: config.profile.vmsDir, exists: true },
      templateSourceRoot: {
        path: config.profile.templateSourcesDir,
        exists: true,
      },
      initScriptRoot: { path: config.profile.initScriptsDir, exists: true },
      logRoot: { path: config.profile.logsDir, exists: true },
    });
    expect(report.templates.installed).toEqual([
      expect.objectContaining({
        id: expect.stringContaining("installed:template:stable:Pharo+12"),
        name: "Pharo 12",
        category: "stable",
        pharoVersion: "120",
        sourcePath: path.join(config.profile.templateSourcesDir, "local.ston"),
        sourceFile: expect.objectContaining({
          path: path.join(config.profile.templateSourcesDir, "local.ston"),
          sizeBytes: expect.any(Number),
          mtimeMs: expect.any(Number),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
        identity: expect.objectContaining({
          source: "installed",
          category: "stable",
          name: "Pharo 12",
          url: "https://example.test/120/latest.zip",
          pharoVersion: "120",
          sourceFileSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
        createRequest: {
          templateName: "Pharo 12",
          templateCategory: "stable",
        },
      }),
    ]);
    expect(report.templates.downloadable).toEqual([
      expect.objectContaining({
        id: expect.stringContaining("downloadable:template:stable:Pharo+13"),
        name: "Pharo 13",
        category: "stable",
        pharoVersion: "130",
        identity: expect.objectContaining({
          source: "downloadable",
          category: "stable",
          name: "Pharo 13",
          url: "https://example.test/130/latest.zip",
          pharoVersion: "130",
        }),
      }),
    ]);
    expect(report.images.existing).toEqual([
      expect.objectContaining({
        id: "image:Task",
        imageName: "Task",
        pharoVersion: "130",
        identity: expect.objectContaining({
          imageName: "Task",
          architecture: "64",
          pharoVersion: "130",
          formatNumber: 68021,
          imagePath: "Task/Task.image",
          originTemplateName: "Pharo 13",
          originTemplateUrl: "https://example.test/130/latest.zip",
          vmId: "130-x64",
        }),
        copyRequest: { imageName: "Task" },
      }),
    ]);
    expect(report.images.declared).toEqual([
      expect.objectContaining({
        imageId: "dev",
        imageName: "Task",
        workspaceId: "workspace",
      }),
    ]);
    expect(report.versions).toEqual([
      expect.objectContaining({
        id: "pharo:120",
        pharoVersion: "120",
        installedTemplateIds: [expect.stringContaining("Pharo+12")],
      }),
      expect.objectContaining({
        id: "pharo:130",
        pharoVersion: "130",
        downloadableTemplateIds: [expect.stringContaining("Pharo+13")],
        imageIds: ["image:Task"],
      }),
    ]);
    expect(calls).toEqual([
      ["template", "list", "--ston"],
      ["image", "list", "--ston"],
    ]);
  });

  it("normalizes Moose template identity by underlying Pharo version", async () => {
    const config = tempProfileConfig();
    fs.writeFileSync(
      path.join(config.profile.templateSourcesDir, "moose.ston"),
      "OrderedCollection[PhLTemplate{#name:'Moose 13 64bit',#category:'Moose',#url:URL['https://example.test/moose/13/latest.zip']}]",
    );

    const runner: LauncherCliRunner = async () => ({
      exitCode: 0,
      stdout: "OrderedCollection[]",
      stderr: "",
      durationMs: 2,
      timedOut: false,
    });

    const report = await getPharoLauncherInventory(runner, config);

    expect(report.ok).toBe(true);
    expect(report.templates.installed).toEqual([
      expect.objectContaining({
        name: "Moose 13 64bit",
        category: "Moose",
        pharoVersion: "130",
        architecture: "64",
        identity: expect.objectContaining({
          source: "installed",
          category: "Moose",
          name: "Moose 13 64bit",
          pharoVersion: "130",
          architecture: "64",
          sourceFileSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    ]);
    expect(report.versions).toEqual([
      expect.objectContaining({
        id: "pharo:130",
        pharoVersion: "130",
      }),
    ]);
  });

  it("reports an empty scoped template inventory as actionable", async () => {
    const config = tempProfileConfig();
    const runner: LauncherCliRunner = async () => ({
      exitCode: 0,
      stdout: "OrderedCollection[]",
      stderr: "",
      durationMs: 2,
      timedOut: false,
    });

    const report = await getPharoLauncherInventory(runner, config);

    expect(report.ok).toBe(false);
    expect(report.templates.installed).toEqual([]);
    expect(report.templates.downloadable).toEqual([]);
    expect(report.templates.downloadableKnown).toBe(true);
    expect(report.images.existing).toEqual([]);
    expect(report.images.existingKnown).toBe(true);
    expect(report.images.declared).toEqual([]);
    expect(report.versions).toEqual([]);
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: "warning",
        code: "profile_template_sources_bootstrap_missing",
        message: expect.stringContaining("bootstrap file is missing"),
        action: expect.stringContaining("pharo_launcher_template_update"),
        path: path.join(config.profile.templateSourcesDir, "sources.list"),
      }),
      expect.objectContaining({
        severity: "error",
        code: "template_inventory_empty",
        message: expect.stringContaining("no installed or downloadable templates"),
        action: expect.stringContaining(
          "pharo_launcher_template_update",
        ),
        path: config.profile.templateSourcesDir,
      }),
    ]));
  });

  it("returns actionable diagnostics for missing profile paths without probing the launcher", async () => {
    const config = tempLauncherConfig();
    const stateRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pharo-launcher-mcp-profile-"),
    );
    tempDirs.push(stateRoot);
    fs.rmSync(stateRoot, { recursive: true, force: true });

    const runner: LauncherCliRunner = async () => {
      throw new Error("runner should not be called");
    };

    const report = await getPharoLauncherInventory(runner, {
      ...config,
      launcherImage: path.join(stateRoot, "launcher", "PharoLauncher.image"),
      launcherConfiguration: path.join(
        stateRoot,
        "launcher",
        "pharo-launcher-cli-config.ston",
      ),
      profile: {
        name: "missing",
        stateRoot,
        launcherImage: path.join(stateRoot, "launcher", "PharoLauncher.image"),
        imagesDir: path.join(stateRoot, "images"),
        vmsDir: path.join(stateRoot, "vms"),
        templateSourcesDir: path.join(stateRoot, "templates"),
        initScriptsDir: path.join(stateRoot, "init-scripts"),
        logsDir: path.join(stateRoot, "logs"),
      },
    });

    expect(report.ok).toBe(false);
    expect(report.profiles.active).toMatchObject({
      name: "missing",
      stateRoot: { path: stateRoot, exists: false },
    });
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "launcher_image_missing",
          action: expect.stringContaining("PHARO_LAUNCHER_MCP_LAUNCHER_IMAGE"),
        }),
        expect.objectContaining({
          code: "launcher_configuration_missing",
          action: expect.stringContaining(
            "PHARO_LAUNCHER_MCP_LAUNCHER_CONFIGURATION",
          ),
        }),
        expect.objectContaining({
          code: "profile_template_source_root_missing",
          action: expect.stringContaining(
            "PHARO_LAUNCHER_MCP_TEMPLATE_SOURCES_DIR",
          ),
        }),
      ]),
    );
    expect(report.probes).toEqual({});
  });

  it("keeps multiple Pharo versions distinct without launching images", async () => {
    const config = tempProfileConfig();
    const calls: readonly string[][] = [];
    const runner: LauncherCliRunner = async (args) => {
      (calls as string[][]).push([...args]);

      return {
        exitCode: 0,
        stdout:
          args[0] === "template"
            ? "OrderedCollection[PhLRemoteTemplate{#name:'Pharo 12',#category:'stable',#url:URL['https://example.test/120/latest.zip']},PhLRemoteTemplate{#name:'Pharo 13',#category:'stable',#url:URL['https://example.test/130/latest.zip']}]"
            : "OrderedCollection[PhLImage{#formatNumber:68021,#architecture:'64',#pharoVersion:'120',#originTemplate:PhLRemoteTemplate{#name:'Pharo 12'},#vmManager:PhLVirtualMachineManager{#imageFile:FileLocator{#path:RelativePath['Base12','Base12.image']}}},PhLImage{#formatNumber:68021,#architecture:'64',#pharoVersion:'130',#originTemplate:PhLRemoteTemplate{#name:'Pharo 13'},#vmManager:PhLVirtualMachineManager{#imageFile:FileLocator{#path:RelativePath['Base13','Base13.image']}}}]",
        stderr: "",
        durationMs: 3,
        timedOut: false,
      };
    };

    const report = await getPharoLauncherInventory(runner, config);

    expect(report.versions.map((version) => version.pharoVersion)).toEqual([
      "120",
      "130",
    ]);
    expect(report.images.existing.map((image) => image.imageName)).toEqual([
      "Base12",
      "Base13",
    ]);
    expect(calls).toEqual([
      ["template", "list", "--ston"],
      ["image", "list", "--ston"],
    ]);
  });
});
