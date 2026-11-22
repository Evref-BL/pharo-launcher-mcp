import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildLauncherCommandArgs } from "./commandCatalog.js";
import type { PharoLauncherConfig } from "./config.js";
import {
  buildLauncherCliInvocation,
  ensureProfileLauncherConfiguration,
  isDetachedImageLaunch,
  launcherArgsForDetachedImageLaunch,
  profileLauncherConfigurationContent,
  runLauncherCli,
} from "./launcherCli.js";
import { bundledLauncherScriptPath } from "./launcherScript.js";
import { cliMetaInf, guiMetaInf, writeImage } from "./testing/images.js";

function launcherConfig(
  config: Omit<PharoLauncherConfig, "installationLauncherImage"> &
    Partial<Pick<PharoLauncherConfig, "installationLauncherImage">>,
): PharoLauncherConfig {
  return {
    installationLauncherImage: config.installationLauncherImage ?? config.launcherImage,
    ...config,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function writeExecutableScript(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, "utf8");
  fs.chmodSync(filePath, 0o755);
}

/** An image as `image create` leaves it, its template naming Pharo 13. */
function writeCreatedImage(imagesDir: string, imageName: string): void {
  writeImage(imagesDir, imageName, {
    metaInf: cliMetaInf(
      "Pharo 13.0 - 64bit (stable)",
      "https://files.pharo.org/image/130/latest-64.zip",
    ),
  });
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for file: ${filePath}`);
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

  it("resolves a POSIX bash path before falling back to PATH lookup", () => {
    const invocation = buildLauncherCliInvocation(
      ["image", "list", "--ston"],
      launcherConfig({
        launcherDir: "/opt/pharo-launcher",
        launcherVm: "/opt/pharo-launcher/pharo-vm/pharo",
        launcherImage: "/opt/pharo-launcher/PharoLauncher.image",
        launcherScript: "/opt/pharo-launcher/bin/pharo-launcher.sh",
      }),
      {
        platform: "linux",
      },
    );

    const expectedBashPath = ["/bin/bash", "/usr/bin/bash"].find((candidate) =>
      fs.existsSync(candidate),
    );
    expect(invocation.command).toBe(expectedBashPath ?? "bash");
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
        launcherConfiguration:
          "C:\\dev\\code\\git\\.pharo-launcher-mcp\\profiles\\isolated\\launcher\\pharo-launcher-cli-config.ston",
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
      "C:\\dev\\code\\git\\.pharo-launcher-mcp\\profiles\\isolated\\launcher\\pharo-launcher-cli-config.ston",
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

  it("writes profile launcher configuration before live invocation", () => {
    const stateRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pharo-launcher-mcp-profile-"),
    );
    const installationRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pharo-launcher-mcp-installation-"),
    );
    const installationLauncherImage = path.join(
      installationRoot,
      "PharoLauncher.image",
    );
    const installationLauncherChanges = path.join(
      installationRoot,
      "PharoLauncher.changes",
    );
    const configPath = path.join(
      stateRoot,
      "launcher",
      "pharo-launcher-cli-config.ston",
    );
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
    fs.writeFileSync(installationLauncherImage, "launcher-image", "utf8");
    fs.writeFileSync(installationLauncherChanges, "launcher-changes", "utf8");

    ensureProfileLauncherConfiguration(
      launcherConfig({
        launcherDir: "C:\\PL",
        launcherVm: "C:\\PL\\PharoConsole.exe",
        installationLauncherImage,
        launcherImage: profile.launcherImage,
        launcherConfiguration: configPath,
        profile,
      }),
    );

    const configurationContent = fs.readFileSync(configPath, "utf8");
    const normalizedTemplateSourcesDir = path
      .resolve(profile.templateSourcesDir)
      .replaceAll("\\", "/");
    const stonTemplateSourcesDir = /^[A-Za-z]:\//.test(
      normalizedTemplateSourcesDir,
    )
      ? `/${normalizedTemplateSourcesDir}`
      : normalizedTemplateSourcesDir;
    expect(configurationContent).toBe(profileLauncherConfigurationContent(profile));
    expect(configurationContent).toContain(
      `#templateSourcesFileLocation : FILE [ '${stonTemplateSourcesDir}' ]`,
    );
    expect(configurationContent).not.toContain("sources.list");
    expect(fs.existsSync(profile.imagesDir)).toBe(true);
    expect(fs.existsSync(profile.vmsDir)).toBe(true);
    expect(fs.existsSync(profile.templateSourcesDir)).toBe(true);
    expect(fs.existsSync(profile.initScriptsDir)).toBe(true);
    expect(fs.existsSync(profile.logsDir)).toBe(true);
    expect(fs.readFileSync(profile.launcherImage, "utf8")).toBe("launcher-image");
    expect(
      fs.readFileSync(
        profile.launcherImage.replace(/\.image$/i, ".changes"),
        "utf8",
      ),
    ).toBe("launcher-changes");

    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(installationRoot, { recursive: true, force: true });
  });

  it("fails profile setup before invocation when the installation launcher image is missing", () => {
    const stateRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pharo-launcher-mcp-profile-"),
    );
    const markerPath = path.join(stateRoot, "spawned.txt");
    const scriptPath =
      process.platform === "win32"
        ? path.join(stateRoot, "launcher.cmd")
        : path.join(stateRoot, "launcher.sh");
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
    fs.writeFileSync(
      scriptPath,
      process.platform === "win32"
        ? `@echo off\r\necho spawned > "${markerPath}"\r\n`
        : `#!/usr/bin/env sh\necho spawned > "${markerPath}"\n`,
      "utf8",
    );
    if (process.platform !== "win32") {
      fs.chmodSync(scriptPath, 0o755);
    }

    try {
      expect(() =>
        runLauncherCli(["image", "list"], {
          config: launcherConfig({
            launcherDir: stateRoot,
            launcherVm: "unused",
            installationLauncherImage: path.join(
              stateRoot,
              "missing",
              "PharoLauncher.image",
            ),
            launcherImage: profile.launcherImage,
            launcherScript: scriptPath,
            launcherConfiguration: path.join(
              stateRoot,
              "launcher",
              "pharo-launcher-cli-config.ston",
            ),
            profile,
          }),
          timeoutMs: 2_000,
        }),
      ).toThrow(/Cannot bootstrap profile launcher image/);
      expect(fs.existsSync(markerPath)).toBe(false);
    } finally {
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("rejects profile launcher configuration outside the profile root", () => {
    const stateRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pharo-launcher-mcp-profile-"),
    );
    const outsideRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pharo-launcher-mcp-outside-"),
    );
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

    expect(() =>
      ensureProfileLauncherConfiguration(
        launcherConfig({
          launcherDir: "C:\\PL",
          launcherVm: "C:\\PL\\PharoConsole.exe",
          launcherImage: profile.launcherImage,
          launcherConfiguration: path.join(outsideRoot, "config.ston"),
          profile,
        }),
      ),
    ).toThrow(/outside PHARO_LAUNCHER_MCP_STATE_ROOT/);

    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
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

  it("does not report a detached launch that never started", async () => {
    const stateRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pharo-launcher-mcp-detached-failure-"),
    );
    const originalCwd = process.cwd();
    try {
      process.chdir(stateRoot);
      const result = await runLauncherCli(
        ["image", "launch", "--detached", "Task"],
        {
          config: launcherConfig({
            launcherDir: stateRoot,
            launcherVm: "unused",
            launcherImage: path.join(stateRoot, "PharoLauncher.image"),
            // Relative and extensionless, so it is run as a command rather
            // than through bash or cmd, and reaches spawn as it is.
            launcherScript: "no-such-launcher-command",
          }),
          timeoutMs: 2_000,
        },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Detached launch did not start");
      expect(result.stderr).toContain("no-such-launcher-command");
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("redirects detached launcher output to default log files without a profile", async () => {
    const stateRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pharo-launcher-mcp-detached-"),
    );
    const scriptPath =
      process.platform === "win32"
        ? path.join(stateRoot, "launcher.cmd")
        : path.join(stateRoot, "launcher.sh");

    fs.writeFileSync(
      scriptPath,
      process.platform === "win32"
        ? "@echo off\r\necho launched %*\r\n"
        : "#!/usr/bin/env sh\necho launched \"$@\"\n",
      "utf8",
    );
    if (process.platform !== "win32") {
      fs.chmodSync(scriptPath, 0o755);
    }

    const originalCwd = process.cwd();
    try {
      process.chdir(stateRoot);
      const result = await runLauncherCli(
        ["image", "launch", "--detached", "Task"],
        {
          config: launcherConfig({
            launcherDir: stateRoot,
            launcherVm: "unused",
            launcherImage: path.join(stateRoot, "PharoLauncher.image"),
            launcherScript: scriptPath,
          }),
          timeoutMs: 2_000,
        },
      );

      const stdoutPath = result.stdout.match(/^stdout: (.+)$/m)?.[1];
      const stderrPath = result.stdout.match(/^stderr: (.+)$/m)?.[1];
      const logsDir = path.join(stateRoot, ".pharo-launcher-mcp", "logs");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Detached PharoLauncher CLI pid");
      expect(result.launch).toEqual({
        by: "launcher",
        pid: Number(/pid (\d+)\./.exec(result.stdout)?.[1]),
        logs: { stdout: stdoutPath, stderr: stderrPath },
      });
      expect(stdoutPath).toContain(logsDir);
      expect(stderrPath).toContain(logsDir);
      expect(fs.existsSync(stdoutPath ?? "")).toBe(true);
      expect(fs.existsSync(stderrPath ?? "")).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("launches profile-scoped images through a profile-local VM instead of launcher image launch", async () => {
    if (process.platform === "win32") {
      return;
    }

    const stateRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pharo-launcher-mcp-launch-"),
    );
    const launcherCallsPath = path.join(stateRoot, "launcher-calls.txt");
    const vmArgsPath = path.join(stateRoot, "vm-args.txt");
    const launcherScriptPath = path.join(stateRoot, "launcher.sh");
    const installationLauncherImage = path.join(
      stateRoot,
      "installation",
      "PharoLauncher.image",
    );
    const imageName = "Task";
    const vmId = "130-x64";
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
    const imagePath = path.join(profile.imagesDir, imageName, `${imageName}.image`);
    const vmPath = path.join(
      profile.vmsDir,
      vmId,
      "Pharo.app",
      "Contents",
      "MacOS",
      "Pharo",
    );
    const startupScriptPath = path.join(stateRoot, "bootstrap.st");

    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    fs.mkdirSync(path.dirname(vmPath), { recursive: true });
    fs.mkdirSync(path.dirname(installationLauncherImage), { recursive: true });
    fs.writeFileSync(installationLauncherImage, "launcher-image", "utf8");
    writeCreatedImage(profile.imagesDir, imageName);
    fs.writeFileSync(startupScriptPath, "Smalltalk snapshot: false andQuit: true.", "utf8");
    writeExecutableScript(
      launcherScriptPath,
      [
        "#!/usr/bin/env sh",
        `printf '%s\\n' "$*" >> ${shellQuote(launcherCallsPath)}`,
        `echo "unexpected launcher command: $*" >&2`,
        "exit 64",
        "",
      ].join("\n"),
    );
    writeExecutableScript(
      vmPath,
      [
        "#!/usr/bin/env sh",
        `printf '%s\\n' "$@" > ${shellQuote(vmArgsPath)}`,
        "",
      ].join("\n"),
    );

    try {
      const result = await runLauncherCli(
        [
          "image",
          "launch",
          "--script",
          startupScriptPath,
          "--detached",
          imageName,
        ],
        {
          config: launcherConfig({
            launcherDir: stateRoot,
            launcherVm: "unused",
            installationLauncherImage,
            launcherImage: profile.launcherImage,
            launcherScript: launcherScriptPath,
            launcherConfiguration: path.join(
              stateRoot,
              "launcher",
              "pharo-launcher-cli-config.ston",
            ),
            profile,
          }),
          timeoutMs: 2_000,
        },
      );

      await waitForFile(vmArgsPath);

      expect(result.exitCode).toBe(0);
      // The launch is reported twice: as lines for a reader, as fields for a caller.
      expect(result.stdout).toMatch(/^Detached profile-scoped Pharo image pid \d+\.$/m);
      expect(result.stdout).toContain(`image: ${imagePath}`);
      expect(result.stdout).toContain("displayMode: headless");
      expect(result.stdout).toContain(`vm: ${vmPath}`);
      expect(result.stdout).toContain(`vmId: ${vmId}`);
      expect(result.stdout).toContain("vmUpdated: false");
      expect(result.stdout).toMatch(/^stdout: .+\.out\.log$/m);
      expect(result.stdout).toMatch(/^stderr: .+\.err\.log$/m);
      expect(result.launch).toEqual({
        by: "vm",
        imagePath,
        displayMode: "headless",
        vmPath,
        vmId,
        vmUpdated: false,
        pid: Number(/pid (\d+)\./.exec(result.stdout)?.[1]),
        logs: {
          stdout: expect.stringMatching(/-Task-launch\.out\.log$/),
          stderr: expect.stringMatching(/-Task-launch\.err\.log$/),
        },
      });
      expect(path.dirname(result.launch!.logs!.stdout)).toBe(profile.logsDir);
      expect(result.stderr).toBe("");
      expect(result.timedOut).toBe(false);
      // The image is read from the images directory: no Launcher boot.
      expect(fs.existsSync(launcherCallsPath)).toBe(false);
      expect(fs.readFileSync(vmArgsPath, "utf8")).toBe(
        ["--headless", imagePath, "eval", startupScriptPath, ""].join("\n"),
      );
    } finally {
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  // An agent names a script in its project, where the server runs, and the
  // profile's VM runs in the image's directory.
  it("gives the profile VM a relative launch script it can read", async () => {
    if (process.platform === "win32") {
      return;
    }

    const stateRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pharo-launcher-mcp-launch-"),
    );
    const callerDir = path.join(stateRoot, "project");
    const launcherScriptPath = path.join(stateRoot, "launcher.sh");
    const installationLauncherImage = path.join(
      stateRoot,
      "installation",
      "PharoLauncher.image",
    );
    const imageName = "Task";
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
    const imagePath = path.join(profile.imagesDir, imageName, `${imageName}.image`);
    const vmPath = path.join(
      profile.vmsDir,
      "130-x64",
      "Pharo.app",
      "Contents",
      "MacOS",
      "Pharo",
    );
    const checkScriptPath = path.join(callerDir, "check.st");

    fs.mkdirSync(callerDir, { recursive: true });
    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    fs.mkdirSync(path.dirname(vmPath), { recursive: true });
    fs.mkdirSync(path.dirname(installationLauncherImage), { recursive: true });
    fs.writeFileSync(installationLauncherImage, "launcher-image", "utf8");
    writeCreatedImage(profile.imagesDir, imageName);
    fs.writeFileSync(checkScriptPath, "Smalltalk snapshot: false andQuit: true.", "utf8");
    writeExecutableScript(
      launcherScriptPath,
      [
        "#!/usr/bin/env sh",
        `echo "unexpected launcher command: $*" >&2`,
        "exit 64",
        "",
      ].join("\n"),
    );
    // Reads the script the way the VM does: from where it runs.
    writeExecutableScript(
      vmPath,
      [
        "#!/usr/bin/env sh",
        `if [ -f "$4" ]; then echo "script read"; else echo "no script $4 in $(pwd)"; fi`,
        "",
      ].join("\n"),
    );

    const cwd = vi.spyOn(process, "cwd").mockReturnValue(callerDir);
    try {
      const result = await runLauncherCli(
        buildLauncherCommandArgs("pharo_launcher_image_start", {
          imageName,
          script: "check.st",
        })!,
        {
          config: launcherConfig({
            launcherDir: stateRoot,
            launcherVm: "unused",
            installationLauncherImage,
            launcherImage: profile.launcherImage,
            launcherScript: launcherScriptPath,
            launcherConfiguration: path.join(
              stateRoot,
              "launcher",
              "pharo-launcher-cli-config.ston",
            ),
            profile,
          }),
          timeoutMs: 2_000,
        },
      );

      expect(result.stdout).toContain("script read");
      expect(result.exitCode).toBe(0);
    } finally {
      cwd.mockRestore();
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("launches profile-scoped images interactively when requested", async () => {
    if (process.platform === "win32") {
      return;
    }

    const stateRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pharo-launcher-mcp-launch-"),
    );
    const launcherCallsPath = path.join(stateRoot, "launcher-calls.txt");
    const vmArgsPath = path.join(stateRoot, "vm-args.txt");
    const launcherScriptPath = path.join(stateRoot, "launcher.sh");
    const installationLauncherImage = path.join(
      stateRoot,
      "installation",
      "PharoLauncher.image",
    );
    const imageName = "Task";
    const vmId = "130-x64";
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
    const imagePath = path.join(profile.imagesDir, imageName, `${imageName}.image`);
    const vmPath = path.join(
      profile.vmsDir,
      vmId,
      "Pharo.app",
      "Contents",
      "MacOS",
      "Pharo",
    );

    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    fs.mkdirSync(path.dirname(vmPath), { recursive: true });
    fs.mkdirSync(path.dirname(installationLauncherImage), { recursive: true });
    fs.writeFileSync(installationLauncherImage, "launcher-image", "utf8");
    writeCreatedImage(profile.imagesDir, imageName);
    writeExecutableScript(
      launcherScriptPath,
      [
        "#!/usr/bin/env sh",
        `printf '%s\\n' "$*" >> ${shellQuote(launcherCallsPath)}`,
        `echo "unexpected launcher command: $*" >&2`,
        "exit 64",
        "",
      ].join("\n"),
    );
    writeExecutableScript(
      vmPath,
      [
        "#!/usr/bin/env sh",
        `printf '%s\\n' "$@" > ${shellQuote(vmArgsPath)}`,
        "",
      ].join("\n"),
    );

    try {
      const result = await runLauncherCli(
        [
          "image",
          "launch",
          "--displayMode",
          "interactive",
          "--detached",
          imageName,
        ],
        {
          config: launcherConfig({
            launcherDir: stateRoot,
            launcherVm: "unused",
            installationLauncherImage,
            launcherImage: profile.launcherImage,
            launcherScript: launcherScriptPath,
            launcherConfiguration: path.join(
              stateRoot,
              "launcher",
              "pharo-launcher-cli-config.ston",
            ),
            profile,
          }),
          timeoutMs: 2_000,
        },
      );

      await waitForFile(vmArgsPath);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Detached profile-scoped Pharo image pid");
      expect(result.stdout).toContain("displayMode: interactive");
      expect(result.stderr).toBe("");
      // The image is read from the images directory: no Launcher boot.
      expect(fs.existsSync(launcherCallsPath)).toBe(false);
      expect(fs.readFileSync(vmArgsPath, "utf8")).toBe([imagePath, ""].join("\n"));
    } finally {
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("installs a missing profile-local VM before direct profile-scoped launch", async () => {
    if (process.platform === "win32") {
      return;
    }

    const stateRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pharo-launcher-mcp-launch-"),
    );
    const launcherCallsPath = path.join(stateRoot, "launcher-calls.txt");
    const launcherScriptPath = path.join(stateRoot, "launcher.sh");
    const installationLauncherImage = path.join(
      stateRoot,
      "installation",
      "PharoLauncher.image",
    );
    const imageName = "Task";
    const vmId = "130-x64";
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
    const imagePath = path.join(profile.imagesDir, imageName, `${imageName}.image`);
    const vmPath = path.join(
      profile.vmsDir,
      vmId,
      "Pharo.app",
      "Contents",
      "MacOS",
      "Pharo",
    );
    const startupScriptPath = path.join(stateRoot, "bootstrap.st");

    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    fs.mkdirSync(path.dirname(installationLauncherImage), { recursive: true });
    fs.writeFileSync(installationLauncherImage, "launcher-image", "utf8");
    writeImage(profile.imagesDir, imageName, {
      metaInf: guiMetaInf({
        imageName,
        pharoVersion: "130",
        architecture: "64",
        templateName: "Pharo 13.0 - 64bit (stable)",
        url: "https://files.pharo.org/image/130/latest-64.zip",
        vmId,
      }),
    });
    fs.writeFileSync(startupScriptPath, "Smalltalk snapshot: false andQuit: true.", "utf8");
    writeExecutableScript(
      launcherScriptPath,
      [
        "#!/usr/bin/env sh",
        `printf '%s\\n' "$*" >> ${shellQuote(launcherCallsPath)}`,
        `case "$*" in`,
        `  *"vm update ${vmId}"*)`,
        `    mkdir -p ${shellQuote(path.dirname(vmPath))}`,
        `    cat > ${shellQuote(vmPath)} <<'VM'`,
        "#!/usr/bin/env sh",
        "printf 'direct-vm:%s\\n' \"$*\"",
        "VM",
        `    chmod +x ${shellQuote(vmPath)}`,
        "    ;;",
        `  *) echo "unexpected launcher command: $*" >&2; exit 64 ;;`,
        "esac",
        "",
      ].join("\n"),
    );

    try {
      const result = await runLauncherCli(
        ["image", "launch", "--script", startupScriptPath, imageName],
        {
          config: launcherConfig({
            launcherDir: stateRoot,
            launcherVm: "unused",
            installationLauncherImage,
            launcherImage: profile.launcherImage,
            launcherScript: launcherScriptPath,
            launcherConfiguration: path.join(
              stateRoot,
              "launcher",
              "pharo-launcher-cli-config.ston",
            ),
            profile,
          }),
          timeoutMs: 2_000,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("direct-vm:");
      expect(result.stdout).toContain(imagePath);
      expect(result.stdout).toContain(startupScriptPath);
      expect(result.stdout).toContain("vmUpdated: true");
      expect(result.stderr).toBe("");
      expect(result.timedOut).toBe(false);
      // The VM's own output, without the report lines before it.
      expect(result.launch).toEqual({
        by: "vm",
        imagePath,
        displayMode: "headless",
        vmPath,
        vmId,
        vmUpdated: true,
        output: {
          stdout: `direct-vm:--headless ${imagePath} eval ${startupScriptPath}\n`,
          stderr: "",
        },
      });
      expect(fs.readFileSync(launcherCallsPath, "utf8").trim().split("\n")).toEqual([
        expect.stringContaining(`vm update ${vmId}`),
      ]);
      expect(fs.existsSync(vmPath)).toBe(true);
    } finally {
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  describe("a profile launch picks the VM", () => {
    const pharo14 = "Pharo 14.0 - 64bit (next stable)";
    const vmIds = ["140-x64", "120-x64", "130-x64", "90-x86"];

    it.each([
      [
        "of pharo.version and the header, for an image as image create leaves it",
        { metaInf: cliMetaInf(pharo14, "https://files.pharo.org/image/140/latest-64.zip"), pharoVersion: "140" },
        "140-x64",
      ],
      [
        "its last launch used, from meta-inf.ston",
        {
          metaInf: guiMetaInf({
            imageName: "Task",
            pharoVersion: "130",
            architecture: "64",
            templateName: "Pharo 13.0 - 64bit (stable)",
            url: "https://files.pharo.org/image/130/latest-64.zip",
            vmId: "120-x64",
          }),
        },
        "120-x64",
      ],
      [
        "its template's URL names, with no pharo.version",
        { metaInf: cliMetaInf("Pharo 13.0 - 64bit (stable)", "https://files.pharo.org/image/130/latest-64.zip") },
        "130-x64",
      ],
      ["of a 32-bit header", { pharoVersion: "90", format: 6521 }, "90-x86"],
    ])("%s", async (_label, fixture, vmId) => {
      if (process.platform === "win32") {
        return;
      }

      const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-launcher-mcp-vm-"));
      const launcherCallsPath = path.join(stateRoot, "launcher-calls.txt");
      const launcherScriptPath = path.join(stateRoot, "launcher.sh");
      const installationLauncherImage = path.join(stateRoot, "installation", "PharoLauncher.image");
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
      fs.mkdirSync(path.dirname(installationLauncherImage), { recursive: true });
      fs.writeFileSync(installationLauncherImage, "launcher-image", "utf8");
      writeImage(profile.imagesDir, "Task", fixture);
      for (const id of vmIds) {
        const vmPath = path.join(profile.vmsDir, id, "Pharo.app", "Contents", "MacOS", "Pharo");
        fs.mkdirSync(path.dirname(vmPath), { recursive: true });
        writeExecutableScript(vmPath, ["#!/usr/bin/env sh", `echo "ran by ${id}"`, ""].join("\n"));
      }
      writeExecutableScript(
        launcherScriptPath,
        [
          "#!/usr/bin/env sh",
          `printf '%s\\n' "$*" >> ${shellQuote(launcherCallsPath)}`,
          "exit 64",
          "",
        ].join("\n"),
      );

      try {
        const result = await runLauncherCli(["image", "launch", "Task"], {
          config: launcherConfig({
            launcherDir: stateRoot,
            launcherVm: "unused",
            installationLauncherImage,
            launcherImage: profile.launcherImage,
            launcherScript: launcherScriptPath,
            launcherConfiguration: path.join(stateRoot, "launcher", "pharo-launcher-cli-config.ston"),
            profile,
          }),
          timeoutMs: 2_000,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(`vmId: ${vmId}`);
        expect(result.stdout).toContain(`ran by ${vmId}`);
        expect(fs.existsSync(launcherCallsPath)).toBe(false);
      } finally {
        fs.rmSync(stateRoot, { recursive: true, force: true });
      }
    });
  });

  it("says there is no image when the images directory holds none of that name", async () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-launcher-mcp-launch-"));
    const installationLauncherImage = path.join(stateRoot, "installation", "PharoLauncher.image");
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
    fs.mkdirSync(path.dirname(installationLauncherImage), { recursive: true });
    fs.writeFileSync(installationLauncherImage, "launcher-image", "utf8");
    // A hand copy: its files keep the name they were copied from.
    writeImage(profile.imagesDir, "release-check");
    fs.renameSync(
      path.join(profile.imagesDir, "release-check"),
      path.join(profile.imagesDir, "releasecheck"),
    );

    try {
      const result = await runLauncherCli(["image", "launch", "releasecheck"], {
        config: launcherConfig({
          launcherDir: stateRoot,
          launcherVm: "unused",
          installationLauncherImage,
          launcherImage: profile.launcherImage,
          launcherScript: path.join(stateRoot, "never-run.sh"),
          launcherConfiguration: path.join(stateRoot, "launcher", "pharo-launcher-cli-config.ston"),
          profile,
        }),
        timeoutMs: 2_000,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe(
        `There is no image releasecheck in ${path.resolve(profile.imagesDir)}.`,
      );
    } finally {
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  describe("a profile launch that cannot run says why, naming no tool", () => {
    function profileOnDisk(launcherScript: string[]) {
      const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-launcher-mcp-launch-"));
      const installationLauncherImage = path.join(stateRoot, "installation", "PharoLauncher.image");
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
      const launcherScriptPath = path.join(stateRoot, "launcher.sh");
      fs.mkdirSync(path.dirname(installationLauncherImage), { recursive: true });
      fs.writeFileSync(installationLauncherImage, "launcher-image", "utf8");
      writeExecutableScript(launcherScriptPath, ["#!/usr/bin/env sh", ...launcherScript, ""].join("\n"));
      return {
        stateRoot,
        profile,
        config: launcherConfig({
          launcherDir: stateRoot,
          launcherVm: "unused",
          installationLauncherImage,
          launcherImage: profile.launcherImage,
          launcherScript: launcherScriptPath,
          launcherConfiguration: path.join(stateRoot, "launcher", "pharo-launcher-cli-config.ston"),
          profile,
        }),
      };
    }

    it("when nothing gives a Pharo version", async () => {
      const { stateRoot, profile, config } = profileOnDisk(["exit 64"]);
      writeImage(profile.imagesDir, "release-check");

      try {
        const result = await runLauncherCli(["image", "launch", "release-check"], {
          config,
          timeoutMs: 2_000,
        });

        expect(result).toMatchObject({
          exitCode: 1,
          stderr:
            "Cannot tell which VM release-check needs: neither its meta-inf.ston, " +
            "its pharo.version nor its template gives a Pharo version.",
        });
        expect(result).not.toHaveProperty("launch");
      } finally {
        fs.rmSync(stateRoot, { recursive: true, force: true });
      }
    });

    it("when the VM cannot be downloaded", async () => {
      if (process.platform === "win32") {
        return;
      }
      const { stateRoot, profile, config } = profileOnDisk([
        `echo "VM 130-x64 not found on files.pharo.org" >&2`,
        "exit 1",
      ]);
      writeImage(profile.imagesDir, "release-check", { pharoVersion: "130" });

      try {
        const result = await runLauncherCli(["image", "launch", "release-check"], {
          config,
          timeoutMs: 2_000,
        });

        expect(result).toMatchObject({
          exitCode: 1,
          stderr: `Could not download VM 130-x64 into ${profile.vmsDir}: VM 130-x64 not found on files.pharo.org.`,
        });
      } finally {
        fs.rmSync(stateRoot, { recursive: true, force: true });
      }
    });

    it("when the downloaded VM holds no executable", async () => {
      if (process.platform === "win32") {
        return;
      }
      const { stateRoot, profile, config } = profileOnDisk(["exit 0"]);
      writeImage(profile.imagesDir, "release-check", { pharoVersion: "130" });

      try {
        const result = await runLauncherCli(["image", "launch", "release-check"], {
          config,
          timeoutMs: 2_000,
        });

        expect(result).toMatchObject({
          exitCode: 1,
          stderr: `VM 130-x64 was downloaded into ${path.join(profile.vmsDir, "130-x64")}, but no Pharo executable is in it.`,
        });
      } finally {
        fs.rmSync(stateRoot, { recursive: true, force: true });
      }
    });
  });

  it("reports a waited launch outside a profile as the Launcher's", async () => {
    const result = await runLauncherCli(["image", "launch", "Task"], {
      config: launcherConfig({
        launcherDir: process.cwd(),
        launcherVm: "unused",
        launcherImage: "unused",
        launcherScript: process.execPath,
      }),
      timeoutMs: 5_000,
    });

    // node given "image launch Task" fails to find the module "image": what
    // matters is that something ran, and that it was the Launcher's command.
    expect(result.exitCode).not.toBe(null);
    expect(result.launch).toEqual({ by: "launcher" });
  });

  // A VM that crashes, or one a kill from another call stops, has no exit
  // code: it ran all the same, and what it wrote is its output.
  describe("a waited launch a signal ended ran", () => {
    function profileWithVm(vmScript: string[]) {
      const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-launcher-mcp-signal-"));
      const installationLauncherImage = path.join(stateRoot, "installation", "PharoLauncher.image");
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
      const launcherScriptPath = path.join(stateRoot, "launcher.sh");
      const vmPath = path.join(profile.vmsDir, "130-x64", "Pharo.app", "Contents", "MacOS", "Pharo");
      fs.mkdirSync(path.dirname(installationLauncherImage), { recursive: true });
      fs.writeFileSync(installationLauncherImage, "launcher-image", "utf8");
      fs.mkdirSync(path.dirname(vmPath), { recursive: true });
      writeExecutableScript(launcherScriptPath, "#!/usr/bin/env sh\nexit 64\n");
      writeExecutableScript(vmPath, ["#!/usr/bin/env sh", ...vmScript, ""].join("\n"));
      writeImage(profile.imagesDir, "rc", { pharoVersion: "130" });
      return {
        stateRoot,
        vmPath,
        imagePath: path.join(profile.imagesDir, "rc", "rc.image"),
        config: launcherConfig({
          launcherDir: stateRoot,
          launcherVm: "unused",
          installationLauncherImage,
          launcherImage: profile.launcherImage,
          launcherScript: launcherScriptPath,
          launcherConfiguration: path.join(stateRoot, "launcher", "pharo-launcher-cli-config.ston"),
          profile,
        }),
      };
    }

    it("in profile mode, with what the VM wrote", async () => {
      if (process.platform === "win32") {
        return;
      }
      const { stateRoot, vmPath, imagePath, config } = profileWithVm([
        `echo "Segmentation fault, dumping stack" >&2`,
        "kill -SEGV $$",
      ]);

      try {
        const result = await runLauncherCli(["image", "launch", "rc"], { config, timeoutMs: 5_000 });

        expect(result).toMatchObject({ exitCode: null, signal: "SIGSEGV", timedOut: false });
        expect(result.launch).toEqual({
          by: "vm",
          imagePath,
          displayMode: "headless",
          vmPath,
          vmId: "130-x64",
          vmUpdated: false,
          output: { stdout: "", stderr: "Segmentation fault, dumping stack\n" },
        });
      } finally {
        fs.rmSync(stateRoot, { recursive: true, force: true });
      }
    });

    it("outside a profile, as the Launcher's", async () => {
      if (process.platform === "win32") {
        return;
      }
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-launcher-mcp-signal-"));
      const launcherScript = path.join(directory, "launcher.sh");
      writeExecutableScript(launcherScript, "#!/usr/bin/env sh\nkill -KILL $$\n");

      try {
        const result = await runLauncherCli(["image", "launch", "Task"], {
          config: launcherConfig({
            launcherDir: directory,
            launcherVm: "unused",
            launcherImage: "unused",
            launcherScript,
          }),
          timeoutMs: 5_000,
        });

        expect(result).toMatchObject({ exitCode: null, signal: "SIGKILL", timedOut: false });
        expect(result.launch).toEqual({ by: "launcher" });
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });
  });

  it("refuses a display mode it cannot apply", async () => {
    // PharoLauncher's `image launch` takes --script and --detached, nothing
    // else. Without a profile this server runs that command rather than the
    // VM, so there is nowhere to put the mode.
    const result = await runLauncherCli(
      ["image", "launch", "--displayMode", "headless", "Task"],
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

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("needs a scoped launcher profile");
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
    expect(result).not.toHaveProperty("launch");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.timedOut).toBe(false);
    expect(result.timeoutReason).toBeUndefined();
  });

  it("reports pre-spawn diagnostics with command, args, cwd, and PATH", async () => {
    if (process.platform === "win32") {
      return;
    }

    const stateRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pharo-launcher-mcp-enoent-"),
    );
    const scriptPath = path.join(stateRoot, "launcher.sh");
    fs.writeFileSync(scriptPath, "#!/usr/bin/env sh\necho ignored\n", "utf8");
    fs.chmodSync(scriptPath, 0o755);

    try {
      const result = await runLauncherCli(["image", "list"], {
        bashPath: path.join(stateRoot, "missing-bash"),
        config: launcherConfig({
          launcherDir: stateRoot,
          launcherVm: "unused",
          launcherImage: "unused",
          launcherScript: scriptPath,
        }),
        timeoutMs: 2_000,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Failed to start PharoLauncher CLI command");
      expect(result.stderr).toContain(
        "Selected launcher shell path is missing or inaccessible before spawn",
      );
      expect(result.stderr).toContain("source: script");
      expect(result.stderr).toContain(
        `command: ${path.join(stateRoot, "missing-bash")}`,
      );
      expect(result.stderr).toContain(`args: ${scriptPath} image list`);
      expect(result.stderr).toContain(`cwd: ${stateRoot}`);
      expect(result.stderr).toContain("PATH:");
      expect(result.timedOut).toBe(false);
    } finally {
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("creates scoped profile artifacts before reporting a missing create shell", async () => {
    if (process.platform === "win32") {
      return;
    }

    const stateRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pharo-launcher-mcp-create-shell-"),
    );
    const installationRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pharo-launcher-mcp-installation-"),
    );
    const scriptPath = path.join(stateRoot, "launcher.sh");
    const missingBash = path.join(stateRoot, "missing-bash");
    const installationLauncherImage = path.join(
      installationRoot,
      "PharoLauncher.image",
    );
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
    fs.writeFileSync(installationLauncherImage, "launcher-image", "utf8");

    writeExecutableScript(
      scriptPath,
      "#!/usr/bin/env sh\necho should-not-run\n",
    );

    try {
      const result = await runLauncherCli(
        ["image", "create", "--templateName", "Pharo 13", "Task"],
        {
          bashPath: missingBash,
          config: launcherConfig({
            launcherDir: stateRoot,
            launcherVm: "unused",
            installationLauncherImage,
            launcherImage: profile.launcherImage,
            launcherScript: scriptPath,
            launcherConfiguration,
            profile,
          }),
          timeoutMs: 2_000,
        },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        "Selected launcher shell path is missing or inaccessible before spawn",
      );
      expect(result.stderr).toContain(`command: ${missingBash}`);
      expect(result.stderr).toContain(`args: ${scriptPath}`);
      expect(result.stderr).toContain(
        `PHARO_LAUNCHER_MCP_STATE_ROOT: ${stateRoot}`,
      );
      expect(result.stderr).toContain(
        `PHARO_LAUNCHER_MCP_LOGS_DIR: ${profile.logsDir}`,
      );
      expect(fs.existsSync(launcherConfiguration)).toBe(true);
      expect(fs.existsSync(profile.imagesDir)).toBe(true);
      expect(fs.existsSync(profile.vmsDir)).toBe(true);
      expect(fs.existsSync(profile.templateSourcesDir)).toBe(true);
      expect(fs.existsSync(profile.initScriptsDir)).toBe(true);
      expect(fs.existsSync(profile.logsDir)).toBe(true);
      expect(fs.readFileSync(profile.launcherImage, "utf8")).toBe(
        "launcher-image",
      );
    } finally {
      fs.rmSync(stateRoot, { recursive: true, force: true });
      fs.rmSync(installationRoot, { recursive: true, force: true });
    }
  });

  // The standalone server's timeout is a fixed 30 s, and an image create
  // still downloading its template outlives it. The timeout stops the shell
  // running the VM, not the VM, which finishes the create.
  it("lets a launcher command finish past the call's timeout", async () => {
    if (process.platform === "win32") {
      return;
    }

    const stateRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pharo-launcher-mcp-timeout-"),
    );
    const vmPath = path.join(stateRoot, "pharo");
    const createdPath = path.join(stateRoot, "created");
    writeExecutableScript(
      vmPath,
      [
        "#!/usr/bin/env sh",
        "echo downloading",
        "sleep 2",
        `echo created > ${shellQuote(createdPath)}`,
        "",
      ].join("\n"),
    );

    try {
      const result = await runLauncherCli(["image", "create", "Task"], {
        config: launcherConfig({
          launcherDir: stateRoot,
          launcherVm: vmPath,
          launcherImage: path.join(stateRoot, "PharoLauncher.image"),
          launcherScript: bundledLauncherScriptPath(),
        }),
        timeoutMs: 500,
      });

      expect(result.timedOut).toBe(true);
      expect(fs.existsSync(createdPath)).toBe(true);
    } finally {
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  }, 15_000);

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
