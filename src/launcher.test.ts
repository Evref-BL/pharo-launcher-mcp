import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LauncherCliRunner } from "./discovery.js";
import type { LauncherCliResult } from "./launcherCli.js";
import { InvalidInputError, ProfileTooDeepError } from "./commandCatalog.js";
import { configForSettings } from "./config.js";
import { getPharoLauncherConfigReport } from "./discovery.js";
import { openLauncher, type PharoLauncher, type StartImageInput } from "./launcher.js";
import * as library from "./library.js";
import { openPharoLauncher as openLibrary } from "./library.js";
import { launcherModulePathLimit } from "./platform.js";
import { toolNames } from "./server.js";
import {
  cliMetaInf,
  guiMetaInf,
  pids,
  psRunner,
  tempDirectory,
  tempProfile,
  testConfig,
  writeImage,
} from "./testing/images.js";

/**
 * The library on a host where no VM runs, unless a test says what runs: the
 * host's own process list is not the test's, and on Windows it takes seconds.
 */
function openPharoLauncher(options: Parameters<typeof openLauncher>[0] = {}): PharoLauncher {
  return openLauncher({ nativeProcess: { platform: "linux", runCommand: psRunner([]) }, ...options });
}

function stdout(text: string): LauncherCliRunner {
  return async () => ({
    exitCode: 0,
    stdout: text,
    stderr: "",
    durationMs: 1,
    timedOut: false,
  });
}

// The tool names exist because MCP needs strings. The functions exist because
// a consumer in the same process does not. Neither list generates the other,
// so this is what keeps them level. `config` says what the command found,
// which a program that opened the library knows; the copy between profiles
// needs no launcher, and is a function of its own.
const functionForTool: Record<string, keyof PharoLauncher | "copyImageBetweenProfiles" | null> = {
  config: null,
  image_copy_between_profiles: "copyImageBetweenProfiles",
  image_copy: "copyImage",
  image_create: "createImage",
  image_delete: "deleteImage",
  image_info: "imageInfo",
  image_list: "listImages",
  image_start: "startImage",
  process_kill: "killProcess",
  process_list: "listProcesses",
  template_category_list: "listTemplateCategories",
  template_list: "listTemplates",
  template_update: "updateTemplates",
};

