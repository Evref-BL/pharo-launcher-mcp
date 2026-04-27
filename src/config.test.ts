import { describe, expect, it } from "vitest";
import { loadPharoLauncherConfig } from "./config.js";

describe("loadPharoLauncherConfig", () => {
  it("uses explicit PharoLauncher environment variables", () => {
    const config = loadPharoLauncherConfig({
      PHARO_LAUNCHER_DIR: "C:\\PL",
      PHARO_LAUNCHER_VM: "C:\\PL\\PharoConsole.exe",
      PHARO_LAUNCHER_IMAGE: "C:\\PL\\PharoLauncher.image",
      PHARO_LAUNCHER_SCRIPT: "C:\\PL\\pharo-launcher.cmd",
    });

    expect(config).toEqual({
      launcherDir: "C:\\PL",
      launcherVm: "C:\\PL\\PharoConsole.exe",
      installationLauncherImage: "C:\\PL\\PharoLauncher.image",
      launcherImage: "C:\\PL\\PharoLauncher.image",
      launcherScript: "C:\\PL\\pharo-launcher.cmd",
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

    expect(config).toEqual({
      launcherDir: "/opt/Pharo Launcher",
      launcherVm: "/opt/Pharo Launcher/vm/pharo",
      installationLauncherImage: "/opt/Pharo Launcher/PharoLauncher.image",
      launcherImage: "/opt/Pharo Launcher/PharoLauncher.image",
      launcherScript: "/opt/bin/pharo-launcher",
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
    expect(config.launcherConfiguration).toBe("isolated");
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
});
