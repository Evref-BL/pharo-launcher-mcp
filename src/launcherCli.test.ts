import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PharoLauncherConfig } from "./config.js";
import {
  buildLauncherCliInvocation,
  ensureProfileLauncherConfiguration,
  isDetachedImageLaunch,
  launcherArgsForDetachedImageLaunch,
  profileLauncherConfigurationContent,
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function writeExecutableScript(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, "utf8");
  fs.chmodSync(filePath, 0o755);
}

function launcherImageInfoSton(imageName: string, vmId = "130-x64"): string {
  return `OrderedCollection[PhLImage{#formatNumber:68021,#architecture:'64',#pharoVersion:'130',#originTemplate:PhLRemoteTemplate{#name:'Pharo 13'},#vmManager:PhLVirtualMachineManager{#imageFile:FileLocator{#path:RelativePath['${imageName}','${imageName}.image'],#origin:#launcherImagesLocation}},#launchConfigurations:OrderedCollection[PhLLaunchConfiguration{#vm:PhLVirtualMachine{#id:'${vmId}',#blessing:'stable'}}]}]`;
}

function launcherTemplateOnlyImageInfoSton(imageName: string): string {
  return `[PhLImage{#originTemplate:PhLRemoteTemplate{#name:'Pharo 13.0 - 64bit (stable)',#url:URL['https://files.pharo.org/image/130/latest-64.zip']},#launchConfigurations:OrderedCollection[],#shouldRunInitializationScript:true}]`;
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

    ensureProfileLauncherConfiguration(
      launcherConfig({
        launcherDir: "C:\\PL",
        launcherVm: "C:\\PL\\PharoConsole.exe",
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

    fs.rmSync(stateRoot, { recursive: true, force: true });
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
    fs.writeFileSync(imagePath, "", "utf8");
    fs.writeFileSync(startupScriptPath, "Smalltalk snapshot: false andQuit: true.", "utf8");
    writeExecutableScript(
      launcherScriptPath,
      [
        "#!/usr/bin/env sh",
        `printf '%s\\n' "$*" >> ${shellQuote(launcherCallsPath)}`,
        `case "$*" in`,
        `  *"image info --ston ${imageName}"*) printf '%s\\n' ${shellQuote(launcherTemplateOnlyImageInfoSton(imageName))} ;;`,
        `  *) echo "unexpected launcher command: $*" >&2; exit 64 ;;`,
        "esac",
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
      expect(result.stdout).toContain(`image: ${imagePath}`);
      expect(result.stdout).toContain(`vm: ${vmPath}`);
      expect(result.stdout).toContain("vmUpdated: false");
      expect(result.stderr).toBe("");
      expect(result.timedOut).toBe(false);
      expect(fs.readFileSync(launcherCallsPath, "utf8")).toContain(
        `image info --ston ${imageName}`,
      );
      expect(fs.readFileSync(launcherCallsPath, "utf8")).not.toContain(
        "image launch",
      );
      expect(fs.readFileSync(vmArgsPath, "utf8")).toBe(
        ["--headless", imagePath, "eval", startupScriptPath, ""].join("\n"),
      );
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
    fs.writeFileSync(imagePath, "", "utf8");
    fs.writeFileSync(startupScriptPath, "Smalltalk snapshot: false andQuit: true.", "utf8");
    writeExecutableScript(
      launcherScriptPath,
      [
        "#!/usr/bin/env sh",
        `printf '%s\\n' "$*" >> ${shellQuote(launcherCallsPath)}`,
        `case "$*" in`,
        `  *"image info --ston ${imageName}"*) printf '%s\\n' ${shellQuote(launcherImageInfoSton(imageName, vmId))} ;;`,
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
      expect(result.stderr).toBe("");
      expect(result.timedOut).toBe(false);
      expect(fs.readFileSync(launcherCallsPath, "utf8")).toContain(
        `vm update ${vmId}`,
      );
      expect(fs.existsSync(vmPath)).toBe(true);
    } finally {
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("refuses profile-scoped fromBuild before launcher VM store selection can escape", async () => {
    const stateRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pharo-launcher-mcp-from-build-"),
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
      const result = await runLauncherCli(
        [
          "image",
          "create",
          "fromBuild",
          "--pharoVersion",
          "13",
          "--newImageName",
          "ScopedBuild",
          "1",
        ],
        {
          config: launcherConfig({
            launcherDir: stateRoot,
            launcherVm: "unused",
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
        },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("profile-scoped image create fromBuild");
      expect(result.stderr).toContain("PHARO_LAUNCHER_MCP_VMS_DIR");
      expect(result.stderr).toContain(profile.vmsDir);
      expect(result.timedOut).toBe(false);
      expect(fs.existsSync(markerPath)).toBe(false);
    } finally {
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
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

  it("reports ENOENT diagnostics with command, cwd, and PATH", async () => {
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

      expect(result.exitCode).toBeNull();
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Failed to start PharoLauncher CLI command");
      expect(result.stderr).toContain(
        `command: ${path.join(stateRoot, "missing-bash")}`,
      );
      expect(result.stderr).toContain(`cwd: ${stateRoot}`);
      expect(result.stderr).toContain("PATH:");
      expect(result.timedOut).toBe(false);
    } finally {
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
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