describe("openPharoLauncher", () => {
  it("has a function for every tool the server advertises, and no more", () => {
    const launcher = openPharoLauncher();

    for (const name of toolNames) {
      const functionName = functionForTool[name];
      expect(functionName, `${name} has no library function`).toBeDefined();
      if (functionName === "copyImageBetweenProfiles") {
        expect(typeof library.copyImageBetweenProfiles).toBe("function");
      } else if (functionName !== null) {
        expect(typeof launcher[functionName!]).toBe("function");
      }
    }

    expect(Object.keys(functionForTool).sort()).toEqual([...toolNames].sort());
  });

  it("answers with the normalized result, not an MCP envelope", async () => {
    const userFilesDir = temporary("pharo-launcher-mcp-user-files-");
    const launcher = openPharoLauncher({
      config: testConfig({ userFilesDir }),
      runner: stdout("Killed"),
      nativeProcess: { platform: "linux", runCommand: psRunner([]), killProcess: () => {} },
    });

    const result = await launcher.listProcesses();

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ processes: [] });
    expect(result).not.toHaveProperty("content");
  });

  it("builds the command the catalog says, from typed arguments", async () => {
    const calls: string[][] = [];
    const launcher = openPharoLauncher({
      config: testConfig({ userFilesDir: temporary("pharo-launcher-mcp-user-files-") }),
      runner: async (args) => {
        calls.push([...args]);
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          durationMs: 1,
          timedOut: false,
        };
      },
      // A create is not done when PharoLauncher exits: it polls until the
      // image can be listed and inspected. This one never appears, and the
      // command it built is what the test is about.
      imageCopyVerificationTimeoutMs: 0,
      sleep: async () => {},
    });

    await launcher.createImage({
      template: "Pharo 13.0 - 64bit",
      image: "Task",
    });

    expect(calls[0]?.slice(0, 2)).toEqual(["image", "create"]);
    expect(calls[0]).toContain("--no-launch");
    expect(calls[0]).toContain("Task");
  });

  it("refuses what the catalog refuses", async () => {
    const launcher = openPharoLauncher();

    await expect(
      launcher.killProcess({ pid: 1234, image: "Task" } as never),
    ).rejects.toThrow("Give pid or image, not both.");
  });

  it("opens on a profile the program names, with no process of its own", async () => {
    const stateRoot = path.resolve("/tmp/isolated-profile");
    const launcher = openLibrary({ profile: { stateRoot, name: "isolated" } });

    expect((await launcher.listImages()).imagesDir).toBe(path.join(stateRoot, "images"));
    expect(configForSettings({ profile: { stateRoot, name: "isolated" } }).profile).toMatchObject({
      name: "isolated",
      stateRoot,
    });
  });

  // Resolved once, from the working directory the program opened it in: the
  // Launcher runs in its own directory, where a relative path means another
  // place.
  it("takes a relative stateRoot from the working directory", async () => {
    const launcher = openLibrary({ profile: { stateRoot: "relative-profile" } });

    expect((await launcher.listImages()).imagesDir).toBe(path.resolve("relative-profile", "images"));
  });

  it("finds an app bundle given with a trailing slash", () => {
    const config = configForSettings(
      { launcherDir: "/Applications/PharoLauncher.app/" },
      { HOME: "/Users/ada" },
      "darwin",
    );

    expect(config.launcherDir).toBe("/Applications/PharoLauncher.app");
    expect(config.launcherVm).toBe("/Applications/PharoLauncher.app/Contents/MacOS/Pharo");
  });

  it("reads a backslash in a POSIX path as part of a name", () => {
    const config = configForSettings({ profile: { stateRoot: "/tmp/a\\b" } }, { HOME: "/Users/ada" }, "darwin");

    expect(config.profile?.stateRoot).toBe("/tmp/a\\b");
    expect(config.profile?.imagesDir).toBe("/tmp/a\\b/images");
  });

  // They are the command's: a program that runs the library under a
  // command's environment gets what it asked for, not the command's profile.
  it("reads none of the command's variables", async () => {
    vi.stubEnv("PHARO_LAUNCHER_MCP_PROFILE", "ambient");
    vi.stubEnv("PHARO_LAUNCHER_MCP_STATE_ROOT", "/tmp/ambient-profile");
    vi.stubEnv("PHARO_LAUNCHER_SCRIPT", process.execPath);
    try {
      expect(configForSettings({}).profile).toBeUndefined();
      expect(getPharoLauncherConfigReport(configForSettings({})).launcherScript.source).not.toBe("env");
      const mine = path.resolve("/tmp/mine");
      expect(configForSettings({ profile: { stateRoot: mine } }).profile).toMatchObject({
        name: "default",
        stateRoot: mine,
      });
      expect((await openLibrary({ profile: { stateRoot: mine } }).listImages()).imagesDir).toBe(
        path.join(mine, "images"),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

const temporaries: string[] = [];

function temporary(prefix: string): string {
  const directory = tempDirectory(prefix);
  temporaries.push(directory);
  return directory;
}

function profileOnDisk() {
  const profile = tempProfile();
  temporaries.push(profile.stateRoot);
  return profile;
}

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaries.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function exited(exitCode: number, stdout = "", stderr = ""): LauncherCliResult {
  return { exitCode, stdout, stderr, durationMs: 1, timedOut: false };
}

/** A runner that records each command and answers what `answer` says. */
function recordingRunner(
  answer: (args: readonly string[]) => LauncherCliResult,
): { runner: LauncherCliRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runner: async (args) => {
      calls.push([...args]);
      return answer(args);
    },
  };
}

// A call that runs a Launcher command turns any throw of its runner into a
// failed result, so a runner that threw would go unnoticed when the answer
// does not change: each call is kept, and a test that made one fails.
const unexpectedLauncherCalls: string[] = [];
const unusedRunner: LauncherCliRunner = async (args) => {
  unexpectedLauncherCalls.push(args.join(" "));
  throw new Error(`the Launcher was called: ${args.join(" ")}`);
};

afterEach(() => {
  const calls = unexpectedLauncherCalls.splice(0);
  expect(calls, "a test that expects no Launcher call made one").toEqual([]);
});

const nextStable = "Pharo 14.0 - 64bit (next stable)";
const nextStableUrl = "https://files.pharo.org/image/140/latest-64.zip";

describe("listImages and imageInfo", () => {
  it("read the profile's images directory, with no Launcher call", async () => {
    const profile = profileOnDisk();
    const base = writeImage(profile.imagesDir, "base", {
      metaInf: cliMetaInf(nextStable, nextStableUrl),
      pharoVersion: "140",
    });
    writeImage(profile.imagesDir, "pricing-backup", { image: false, changes: false });
    const launcher = openPharoLauncher({
      config: testConfig({ profile }),
      runner: unusedRunner,
      nativeProcess: {
        platform: "darwin",
        runCommand: psRunner([`71490 /vms/140-x64/Pharo.app/Contents/MacOS/Pharo ${base}`]),
      },
    });

    const list = await launcher.listImages();

    expect(list).toEqual({
      imagesDir: path.resolve(profile.imagesDir),
      images: [
        {
          name: "base",
          imagePath: base,
          pharoVersion: "14.0",
          architecture: "64",
          template: { name: nextStable, url: nextStableUrl },
          modified: expect.any(String),
          pids: [71490],
        },
      ],
      notImages: [
        {
          name: "pricing-backup",
          directory: path.join(profile.imagesDir, "pricing-backup"),
          hasImage: false,
          hasChanges: false,
        },
      ],
    });
    expect(await launcher.imageInfo({ image: "BASE" })).toEqual({
      kind: "image",
      imagesDir: path.resolve(profile.imagesDir),
      image: list.images[0],
    });
    expect(await launcher.imageInfo({ image: "pricing-backup" })).toEqual({
      kind: "not-an-image",
      imagesDir: path.resolve(profile.imagesDir),
      notAnImage: list.notImages[0],
    });
    expect(await launcher.imageInfo({ image: "releasecheck" })).toEqual({
      kind: "missing",
      imagesDir: path.resolve(profile.imagesDir),
    });
  });

  it("read the directory the Launcher's settings name, outside a profile", async () => {
    const userFilesDir = temporary("pharo-launcher-mcp-user-files-");
    const imagesDir = path.join(userFilesDir, "elsewhere");
    fs.writeFileSync(
      path.join(userFilesDir, "launcherSettings.ston"),
      `PharoLauncherCLIConfiguration { #imagesDirectory : FILE [ '${imagesDir}' ] }`,
    );
    writeImage(imagesDir, "tmp-import");
    writeImage(imagesDir, "tmp-scratch");
    writeImage(imagesDir, "pricing");
    fs.mkdirSync(path.join(imagesDir, "tmp-copy"));
    const launcher = openPharoLauncher({
      config: testConfig({ userFilesDir }),
      runner: unusedRunner,
      nativeProcess: { platform: "linux", runCommand: psRunner([]) },
    });

    const list = await launcher.listImages({ nameFilter: "tmp-" });

    expect(list.imagesDir).toBe(imagesDir);
    expect(list.images.map((image) => [image.name, image.pids])).toEqual([
      ["tmp-import", []],
      ["tmp-scratch", []],
    ]);
    expect(list.notImages.map((directory) => directory.name)).toEqual(["tmp-copy"]);
  });

  it("say why they cannot tell which images run", async () => {
    const profile = profileOnDisk();
    writeImage(profile.imagesDir, "stuck");
    const launcher = openPharoLauncher({
      config: testConfig({ profile }),
      runner: unusedRunner,
      nativeProcess: { platform: "freebsd" },
    });

    const list = await launcher.listImages();
    const info = await launcher.imageInfo({ image: "stuck" });

    expect(list.processListFailure).toBe("listing processes is not supported on freebsd");
    expect(list.images[0]).not.toHaveProperty("pids");
    expect(info).toMatchObject({
      kind: "image",
      processListFailure: "listing processes is not supported on freebsd",
    });
  });

  it("refuse a call that names no image", async () => {
    const launcher = openPharoLauncher({ runner: unusedRunner });

    await expect(launcher.imageInfo({} as never)).rejects.toThrow("image is required");
  });
});

describe("the process tools", () => {
  const home = path.join(os.tmpdir(), "no-such-home");
  const latestMcp = path.join(home, "Documents", "Pharo", "images", "LatestMCP", "LatestMCP.image");
  const profiled = path.join(home, ".tool", "profiles", "images", "x", "x.image");

  function machine(stuck: string): string[] {
    return [
      `17880 /Applications/PharoLauncher.app/Contents/MacOS/Pharo ${latestMcp}`,
      `71513 /vms/140-x64/Pharo.app/Contents/MacOS/Pharo --headless ${stuck}`,
      `71600 /tool/vms/140-x64/Pharo.app/Contents/MacOS/Pharo ${profiled}`,
    ];
  }

  it("see the profile's images alone, in profile mode", async () => {
    const profile = profileOnDisk();
    const stuck = writeImage(profile.imagesDir, "stuck");
    const killed: number[] = [];
    const launcher = openPharoLauncher({
      config: testConfig({ profile }),
      runner: unusedRunner,
      nativeProcess: {
        platform: "darwin",
        runCommand: psRunner(machine(stuck)),
        killProcess: (pid) => killed.push(pid),
      },
    });

    const listed = await launcher.listProcesses();
    const byPid = await launcher.killProcess({ pid: 17880 });
    const byName = await launcher.killProcess({ image: "LatestMCP" });

    expect(listed.data).toEqual({
      processes: [
        {
          pid: 71513,
          commandLine: `/vms/140-x64/Pharo.app/Contents/MacOS/Pharo --headless ${stuck}`,
          executablePath: "/vms/140-x64/Pharo.app/Contents/MacOS/Pharo",
          imagePath: stuck,
          imageName: "stuck",
        },
      ],
    });
    expect(byPid.ok).toBe(false);
    expect(byName.ok).toBe(false);
    expect(killed).toEqual([]);
  });

  it("see only the VMs of this Launcher's images outside a profile too", async () => {
    const userFilesDir = temporary("pharo-launcher-mcp-user-files-");
    const stuck = writeImage(path.join(userFilesDir, "images"), "stuck");
    const killed: number[] = [];
    const launcher = openPharoLauncher({
      config: testConfig({ userFilesDir }),
      runner: unusedRunner,
      nativeProcess: {
        platform: "darwin",
        runCommand: psRunner(machine(stuck)),
        killProcess: (pid) => killed.push(pid),
      },
    });

    expect(pids((await launcher.listProcesses()).data?.processes)).toEqual([71513]);
    expect(await launcher.killProcess({ image: "LatestMCP" })).toMatchObject({
      ok: false,
      failure: { kind: "no-such-process" },
    });
    expect(await launcher.killProcess({ image: "stuck" })).toMatchObject({
      ok: true,
      data: { killed: [71513], failures: [] },
    });
    expect(killed).toEqual([71513]);
  });

  it("find an image whose name holds a space, by name and by pid", async () => {
    const profile = profileOnDisk();
    const debug = writeImage(profile.imagesDir, "MCP debug");
    const killed: number[] = [];
    const launcher = openPharoLauncher({
      config: testConfig({ profile }),
      runner: unusedRunner,
      nativeProcess: {
        platform: "darwin",
        // One line of `ps`, which prints no quotes.
        runCommand: psRunner([`123 /x/vms/130-x64/Pharo.app/Contents/MacOS/Pharo ${debug}`]),
        killProcess: (pid) => killed.push(pid),
      },
    });

    expect((await launcher.listImages()).images[0]?.pids).toEqual([123]);
    expect((await launcher.killProcess({ image: "mcp DEBUG" })).ok).toBe(true);
    expect((await launcher.killProcess({ pid: 123 })).ok).toBe(true);
    expect(killed).toEqual([123, 123]);
  });

  it("do not take a VM on pricing-2025 for one on pricing", async () => {
    const profile = profileOnDisk();
    writeImage(profile.imagesDir, "pricing");
    const other = writeImage(profile.imagesDir, "pricing-2025");
    const killed: number[] = [];
    const launcher = openPharoLauncher({
      config: testConfig({ profile }),
      runner: unusedRunner,
      nativeProcess: {
        platform: "linux",
        runCommand: psRunner([`7 /vms/pharo --headless ${other}`]),
        killProcess: (pid) => killed.push(pid),
      },
    });

    const list = await launcher.listImages();

    expect(list.images.map((image) => [image.name, image.pids])).toEqual([
      ["pricing", []],
      ["pricing-2025", [7]],
    ]);
    expect((await launcher.killProcess({ image: "pricing" })).ok).toBe(false);
    expect(killed).toEqual([]);
  });

  it("fail where processes cannot be listed, with no Launcher call", async () => {
    const launcher = openPharoLauncher({
      config: testConfig({ profile: profileOnDisk() }),
      runner: unusedRunner,
      nativeProcess: { platform: "freebsd" },
    });

    const listed = await launcher.listProcesses();
    const killed = await launcher.killProcess({ pid: 1 });

    expect(listed).toMatchObject({
      ok: false,
      diagnostic: "listing processes is not supported on freebsd",
    });
    expect(killed.ok).toBe(false);
  });
});

describe("createImage and copyImage", () => {
  /** What `image create` leaves: the directory, as the Launcher makes it. */
  function creates(imagesDir: string, name: string): void {
    writeImage(imagesDir, name, {
      metaInf: cliMetaInf("Pharo 13.0 - 64bit (stable)", "https://files.pharo.org/image/130/latest-64.zip"),
      pharoVersion: "130",
    });
  }

  it("creates an image whose name another image's name holds, on the first attempt", async () => {
    const profile = profileOnDisk();
    writeImage(profile.imagesDir, "pricing-2025");
    const { runner, calls } = recordingRunner((args) => {
      if (args[1] === "create") {
        creates(profile.imagesDir, "pricing");
      }
      return exited(0);
    });
    const launcher = openPharoLauncher({ config: testConfig({ profile }), runner });

    const result = await launcher.createImage({
      template: "Pharo 13.0 - 64bit (stable)",
      image: "pricing",
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        image: {
          name: "pricing",
          imagePath: path.join(profile.imagesDir, "pricing", "pricing.image"),
          pharoVersion: "13.0",
          architecture: "64",
          template: { name: "Pharo 13.0 - 64bit (stable)" },
        },
      },
    });
    expect(result).not.toHaveProperty("createVerification");
    expect(calls).toEqual([
      ["image", "create", "--no-launch", "--templateName", "Pharo 13.0 - 64bit (stable)", "pricing"],
      ["image", "info", "pricing"],
    ]);
  });

  it("succeeds when a create outlives the call but makes its image", async () => {
    const profile = profileOnDisk();
    const { runner } = recordingRunner((args) => {
      if (args[1] === "create") {
        creates(profile.imagesDir, "release-check");
        return {
          ...exited(0),
          exitCode: null,
          timedOut: true,
          timeoutReason: "PharoLauncher CLI timed out after 30000ms",
        };
      }
      return exited(0);
    });
    const launcher = openPharoLauncher({ config: testConfig({ profile }), runner });

    const result = await launcher.createImage({
      template: "Pharo 13.0 - 64bit (stable)",
      image: "release-check",
    });

    expect(result).toMatchObject({
      ok: true,
      command: { timedOut: true },
      data: { image: { name: "release-check" } },
    });
  });

  it("fails a create the Launcher cannot open", async () => {
    const profile = profileOnDisk();
    const { runner } = recordingRunner((args) => {
      if (args[1] === "create") {
        creates(profile.imagesDir, "release-check");
        return exited(0);
      }
      return exited(1, "", "Cannot read meta-inf.ston");
    });
    const launcher = openPharoLauncher({
      config: testConfig({ profile }),
      runner,
      imageCopyVerificationTimeoutMs: 0,
    });

    const result = await launcher.createImage({
      template: "Pharo 13.0 - 64bit (stable)",
      image: "release-check",
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostic: "Pharo Launcher made release-check but cannot open it: Cannot read meta-inf.ston.",
      failure: { kind: "not-opened", diagnostic: "Cannot read meta-inf.ston" },
    });
    expect(result).not.toHaveProperty("data");
  });

  it("fails a create whose image never appears, after polling for 30 s", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const profile = profileOnDisk();
    const sleeps: number[] = [];
    const { runner, calls } = recordingRunner(() => exited(0));
    const launcher = openPharoLauncher({
      config: testConfig({ profile }),
      runner,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        vi.setSystemTime(Date.now() + milliseconds);
      },
    });

    const result = await launcher.createImage({
      template: "Pharo 13.0 - 64bit (stable)",
      image: "release-check",
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostic: `Pharo Launcher said it created release-check, but ${path.join(path.resolve(profile.imagesDir), "release-check")} does not exist after 30 s.`,
      failure: {
        kind: "not-listed",
        directory: path.join(path.resolve(profile.imagesDir), "release-check"),
        waitedMs: 30_000,
      },
    });
    expect(sleeps).toEqual(Array(30).fill(1_000));
    // Listed is the directory: the Launcher is not asked until it is there.
    expect(calls).toHaveLength(1);
  });

  it("says what a directory left by a create lacks", async () => {
    const profile = profileOnDisk();
    const { runner } = recordingRunner((args) => {
      if (args[1] === "create") {
        writeImage(profile.imagesDir, "release-check", { changes: false });
      }
      return exited(0);
    });
    const launcher = openPharoLauncher({
      config: testConfig({ profile }),
      runner,
      imageCopyVerificationTimeoutMs: 0,
    });

    const result = await launcher.createImage({
      template: "Pharo 13.0 - 64bit (stable)",
      image: "release-check",
    });

    expect(result.diagnostic).toBe(
      `Pharo Launcher said it created release-check, but ${path.join(path.resolve(profile.imagesDir), "release-check")} holds no release-check.changes after 0 s.`,
    );
    expect(result.failure).toEqual({
      kind: "not-listed",
      directory: path.join(path.resolve(profile.imagesDir), "release-check"),
      notAnImage: {
        name: "release-check",
        directory: path.join(path.resolve(profile.imagesDir), "release-check"),
        hasImage: true,
        hasChanges: false,
      },
      waitedMs: 0,
    });
  });

  it("asks only the Launcher whether a create worked, outside a profile", async () => {
    const userFilesDir = temporary("pharo-launcher-mcp-user-files-");
    const { runner, calls } = recordingRunner(() => exited(0));
    const launcher = openPharoLauncher({ config: testConfig({ userFilesDir }), runner });

    const result = await launcher.createImage({
      template: "Pharo 13.0 - 64bit (stable)",
      image: "Task",
    });

    // The settings name no directory holding it: the Launcher's answer is
    // the answer.
    expect(result.ok).toBe(true);
    expect(result.data).toBeUndefined();
    expect(calls).toEqual([
      ["image", "create", "--no-launch", "--templateName", "Pharo 13.0 - 64bit (stable)", "Task"],
      ["image", "info", "Task"],
    ]);
  });

  it("does not check a create the Launcher refused", async () => {
    const profile = profileOnDisk();
    const { runner, calls } = recordingRunner(() =>
      exited(1, "", "Pharo 99 not found, please enter a correct template name"),
    );
    const launcher = openPharoLauncher({ config: testConfig({ profile }), runner });

    const result = await launcher.createImage({
      template: "Pharo 99",
      image: "Task",
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostic: "Pharo 99 not found, please enter a correct template name",
    });
    expect(calls).toHaveLength(1);
  });

  it("copies an image, and still renames the copied #vmManager path", async () => {
    const profile = profileOnDisk();
    writeImage(profile.imagesDir, "pricing", {
      metaInf: guiMetaInf({
        imageName: "pricing",
        pharoVersion: "140",
        architecture: "64",
        templateName: nextStable,
        url: nextStableUrl,
        vmId: "140-x64",
      }),
    });
    const { runner, calls } = recordingRunner((args) => {
      if (args[1] === "copy") {
        // A copy that renames the files and leaves the path its metadata
        // records, which the repair renames.
        fs.cpSync(
          path.join(profile.imagesDir, "pricing"),
          path.join(profile.imagesDir, "pricing-backup"),
          { recursive: true },
        );
        for (const extension of ["image", "changes"]) {
          fs.renameSync(
            path.join(profile.imagesDir, "pricing-backup", `pricing.${extension}`),
            path.join(profile.imagesDir, "pricing-backup", `pricing-backup.${extension}`),
          );
        }
      }
      return exited(0);
    });
    const launcher = openPharoLauncher({ config: testConfig({ profile }), runner });

    const result = await launcher.copyImage({
      image: "pricing",
      newImage: "pricing-backup",
    });

    expect(result).toMatchObject({
      ok: true,
      data: { image: { name: "pricing-backup", vmId: "140-x64" } },
    });
    expect(result).not.toHaveProperty("metadataRepair");
    expect(calls).toEqual([
      ["image", "copy", "pricing", "pricing-backup"],
      ["image", "info", "pricing-backup"],
    ]);
    expect(
      fs.readFileSync(path.join(profile.imagesDir, "pricing-backup", "meta-inf.ston"), "utf8"),
    ).toContain("RelativePath [ 'pricing-backup', 'pricing-backup.image' ]");
  });

  it("fails a copy whose image never appears", async () => {
    const profile = profileOnDisk();
    writeImage(profile.imagesDir, "pricing");
    const { runner } = recordingRunner(() => exited(0));
    const launcher = openPharoLauncher({
      config: testConfig({ profile }),
      runner,
      imageCopyVerificationTimeoutMs: 0,
    });

    const result = await launcher.copyImage({
      image: "pricing",
      newImage: "pricing-backup",
    });

    expect(result.diagnostic).toBe(
      `Pharo Launcher said it copied pricing to pricing-backup, but ${path.join(path.resolve(profile.imagesDir), "pricing-backup")} does not exist after 0 s.`,
    );
  });
});

