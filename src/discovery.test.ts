import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getPharoLauncherConfigReport,
  getPharoLauncherHealth,
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
});
