import { describe, expect, it } from "vitest";
import {
  bundledLauncherScriptName,
  defaultLauncherDir,
  defaultLauncherVm,
  launcherPlatformDefaults,
  shouldRunScriptThroughBash,
  shouldRunScriptThroughCommandShell,
} from "./platform.js";

describe("launcher platform defaults", () => {
  it("defines Windows PharoLauncher defaults", () => {
    expect(
      launcherPlatformDefaults(
        { LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" },
        "win32",
      ),
    ).toEqual({
      launcherDir: "C:\\Users\\Ada\\AppData\\Local\\Pharo Launcher",
      launcherVm:
        "C:\\Users\\Ada\\AppData\\Local\\Pharo Launcher\\PharoConsole.exe",
      bundledScriptName: "pharo-launcher.cmd",
    });
  });

  it("defines macOS PharoLauncher defaults", () => {
    expect(defaultLauncherDir({ HOME: "/Users/ada" }, "darwin")).toBe(
      "/Users/ada/Library/Application Support/Pharo Launcher",
    );
    expect(
      defaultLauncherVm(
        "/Users/ada/Library/Application Support/Pharo Launcher",
        "darwin",
      ),
    ).toBe(
      "/Users/ada/Library/Application Support/Pharo Launcher/pharo-vm/Pharo.app/Contents/MacOS/Pharo",
    );
    expect(bundledLauncherScriptName("darwin")).toBe("pharo-launcher.sh");
  });

  it("defines Linux PharoLauncher defaults", () => {
    expect(defaultLauncherDir({ HOME: "/home/ada" }, "linux")).toBe(
      "/home/ada/.local/share/Pharo Launcher",
    );
    expect(defaultLauncherVm("/home/ada/.local/share/Pharo Launcher", "linux")).toBe(
      "/home/ada/.local/share/Pharo Launcher/pharo-vm/pharo",
    );
    expect(bundledLauncherScriptName("linux")).toBe("pharo-launcher.sh");
  });

  it("runs Windows command wrappers through cmd.exe only on Windows", () => {
    expect(
      shouldRunScriptThroughCommandShell("C:\\PL\\pharo-launcher.cmd", "win32"),
    ).toBe(true);
    expect(
      shouldRunScriptThroughCommandShell("C:\\PL\\pharo-launcher.cmd", "linux"),
    ).toBe(false);
    expect(shouldRunScriptThroughCommandShell("/opt/pl/pharo-launcher.sh", "linux")).toBe(
      false,
    );
  });

  it("runs POSIX shell wrappers through bash only off Windows", () => {
    expect(shouldRunScriptThroughBash("/opt/pl/pharo-launcher.sh", "linux")).toBe(
      true,
    );
    expect(
      shouldRunScriptThroughBash("/Applications/Pharo Launcher/pharo-launcher.sh", "darwin"),
    ).toBe(true);
    expect(shouldRunScriptThroughBash("C:\\PL\\pharo-launcher.sh", "win32")).toBe(
      false,
    );
    expect(shouldRunScriptThroughBash("/opt/pl/pharo-launcher", "linux")).toBe(
      false,
    );
  });
});