describe("listTemplates", () => {
  // Measured: every create from a remote template leaves a PhLLocalTemplate of
  // the same name in the Launcher's cache category, which would otherwise be
  // listed as a second template of that name.
  it("leaves out the templates the Launcher keeps on disk, unless asked", async () => {
    const ston =
      "OrderedCollection[" +
      "PhLLocalTemplate{#name:'Pharo 14.0 - 64bit (next stable)',#zipFile:FileReference{#path:'/x/140.zip'}}," +
      "PhLRemoteTemplate{#name:'Pharo 13.0 - 64bit (stable)',#url:URL['https://files.pharo.org/image/130/latest-64.zip']}," +
      "PhLLocalTemplate{#name:'mine'}]";
    const launcher = openPharoLauncher({ config: testConfig({ profile: profileOnDisk() }), runner: stdout(ston) });

    expect((await launcher.listTemplates({ category: "Templates" })).data).toEqual({
      templates: [
        { name: "Pharo 13.0 - 64bit (stable)", url: "https://files.pharo.org/image/130/latest-64.zip" },
      ],
    });
    expect((await launcher.listTemplates({ category: "Templates", includeLocal: true })).data).toEqual({
      templates: [
        { name: "Pharo 14.0 - 64bit (next stable)", local: true },
        { name: "Pharo 13.0 - 64bit (stable)", url: "https://files.pharo.org/image/130/latest-64.zip" },
        { name: "mine", local: true },
      ],
    });
  });
});

