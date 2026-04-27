import { describe, expect, it } from "vitest";
import {
  bundledLauncherScriptPath,
  candidateLauncherScriptPaths,
} from "./launcherScript.js";

describe("candidateLauncherScriptPaths", () => {
  it("prefers an explicit script from the environment", () => {
    const candidates = candidateLauncherScriptPaths({
      env: {
        PHARO_LAUNCHER_SCRIPT: "C:\\custom\\pharo-launcher.cmd",
      },
      platform: "win32",
      launcherDir: "C:\\PL",
    });

    expect(candidates[0]).toBe("C:\\custom\\pharo-launcher.cmd");
  });

  it("uses the bundled Windows script by default", () => {
    const candidates = candidateLauncherScriptPaths({
      env: {},
      platform: "win32",
      launcherDir: "C:\\PL",
    });

    expect(candidates).toEqual([bundledLauncherScriptPath("win32")]);
  });

  it("uses the bundled Unix script by default", () => {
    const candidates = candidateLauncherScriptPaths({
      env: {},
      platform: "linux",
      launcherDir: "/opt/pharo-launcher",
    });

    expect(candidates).toEqual([bundledLauncherScriptPath("linux")]);
  });

  it("uses the bundled shell script on macOS", () => {
    const candidates = candidateLauncherScriptPaths({
      env: {},
      platform: "darwin",
      launcherDir: "/Applications/Pharo Launcher",
    });

    expect(candidates).toEqual([bundledLauncherScriptPath("darwin")]);
  });
});
