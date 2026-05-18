import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPharoLauncherConfig } from "./config.js";
import { candidateLauncherScriptPaths } from "./launcherScript.js";
import { nativeProcessToolCapability } from "./processTools.js";
import { bundledLauncherScriptName } from "./platform.js";

const platformCases: Array<{
  name: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  launcherDir: string;
  launcherVm: string;
  processBackend: string;
}> = [
  {
    name: "Windows",
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" },
    launcherDir: "C:\\Users\\Ada\\AppData\\Local\\Pharo Launcher",
    launcherVm: "C:\\Users\\Ada\\AppData\\Local\\Pharo Launcher\\PharoConsole.exe",
    processBackend: "windows-powershell",
  },
  {
    name: "macOS",
    platform: "darwin",
    env: { HOME: "/Users/ada" },
    launcherDir: "/Users/ada/Library/Application Support/Pharo Launcher",
    launcherVm:
      "/Users/ada/Library/Application Support/Pharo Launcher/pharo-vm/Pharo.app/Contents/MacOS/Pharo",
    processBackend: "posix-ps",
  },
  {
    name: "Linux",
    platform: "linux",
    env: { HOME: "/home/ada" },
    launcherDir: "/home/ada/.local/share/Pharo Launcher",
    launcherVm: "/home/ada/.local/share/Pharo Launcher/pharo-vm/pharo",
    processBackend: "posix-ps",
  },
];

describe("cross-platform pharo-launcher-mcp contract", () => {
  for (const platformCase of platformCases) {
    it(`defines config, launcher script, and process backend behavior for ${platformCase.name}`, () => {
      const config = loadPharoLauncherConfig(
        platformCase.env,
        platformCase.platform,
        platformCase.platform === "darwin"
          ? { macOSAppBundleCandidates: [] }
          : {},
      );
      const scripts = candidateLauncherScriptPaths({
        env: {},
        platform: platformCase.platform,
        launcherDir: config.launcherDir,
      });
      const processCapability = nativeProcessToolCapability(
        platformCase.platform,
      );

      expect(config.launcherDir).toBe(platformCase.launcherDir);
      expect(config.launcherVm).toBe(platformCase.launcherVm);
      expect(path.basename(scripts[0] ?? "")).toBe(
        bundledLauncherScriptName(platformCase.platform),
      );
      expect(processCapability).toMatchObject({
        backend: platformCase.processBackend,
        supported: true,
      });
    });
  }
});