describe("startImage", () => {
  // A caller's test can drive the real library with a fake runner and no
  // profile, for an image on no disk: nothing in the library checks first.
  it("reaches the runner outside a profile, for an image on no disk", async () => {
    const { runner, calls } = recordingRunner(() => exited(0, "launched"));
    const launcher = openPharoLauncher({
      config: testConfig({ userFilesDir: temporary("pharo-launcher-mcp-user-files-") }),
      runner,
    });

    const result = await launcher.startImage({ image: "build-1" });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([["image", "launch", "build-1"]]);
  });

  // A VM there could not load its own modules, and would say a symbol is
  // missing from a file that is there.
  it("refuses a profile too deep for its VM, as an InvalidInputError of its own", async () => {
    const profile = profileOnDisk();
    writeImage(profile.imagesDir, "release-check");
    const deep = {
      ...profile,
      vmsDir: path.join(profile.stateRoot, "v".repeat(launcherModulePathLimit)),
    };
    const launcher = openPharoLauncher({
      config: testConfig({ profile: deep }),
      runner: unusedRunner,
    });

    const refusal = await launcher
      .startImage({ image: "release-check" })
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(ProfileTooDeepError);
    expect(refusal).toBeInstanceOf(InvalidInputError);
    expect((refusal as Error).message).toContain(
      "The VM directory is too deep for Pharo to load its modules",
    );
  });
});

