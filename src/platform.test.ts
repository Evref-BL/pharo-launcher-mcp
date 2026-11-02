import { describe, expect, it } from "vitest";
import {
  bundledLauncherScriptName,
  defaultLauncherDir,
  defaultLauncherVm,
  launcherModulePathBudget,
  launcherModulePathBudgetMessage,
  launcherModulePathLimit,
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
      launcherImage:
        "C:\\Users\\Ada\\AppData\\Local\\Pharo Launcher\\PharoLauncher.image",
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

  it("keeps Windows-shaped macOS app bundle candidates Windows-shaped", () => {
    expect(defaultLauncherVm("C:\\Users\\Ada\\PharoLauncher.app", "darwin")).toBe(
      "C:\\Users\\Ada\\PharoLauncher.app\\Contents\\MacOS\\Pharo",
    );
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

describe("launcher module path budget", () => {
  // Measured, not assumed: the same profile with the same VM bytes and the
  // same script passes at 255 characters and fails at 256. The VM copies a
  // module path through a 256-byte buffer, and a module it cannot open is
  // reported as a missing symbol in a file that is present and correct.
  const tail = "/140-x64/Pharo.app/Contents/MacOS/Plugins/libgit2-1.9.1.9.0.dylib";

  it("fits a directory whose longest module path is the limit", () => {
    const vmsDirectory = "v".repeat(launcherModulePathLimit - tail.length);
    const budget = launcherModulePathBudget(vmsDirectory);

    expect(budget.longestModulePath).toBe(launcherModulePathLimit);
    expect(budget.ok).toBe(true);
    expect(budget.over).toBe(0);
  });

  it("refuses one character more", () => {
    const vmsDirectory = "v".repeat(launcherModulePathLimit - tail.length + 1);
    const budget = launcherModulePathBudget(vmsDirectory);

    expect(budget.longestModulePath).toBe(launcherModulePathLimit + 1);
    expect(budget.ok).toBe(false);
    expect(budget.over).toBe(1);
    expect(launcherModulePathBudgetMessage(budget)).toContain(
      "Shorten the profile root by at least 1 characters",
    );
  });

  it("takes the worse of what is there and what a download would add", () => {
    const vmsDirectory = "/short/vms";
    const measured = launcherModulePathLimit + 40;

    expect(launcherModulePathBudget(vmsDirectory, () => measured)).toMatchObject({
      ok: false,
      measured: true,
      longestModulePath: measured,
    });
    // A VM that is not downloaded yet measures nothing, so the tail decides.
    expect(launcherModulePathBudget(vmsDirectory, () => undefined)).toMatchObject({
      ok: true,
      measured: false,
      longestModulePath: vmsDirectory.length + tail.length,
    });
  });
});
