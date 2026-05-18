import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { describe, expect, it } from "vitest";
import { loadPharoLauncherConfig } from "./config.js";

const tempDirs: string[] = [];

function tempMacOSAppBundle(source: "macos-user-app" | "macos-system-app") {
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
    source,
    path: appPath,
    executablePath,
    imagePath,
  };
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("loadPharoLauncherConfig", () => {
  it("uses explicit PharoLauncher environment variables", () => {
    const config = loadPharoLauncherConfig({
      PHARO_LAUNCHER_DIR: "C:\\PL",
      PHARO_LAUNCHER_VM: "C:\\PL\\PharoConsole.exe",
      PHARO_LAUNCHER_IMAGE: "C:\\PL\\PharoLauncher.image",
      PHARO_LAUNCHER_SCRIPT: "C:\\PL\\pharo-launcher.cmd",
    });

    expect(config).toMatchObject({
      launcherDir: "C:\\PL",
      launcherVm: "C:\\PL\\PharoConsole.exe",
      installationLauncherImage: "C:\\PL\\PharoLauncher.image",
      launcherImage: "C:\\PL\\PharoLauncher.image",
      launcherScript: "C:\\PL\\pharo-launcher.cmd",
      discovery: {
        source: "env",
        selected: {
          source: "env",
          launcherDir: "C:\\PL",
        },
      },
    });
  });

  it("derives the default Windows location from LOCALAPPDATA", () => {
    const config = loadPharoLauncherConfig(
      {
        LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local",
      },
      "win32",
    );

    expect(config.launcherDir).toBe(
      "C:\\Users\\Ada\\AppData\\Local\\Pharo Launcher",
    );
    expect(config.launcherVm).toBe(
      "C:\\Users\\Ada\\AppData\\Local\\Pharo Launcher\\PharoConsole.exe",
    );
    expect(config.launcherScript).toBeUndefined();
  });

  it("derives the default macOS location from HOME", () => {
    const config = loadPharoLauncherConfig(
      {
        HOME: "/Users/ada",
      },
      "darwin",
      { macOSAppBundleCandidates: [] },
    );

    expect(config.launcherDir).toBe(
      "/Users/ada/Library/Application Support/Pharo Launcher",
    );
    expect(config.launcherVm).toBe(
      "/Users/ada/Library/Application Support/Pharo Launcher/pharo-vm/Pharo.app/Contents/MacOS/Pharo",
    );
    expect(config.installationLauncherImage).toBe(
      "/Users/ada/Library/Application Support/Pharo Launcher/PharoLauncher.image",
    );
    expect(config.discovery?.source).toBe("platform-default");
  });

  it("discovers a macOS system PharoLauncher.app bundle before application support fallback", () => {
    const systemApp = tempMacOSAppBundle("macos-system-app");
    const config = loadPharoLauncherConfig(
      {
        HOME: "/Users/ada",
      },
      "darwin",
      {
        macOSAppBundleCandidates: [
          {
            source: "macos-system-app",
            path: systemApp.path,
          },
        ],
      },
    );

    expect(config.discovery?.source).toBe("macos-system-app");
    expect(config.launcherDir).toBe(systemApp.path);
    expect(config.launcherVm).toBe(systemApp.executablePath);
    expect(config.installationLauncherImage).toBe(systemApp.imagePath);
  });

  it("prefers a macOS user PharoLauncher.app bundle over the system app bundle", () => {
    const userApp = tempMacOSAppBundle("macos-user-app");
    const systemApp = tempMacOSAppBundle("macos-system-app");
    const config = loadPharoLauncherConfig(
      {
        HOME: "/Users/ada",
      },
      "darwin",
      {
        macOSAppBundleCandidates: [
          {
            source: "macos-user-app",
            path: userApp.path,
          },
          {
            source: "macos-system-app",
            path: systemApp.path,
          },
        ],
      },
    );

    expect(config.discovery?.source).toBe("macos-user-app");
    expect(config.launcherDir).toBe(userApp.path);
    expect(config.launcherVm).toBe(userApp.executablePath);
    expect(config.installationLauncherImage).toBe(userApp.imagePath);
  });

  it("keeps explicit macOS launcher paths ahead of app bundle discovery", () => {
    const systemApp = tempMacOSAppBundle("macos-system-app");
    const config = loadPharoLauncherConfig(
      {
        HOME: "/Users/ada",
        PHARO_LAUNCHER_DIR: "/custom/Pharo Launcher",
        PHARO_LAUNCHER_VM: "/custom/vm/pharo",
        PHARO_LAUNCHER_IMAGE: "/custom/PharoLauncher.image",
      },
      "darwin",
      {
        macOSAppBundleCandidates: [
          {
            source: "macos-system-app",
            path: systemApp.path,
          },
        ],
      },
    );

    expect(config.discovery?.source).toBe("env");
    expect(config.launcherDir).toBe("/custom/Pharo Launcher");
    expect(config.launcherVm).toBe("/custom/vm/pharo");
    expect(config.installationLauncherImage).toBe(
      "/custom/PharoLauncher.image",
    );
  });

  it("derives the default Linux location from HOME", () => {
    const config = loadPharoLauncherConfig(
      {
        HOME: "/home/ada",
      },
      "linux",
    );

    expect(config.launcherDir).toBe("/home/ada/.local/share/Pharo Launcher");
    expect(config.launcherVm).toBe(
      "/home/ada/.local/share/Pharo Launcher/pharo-vm/pharo",
    );
    expect(config.installationLauncherImage).toBe(
      "/home/ada/.local/share/Pharo Launcher/PharoLauncher.image",
    );
  });

  it("uses explicit launcher paths on non-Windows platforms", () => {
    const config = loadPharoLauncherConfig(
      {
        PHARO_LAUNCHER_DIR: "/opt/Pharo Launcher",
        PHARO_LAUNCHER_VM: "/opt/Pharo Launcher/vm/pharo",
        PHARO_LAUNCHER_IMAGE: "/opt/Pharo Launcher/PharoLauncher.image",
        PHARO_LAUNCHER_SCRIPT: "/opt/bin/pharo-launcher",
      },
      "linux",
    );

    expect(config).toMatchObject({
      launcherDir: "/opt/Pharo Launcher",
      launcherVm: "/opt/Pharo Launcher/vm/pharo",
      installationLauncherImage: "/opt/Pharo Launcher/PharoLauncher.image",
      launcherImage: "/opt/Pharo Launcher/PharoLauncher.image",
      launcherScript: "/opt/bin/pharo-launcher",
      discovery: {
        source: "env",
      },
    });
  });

  it("derives a launcher profile from pharo-launcher-mcp environment variables", () => {
    const config = loadPharoLauncherConfig(
      {
        LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local",
        PHARO_LAUNCHER_MCP_PROFILE: "isolated",
        PHARO_LAUNCHER_MCP_STATE_ROOT: "C:\\dev\\code\\git\\.pharo-launcher-mcp\\profiles\\isolated",
        PHARO_LAUNCHER_MCP_LAUNCHER_CONFIGURATION: "isolated",
      },
      "win32",
    );

    expect(config.installationLauncherImage).toBe(
      "C:\\Users\\Ada\\AppData\\Local\\Pharo Launcher\\PharoLauncher.image",
    );
    expect(config.launcherImage).toBe(
      "C:\\dev\\code\\git\\.pharo-launcher-mcp\\profiles\\isolated\\launcher\\PharoLauncher.image",
    );
    expect(config.launcherConfiguration).toBe(
      "C:\\dev\\code\\git\\.pharo-launcher-mcp\\profiles\\isolated\\launcher\\isolated",
    );
    expect(config.profile).toEqual({
      name: "isolated",
      stateRoot: "C:\\dev\\code\\git\\.pharo-launcher-mcp\\profiles\\isolated",
      launcherImage:
        "C:\\dev\\code\\git\\.pharo-launcher-mcp\\profiles\\isolated\\launcher\\PharoLauncher.image",
      imagesDir: "C:\\dev\\code\\git\\.pharo-launcher-mcp\\profiles\\isolated\\images",
      vmsDir: "C:\\dev\\code\\git\\.pharo-launcher-mcp\\profiles\\isolated\\vms",
      templateSourcesDir:
        "C:\\dev\\code\\git\\.pharo-launcher-mcp\\profiles\\isolated\\templates",
      initScriptsDir:
        "C:\\dev\\code\\git\\.pharo-launcher-mcp\\profiles\\isolated\\init-scripts",
      logsDir: "C:\\dev\\code\\git\\.pharo-launcher-mcp\\profiles\\isolated\\logs",
    });
  });

  it("defaults profile launcher configuration to the profile launcher directory", () => {
    const config = loadPharoLauncherConfig(
      {
        LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local",
        PHARO_LAUNCHER_MCP_PROFILE: "isolated",
        PHARO_LAUNCHER_MCP_STATE_ROOT:
          "C:\\dev\\code\\git\\.pharo-launcher-mcp\\profiles\\isolated",
      },
      "win32",
    );

    expect(config.launcherConfiguration).toBe(
      "C:\\dev\\code\\git\\.pharo-launcher-mcp\\profiles\\isolated\\launcher\\pharo-launcher-cli-config.ston",
    );
  });

  it("keeps absolute profile launcher configuration paths", () => {
    const config = loadPharoLauncherConfig(
      {
        LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local",
        PHARO_LAUNCHER_MCP_PROFILE: "isolated",
        PHARO_LAUNCHER_MCP_STATE_ROOT:
          "C:\\dev\\code\\git\\.pharo-launcher-mcp\\profiles\\isolated",
        PHARO_LAUNCHER_MCP_LAUNCHER_CONFIGURATION:
          "C:\\dev\\code\\git\\.pharo-launcher-mcp\\profiles\\isolated\\launcher\\custom.ston",
      },
      "win32",
    );

    expect(config.launcherConfiguration).toBe(
      "C:\\dev\\code\\git\\.pharo-launcher-mcp\\profiles\\isolated\\launcher\\custom.ston",
    );
  });
});