describe("deleteImage and deleteLaunchLogs", () => {
  function writeLogs(logsDir: string, imageName: string): string[] {
    fs.mkdirSync(logsDir, { recursive: true });
    const files = ["out", "err"].map((stream) =>
      path.join(logsDir, `2026-01-01T00-00-00-000Z-${imageName}-launch.${stream}.log`),
    );
    for (const file of files) {
      fs.writeFileSync(file, "");
    }
    return files;
  }

  it("deletes the logs of the image's starts once the Launcher deleted it", async () => {
    const profile = profileOnDisk();
    writeImage(profile.imagesDir, "task");
    const taskLogs = writeLogs(profile.logsDir, "task");
    const otherLogs = writeLogs(profile.logsDir, "task-2");
    const { runner, calls } = recordingRunner(() => {
      fs.rmSync(path.join(profile.imagesDir, "task"), { recursive: true, force: true });
      return exited(0);
    });
    const launcher = openPharoLauncher({ config: testConfig({ profile }), runner });

    const result = await launcher.deleteImage({ image: "task" });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([["image", "delete", "--force", "task"]]);
    expect(taskLogs.filter((file) => fs.existsSync(file))).toEqual([]);
    expect(otherLogs.filter((file) => fs.existsSync(file))).toEqual(otherLogs);
  });

  it("keeps the logs when the Launcher did not delete the image", async () => {
    const profile = profileOnDisk();
    writeImage(profile.imagesDir, "task");
    const taskLogs = writeLogs(profile.logsDir, "task");
    const launcher = openPharoLauncher({
      config: testConfig({ profile }),
      runner: async () => exited(1, "", "cannot delete"),
    });

    const result = await launcher.deleteImage({ image: "task" });

    expect(result.ok).toBe(false);
    expect(taskLogs.filter((file) => fs.existsSync(file))).toEqual(taskLogs);
  });

  it("deletes the logs of an image whose directory a caller removed itself, with no Launcher call", async () => {
    const profile = profileOnDisk();
    const taskLogs = writeLogs(profile.logsDir, "task");
    const launcher = openPharoLauncher({ config: testConfig({ profile }), runner: unusedRunner });

    await launcher.deleteLaunchLogs({ image: "task" });

    expect(taskLogs.filter((file) => fs.existsSync(file))).toEqual([]);
  });

  it("keeps the logs of an image the images directory still holds", async () => {
    const profile = profileOnDisk();
    writeImage(profile.imagesDir, "task");
    const taskLogs = writeLogs(profile.logsDir, "task");
    const launcher = openPharoLauncher({ config: testConfig({ profile }), runner: unusedRunner });

    await launcher.deleteLaunchLogs({ image: "task" });

    expect(taskLogs.filter((file) => fs.existsSync(file))).toEqual(taskLogs);
  });

  it("refuses a call that names no image", async () => {
    const launcher = openPharoLauncher({
      config: testConfig({ profile: profileOnDisk() }),
      runner: unusedRunner,
    });

    await expect(launcher.deleteLaunchLogs({} as { image: string })).rejects.toThrow(InvalidInputError);
  });
});

