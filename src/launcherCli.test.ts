import { describe, expect, it } from "vitest";
import type { PharoLauncherConfig } from "./config.js";
import {
  buildLauncherCliInvocation,
  isDetachedImageLaunch,
  launcherArgsForDetachedImageLaunch,
  runLauncherCli,
} from "./launcherCli.js";

function launcherConfig(
  config: Omit<PharoLauncherConfig, "installationLauncherImage">,
): PharoLauncherConfig {
  return {
    installationLauncherImage: config.launcherImage,
    ...config,
  };
}

describe("buildLauncherCliInvocation", () => {
  it("prefers an explicit launcher script", () => {
    const invocation = buildLauncherCliInvocation(
      ["image", "list", "--ston"],
      launcherConfig({
        launcherDir: "C:\\PL",
        launcherVm: "C:\\PL\\PharoConsole.exe",
        launcherImage: "C:\\PL\\PharoLauncher.image",
        launcherScript: "C:\\PL\\pharo-launcher.cmd",
      }),
      {
        platform: "win32",
        comspec: "C:\\Windows\\System32\\cmd.exe",
      },
    );

    expect(invocation.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(invocation.args).toEqual([
      "/d",
      "/c",
      "C:\\PL\\pharo-launcher.cmd",
      "image",
      "list",
      "--ston",
    ]);
    expect(invocation.cwd).toBe("C:\\PL");
    expect(invocation.env.PHARO_LAUNCHER_VM).toBe("C:\\PL\\PharoConsole.exe");
    expect(invocation.env.PHARO_LAUNCHER_IMAGE).toBe(
      "C:\\PL\\PharoLauncher.image",
    );
    expect(invocation.source).toBe("script");
  });

  it("runs Unix launcher scripts through bash", () => {
    const invocation = buildLauncherCliInvocation(
      ["image", "list", "--ston"],
      launcherConfig({
        launcherDir: "/opt/pharo-launcher",
        launcherVm: "/opt/pharo-launcher/pharo-vm/pharo",
        launcherImage: "/opt/pharo-launcher/PharoLauncher.image",
        launcherScript: "/opt/pharo-launcher/bin/pharo-launcher.sh",
      }),
      {
        bashPath: "/bin/bash",
        platform: "linux",
      },
    );

    expect(invocation.command).toBe("/bin/bash");
    expect(invocation.args).toEqual([
      "/opt/pharo-launcher/bin/pharo-launcher.sh",
      "image",
      "list",
      "--ston",
    ]);
    expect(invocation.source).toBe("script");
  });

  it("does not route command scripts through cmd.exe off Windows", () => {
    const invocation = buildLauncherCliInvocation(
      ["image", "list"],
      launcherConfig({
        launcherDir: "/tmp/pl",
        launcherVm: "/tmp/pl/pharo-vm/pharo",
        launcherImage: "/tmp/pl/PharoLauncher.image",
        launcherScript: "/tmp/pl/pharo-launcher.cmd",
      }),
      {
        platform: "linux",
        comspec: "cmd.exe",
      },
    );

    expect(invocation.command).toBe("/tmp/pl/pharo-launcher.cmd");
    expect(invocation.args).toEqual(["image", "list"]);
  });

  it("falls back to a headless direct VM invocation", () => {
    const invocation = buildLauncherCliInvocation(
      ["image", "list", "--ston"],
      launcherConfig({
        launcherDir: "C:\\missing",
        launcherVm: "C:\\missing\\PharoConsole.exe",
        launcherImage: "C:\\missing\\PharoLauncher.image",
      }),
      {
        resolveScript: () => undefined,
      },
    );

    expect(invocation.command).toBe("C:\\missing\\PharoConsole.exe");
    expect(invocation.args).toEqual([
      "--headless",
      "C:\\missing\\PharoLauncher.image",
      "--no-default-preferences",
      "clap",
      "launcher",
      "image",
      "list",
      "--ston",
    ]);
    expect(invocation.source).toBe("direct");
  });

  it("uses profile launcher configuration and exports profile folders", () => {
    const invocation = buildLauncherCliInvocation(
      ["image", "list"],
      launcherConfig({
        launcherDir: "C:\\PL",
        launcherVm: "C:\\PL\\PharoConsole.exe",
        launcherImage:
          "C:\\dev\\code\\git\\.pharo-launcher-mcp\\profiles\\isolated\\launcher\\PharoLauncher.image",
        launcherScript: "C:\\PL\\pharo-launcher.cmd",
        launcherConfiguration: "isolated",
        profile: {
          name: "isolated",
          stateRoot: "C:\\dev\\code\\git\\.pharo-launcher-mcp\\profiles\\isolated",
          launcherImage:
            "C:\\dev\\code\\git\\.pharo-launcher-mcp\\profiles\\isolated\\launcher\\PharoLauncher.image",
          imagesDir:
            "C:\\dev\\code\\git\\.pharo-launcher-mcp\\profiles\\isolated\\images",
          vmsDir: "C:\\dev\\code\\git\\.pharo-launcher-mcp\\profiles\\isolated\\vms",
          templateSourcesDir:
            "C:\\dev\\code\\git\\.pharo-launcher-mcp\\profiles\\isolated\\templates",
          initScriptsDir:
            "C:\\dev\\code\\git\\.pharo-launcher-mcp\\profiles\\isolated\\init-scripts",
          logsDir: "C:\\dev\\code\\git\\.pharo-launcher-mcp\\profiles\\isolated\\logs",
        },
      }),
      {
        platform: "win32",
        comspec: "cmd.exe",
      },
    );

    expect(invocation.args).toEqual([
      "/d",
      "/c",
      "C:\\PL\\pharo-launcher.cmd",
      "--configuration",
      "isolated",
      "image",
      "list",
    ]);
    expect(invocation.env.PHARO_LAUNCHER_IMAGE).toBe(
      "C:\\dev\\code\\git\\.pharo-launcher-mcp\\profiles\\isolated\\launcher\\PharoLauncher.image",
    );
    expect(invocation.env.PHARO_LAUNCHER_MCP_IMAGES_DIR).toBe(
      "C:\\dev\\code\\git\\.pharo-launcher-mcp\\profiles\\isolated\\images",
    );
  });

  it("recognizes and strips launcher detached image launches for process-level detaching", () => {
    const args = [
      "image",
      "launch",
      "--script",
      "bootstrap.st",
      "--detached",
      "Task",
    ];

    expect(isDetachedImageLaunch(args)).toBe(true);
    expect(launcherArgsForDetachedImageLaunch(args)).toEqual([
      "image",
      "launch",
      "--script",
      "bootstrap.st",
      "Task",
    ]);
    expect(isDetachedImageLaunch(["image", "list"])).toBe(false);
  });

  it("captures stdout, stderr, exit code, and duration", async () => {
    const result = await runLauncherCli(
      [
        "-e",
        "process.stdout.write('ok'); process.stderr.write('warn');",
      ],
      {
        config: launcherConfig({
          launcherDir: process.cwd(),
          launcherVm: "unused",
          launcherImage: "unused",
          launcherScript: process.execPath,
        }),
        timeoutMs: 2_000,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
    expect(result.stderr).toBe("warn");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.timedOut).toBe(false);
    expect(result.timeoutReason).toBeUndefined();
  });

  it("captures timeout reason", async () => {
    const result = await runLauncherCli(["-e", "setTimeout(() => {}, 500);"], {
      config: launcherConfig({
        launcherDir: process.cwd(),
        launcherVm: "unused",
        launcherImage: "unused",
        launcherScript: process.execPath,
      }),
      timeoutMs: 10,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(true);
    expect(result.timeoutReason).toBe(
      "PharoLauncher CLI timed out after 10ms",
    );
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
