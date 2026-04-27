import { describe, expect, it } from "vitest";
import {
  nativeProcessToolCapability,
  parsePosixProcessTable,
  runNativeProcessTool,
  shouldUseNativeProcessTool,
  type NativeProcessCommandRunner,
} from "./processTools.js";

describe("native process backend selection", () => {
  it("selects the Windows PowerShell backend on Windows", () => {
    expect(nativeProcessToolCapability("win32")).toEqual({
      platform: "win32",
      backend: "windows-powershell",
      supported: true,
    });
    expect(shouldUseNativeProcessTool("win32")).toBe(true);
  });

  it("selects the POSIX ps backend on macOS and Linux", () => {
    expect(nativeProcessToolCapability("darwin")).toEqual({
      platform: "darwin",
      backend: "posix-ps",
      supported: true,
    });
    expect(nativeProcessToolCapability("linux")).toEqual({
      platform: "linux",
      backend: "posix-ps",
      supported: true,
    });
  });

  it("reports unsupported platforms explicitly", () => {
    expect(nativeProcessToolCapability("aix")).toEqual({
      platform: "aix",
      backend: "unsupported",
      supported: false,
      reason: "Native process backend is not supported on aix",
    });
    expect(shouldUseNativeProcessTool("aix")).toBe(false);
  });
});

describe("POSIX process parsing", () => {
  it("extracts Pharo image processes from ps output", () => {
    expect(
      parsePosixProcessTable(`
        100 /usr/bin/node server.js
        3093 /opt/pharo/pharo --headless /home/ada/images/MCP13/MCP13.image
      `),
    ).toEqual([
      {
        pid: 3093,
        executablePath: "/opt/pharo/pharo",
        imagePath: "/home/ada/images/MCP13/MCP13.image",
        imageName: "MCP13",
        commandLine:
          "/opt/pharo/pharo --headless /home/ada/images/MCP13/MCP13.image",
      },
    ]);
  });
});

describe("runNativeProcessTool", () => {
  it("lists Windows Pharo processes through PowerShell", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const runCommand: NativeProcessCommandRunner = async (command, args) => {
      calls.push({ command, args });

      return JSON.stringify({
        ProcessId: 3093,
        ExecutablePath: "C:\\Program Files\\Pharo\\Pharo.exe",
        CommandLine:
          '"C:\\Program Files\\Pharo\\Pharo.exe" "C:\\Users\\Ada\\Images\\MCP13\\MCP13.image"',
      });
    };

    const result = await runNativeProcessTool(["process", "list"], {
      platform: "win32",
      runCommand,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("3093");
    expect(result.stdout).toContain("MCP13.image");
    expect(calls[0]?.command).toBe("powershell.exe");
    expect(calls[0]?.args).toEqual(
      expect.arrayContaining(["-NoProfile", "-ExecutionPolicy", "Bypass"]),
    );
  });

  it("kills matching POSIX Pharo processes by image name", async () => {
    const killed: number[] = [];
    const runCommand: NativeProcessCommandRunner = async (command, args) => {
      expect(command).toBe("ps");
      expect(args).toEqual(["-axo", "pid=,args="]);

      return "3093 /opt/pharo/pharo --headless /home/ada/images/MCP13/MCP13.image";
    };

    const result = await runNativeProcessTool(["process", "kill", "MCP13"], {
      platform: "linux",
      runCommand,
      killProcess: (pid) => {
        killed.push(pid);
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Killed 3093");
    expect(killed).toEqual([3093]);
  });

  it("returns a clean unsupported result when no native backend exists", async () => {
    const result = await runNativeProcessTool(["process", "list"], {
      platform: "aix",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("Native process backend is not supported on aix");
  });
});