describe("what the library refuses before running anything", () => {
  function onProfile(running: string[] = []) {
    const profile = profileOnDisk();
    const launcher = openPharoLauncher({
      config: testConfig({ profile }),
      runner: unusedRunner,
      nativeProcess: { platform: "darwin", runCommand: psRunner(running) },
    });
    return { profile, launcher };
  }

  it("a new name an image of the profile has, in any case", async () => {
    const { profile, launcher } = onProfile();
    writeImage(profile.imagesDir, "Pricing");
    writeImage(profile.imagesDir, "base");

    expect(await launcher.createImage({ image: "pricing", template: "Pharo 14.0 - 64bit" })).toMatchObject({
      ok: false,
      failure: { kind: "name-taken", image: "Pricing" },
      diagnostic: `There is already an image Pricing in ${path.resolve(profile.imagesDir)}`,
      action: "Pick another name, or delete that image first.",
    });
    expect(await launcher.copyImage({ image: "base", newImage: "PRICING" })).toMatchObject({
      ok: false,
      failure: { kind: "name-taken", image: "Pricing" },
    });
  });

  it("an image the profile does not have, to copy or start", async () => {
    const { profile, launcher } = onProfile();
    writeImage(profile.imagesDir, "half", { changes: false });

    expect(await launcher.copyImage({ image: "nowhere", newImage: "task" })).toMatchObject({
      ok: false,
      failure: { kind: "no-such-image", image: "nowhere" },
      diagnostic: `There is no image nowhere in ${path.resolve(profile.imagesDir)}`,
    });
    const started = await launcher.startImage({ image: "half" });
    expect(started).toMatchObject({
      ok: false,
      failure: { kind: "no-such-image", image: "half", notAnImage: { hasChanges: false } },
    });
    expect(started).not.toHaveProperty("command");
  });

  it("a delete of an image a VM runs, or of one it cannot tell", async () => {
    const { profile, launcher } = onProfile();
    const task = writeImage(profile.imagesDir, "task");
    const running = openPharoLauncher({
      config: testConfig({ profile }),
      runner: unusedRunner,
      nativeProcess: { platform: "darwin", runCommand: psRunner([`4242 /vms/140-x64/Pharo ${task}`]) },
    });
    const blind = openPharoLauncher({
      config: testConfig({ profile }),
      runner: unusedRunner,
      nativeProcess: { platform: "freebsd" },
    });

    expect(await running.deleteImage({ image: "TASK" })).toMatchObject({
      ok: false,
      failure: { kind: "image-running", pids: [4242] },
      diagnostic: "Image task runs as pid 4242",
      action: "Stop it, then delete it.",
    });
    expect(await blind.deleteImage({ image: "task" })).toMatchObject({
      ok: false,
      failure: {
        kind: "process-list-failed",
        diagnostic: "listing processes is not supported on freebsd",
      },
    });
    expect(await launcher.deleteImage({ image: "gone" })).toMatchObject({
      ok: false,
      failure: { kind: "no-such-image", image: "gone" },
    });
    expect(fs.existsSync(task)).toBe(true);
  });

  it("a kill when the process list fails", async () => {
    const profile = profileOnDisk();
    writeImage(profile.imagesDir, "task");
    const blind = openPharoLauncher({
      config: testConfig({ profile }),
      runner: unusedRunner,
      nativeProcess: { platform: "freebsd" },
    });

    expect(await blind.killProcess({ image: "task" })).toMatchObject({
      ok: false,
      failure: {
        kind: "process-list-failed",
        diagnostic: "listing processes is not supported on freebsd",
      },
    });
  });

  it("a delete of a running image outside a profile too", async () => {
    const userFilesDir = temporary("pharo-launcher-mcp-user-files-");
    const task = writeImage(path.join(userFilesDir, "images"), "task");
    const launcher = openPharoLauncher({
      config: testConfig({ userFilesDir }),
      runner: unusedRunner,
      nativeProcess: { platform: "linux", runCommand: psRunner([`77 /vms/pharo ${task}`]) },
    });

    expect(await launcher.deleteImage({ image: "task" })).toMatchObject({
      ok: false,
      failure: { kind: "image-running", pids: [77] },
    });
  });

  it.each([
    ["createImage", { image: "../escape", template: "Pharo 14.0 - 64bit" }, "image"],
    ["copyImage", { image: "base", newImage: "a/b" }, "newImage"],
    ["startImage", { image: ".." }, "image"],
    ["deleteImage", { image: "C:\\Users\\me\\Pharo\\images\\x" }, "image"],
    ["killProcess", { image: "x/../y" }, "image"],
    ["imageInfo", { image: "/abs" }, "image"],
  ] as const)("%s of a name that is a path", async (method, input, key) => {
    const { launcher } = onProfile();
    const call = launcher[method] as (input: unknown) => Promise<unknown>;

    await expect(call(input)).rejects.toThrow(`${key} must be an image name, not a path`);
  });

  it.each([
    ["createImage", { image: ".hidden", template: "Pharo 14.0 - 64bit" }, "image"],
    ["copyImage", { image: "base", newImage: ".copy" }, "newImage"],
    ["deleteImage", { image: ".hidden" }, "image"],
  ] as const)("%s of a name starting with a dot, which no listing shows", async (method, input, key) => {
    const { launcher } = onProfile();
    const call = launcher[method] as (input: unknown) => Promise<unknown>;

    await expect(call(input)).rejects.toThrow(`${key} must be an image name, which never starts with a dot`);
  });

  it("a display mode outside a profile, which the Launcher's own launch has not", async () => {
    const launcher = openPharoLauncher({
      config: testConfig({ userFilesDir: temporary("pharo-launcher-mcp-user-files-") }),
      runner: unusedRunner,
    });

    await expect(launcher.startImage({ image: "task", displayMode: "interactive" })).rejects.toThrow(
      InvalidInputError,
    );
  });

  it("takes an argument given as null as left out", async () => {
    const profile = profileOnDisk();
    const { runner, calls } = recordingRunner(() => exited(0, "OrderedCollection[]"));
    const launcher = openPharoLauncher({ config: testConfig({ profile }), runner });

    const result = await launcher.listTemplates({ category: null } as unknown as { category?: string });

    expect(result).toMatchObject({ ok: true, data: { templates: [] } });
    expect(calls).toEqual([["template", "list", "--ston"]]);
  });

  it("takes a null display mode outside a profile as left out", async () => {
    const { runner, calls } = recordingRunner(() => exited(0));
    const launcher = openPharoLauncher({
      config: testConfig({ userFilesDir: temporary("pharo-launcher-mcp-user-files-") }),
      runner,
    });

    await launcher.startImage({ image: "task", displayMode: null } as unknown as StartImageInput);

    expect(calls).toEqual([["image", "launch", "task"]]);
  });
});

