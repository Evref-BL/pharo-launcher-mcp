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
      reason: "listing processes is not supported on aix",
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

    const result = await runNativeProcessTool(["process", "kill", "--image", "MCP13"], {
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

  it("kills the pid it was given and no process that merely mentions it", async () => {
    const killed: number[] = [];
    const runCommand: NativeProcessCommandRunner = async () =>
      [
        "4711 /opt/pharo/pharo --headless /home/ada/images/MCP13/MCP13.image",
        "99 /opt/pharo/pharo --headless /home/ada/images/port-4711/scratch.image",
      ].join("\n");

    const result = await runNativeProcessTool(["process", "kill", "--pid", "4711"], {
      platform: "linux",
      runCommand,
      killProcess: (pid) => {
        killed.push(pid);
      },
    });

    expect(killed).toEqual([4711]);
    expect(result.stdout).toBe("Killed 4711");
  });

  // Read back from the text, an all-digit target used to be a pid.
  it("kills the image named with digits, and not the pid those digits are", async () => {
    const killed: number[] = [];
    const runCommand: NativeProcessCommandRunner = async () =>
      [
        "2025 /opt/pharo/pharo --headless /home/ada/images/other/other.image",
        "3093 /opt/pharo/pharo --headless /home/ada/images/2025/2025.image",
      ].join("\n");

    const result = await runNativeProcessTool(["process", "kill", "--image", "2025"], {
      platform: "linux",
      runCommand,
      killProcess: (pid) => {
        killed.push(pid);
      },
    });

    expect(killed).toEqual([3093]);
    expect(result.kill).toEqual({ killed: [3093], failures: [] });
  });

  it("kills images whose name matches, not images whose name starts the same", async () => {
    const killed: number[] = [];
    const runCommand: NativeProcessCommandRunner = async () =>
      [
        "3093 /opt/pharo/pharo --headless /home/ada/images/MCP13/MCP13.image",
        "3094 /opt/pharo/pharo --headless /home/ada/images/MCP13-copy/MCP13-copy.image",
      ].join("\n");

    const result = await runNativeProcessTool(["process", "kill", "--image", "MCP13"], {
      platform: "linux",
      runCommand,
      killProcess: (pid) => {
        killed.push(pid);
      },
    });

    expect(killed).toEqual([3093]);
    expect(result.stdout).toBe("Killed 3093");
  });

  it("kills an image addressed by its full image path", async () => {
    const killed: number[] = [];
    const runCommand: NativeProcessCommandRunner = async () =>
      "3093 /opt/pharo/pharo --headless /home/ada/images/MCP13/MCP13.image";

    const result = await runNativeProcessTool(
      ["process", "kill", "--image", "/home/ada/images/MCP13/MCP13.image"],
      {
        platform: "linux",
        runCommand,
        killProcess: (pid) => {
          killed.push(pid);
        },
      },
    );

    expect(killed).toEqual([3093]);
    expect(result.exitCode).toBe(0);
  });

  it("returns a clean unsupported result when no native backend exists", async () => {
    const result = await runNativeProcessTool(["process", "list"], {
      platform: "aix",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("listing processes is not supported on aix");
  });

  it("hands over the records it lists", async () => {
    const result = await runNativeProcessTool(["process", "list"], {
      platform: "linux",
      runCommand: async () =>
        "3093 /opt/pharo/pharo --headless /home/ada/images/MCP13/MCP13.image",
    });

    expect(result.processes).toEqual([
      {
        pid: 3093,
        executablePath: "/opt/pharo/pharo",
        imagePath: "/home/ada/images/MCP13/MCP13.image",
        imageName: "MCP13",
        commandLine: "/opt/pharo/pharo --headless /home/ada/images/MCP13/MCP13.image",
      },
    ]);
  });

  // A VM gone meanwhile did what was asked.
  it("tries every target, counting a pid already gone as stopped", async () => {
    const tried: number[] = [];
    const errno = (code: string) =>
      Object.assign(new Error(`kill ${code}`), { code });

    const result = await runNativeProcessTool(["process", "kill", "--image", "MCP13"], {
      platform: "linux",
      runCommand: async () =>
        [
          "11 /opt/pharo/pharo /home/ada/images/MCP13/MCP13.image",
          "12 /opt/pharo/pharo /home/ada/images/MCP13/MCP13.image",
          "13 /opt/pharo/pharo /home/ada/images/MCP13/MCP13.image",
        ].join("\n"),
      killProcess: (pid) => {
        tried.push(pid);
        if (pid === 11) {
          throw errno("EPERM");
        }
        if (pid === 12) {
          throw errno("ESRCH");
        }
      },
    });

    expect(tried).toEqual([11, 12, 13]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("Killed 12\nKilled 13");
    expect(result.stderr).toBe("Could not kill pid 11: kill EPERM");
  });

  it("succeeds when every target is stopped, gone ones included", async () => {
    const result = await runNativeProcessTool(["process", "kill", "--pid", "4711"], {
      platform: "linux",
      runCommand: async () =>
        "4711 /opt/pharo/pharo /home/ada/images/MCP13/MCP13.image",
      killProcess: () => {
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Killed 4711");
  });
});