describe("what a failure says", () => {
  it("says no templates yet when a profile has none and the Launcher knows no category", async () => {
    const profile = profileOnDisk();
    const launcher = openPharoLauncher({
      config: testConfig({ profile }),
      runner: async () =>
        exited(1, "", "NotFound: Official distributions not found, please enter a correct category name"),
    });

    expect(await launcher.createImage({ image: "task", template: "Pharo 14.0 - 64bit" })).toMatchObject({
      ok: false,
      failure: { kind: "no-templates" },
      diagnostic: "This profile has no templates yet",
      action: "Update the templates first.",
    });
    fs.mkdirSync(profile.templateSourcesDir, { recursive: true });
    fs.writeFileSync(path.join(profile.templateSourcesDir, "sources.list"), "OrderedCollection [ ]");
    expect((await launcher.listTemplates({})).failure).toEqual({ kind: "unknown-category" });
  });

  it("says how a command ended that wrote nothing", async () => {
    const launcher = openPharoLauncher({
      config: testConfig({ userFilesDir: temporary("pharo-launcher-mcp-user-files-") }),
      runner: async () => exited(3),
    });

    expect(await launcher.listTemplateCategories()).toMatchObject({
      ok: false,
      diagnostic: "it exited with 3",
    });
  });

  it("says nothing failed of a create that outlived the call but made its image", async () => {
    const profile = profileOnDisk();
    const launcher = openPharoLauncher({
      config: testConfig({ profile }),
      runner: async (args) => {
        if (args[1] === "create") {
          writeImage(profile.imagesDir, "task");
          return {
            exitCode: null,
            stdout: "Creating the local Pharo image...",
            stderr: "",
            durationMs: 30_000,
            timedOut: true,
          };
        }
        return exited(0);
      },
      imageCopyVerificationTimeoutMs: 0,
    });

    const result = await launcher.createImage({ image: "task", template: "Pharo 14.0 - 64bit" });

    expect(result).toMatchObject({ ok: true, command: { timedOut: true }, data: { image: { name: "task" } } });
    expect(result).not.toHaveProperty("diagnostic");
  });
});
