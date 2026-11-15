import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LauncherCliRunner } from "./discovery.js";
import type { LauncherCliResult } from "./launcherCli.js";
import {
  openPharoLauncher,
  ProfileTooDeepError,
  ToolInputError,
  type PharoLauncher,
} from "./launcher.js";
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
// so this is what keeps them level.
const functionForTool: Record<string, keyof PharoLauncher> = {
  pharo_launcher_config: "describeConfig",
  pharo_launcher_image_copy_between_profiles: "copyImageBetweenProfiles",
  pharo_launcher_image_copy: "copyImage",
  pharo_launcher_image_create: "createImage",
  pharo_launcher_image_delete: "deleteImage",
  pharo_launcher_image_info: "imageInfo",
  pharo_launcher_image_list: "listImages",
  pharo_launcher_image_start: "startImage",
  pharo_launcher_process_kill: "killProcess",
  pharo_launcher_process_list: "listProcesses",
  pharo_launcher_template_category_list: "listTemplateCategories",
  pharo_launcher_template_list: "listTemplates",
  pharo_launcher_template_update: "updateTemplates",
};

describe("openPharoLauncher", () => {
  it("has a function for every tool the server advertises, and no more", () => {
    const launcher = openPharoLauncher();

    for (const name of toolNames) {
      const functionName = functionForTool[name];
      expect(functionName, `${name} has no library function`).toBeDefined();
      expect(typeof launcher[functionName!]).toBe("function");
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
    expect(result.data).toEqual([]);
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
      templateName: "Pharo 13.0 - 64bit",
      newImageName: "Task",
      noLaunch: true,
    });

    expect(calls[0]?.slice(0, 2)).toEqual(["image", "create"]);
    expect(calls[0]).toContain("--no-launch");
    expect(calls[0]).toContain("Task");
  });

  it("refuses what the catalog refuses", async () => {
    const launcher = openPharoLauncher();

    await expect(
      launcher.killProcess({ pid: 1234, imageName: "Task" } as never),
    ).rejects.toThrow("Give pid or imageName, not both.");
  });

  it("scopes to a profile from an environment, with no process of its own", () => {
    const launcher = openPharoLauncher({
      env: {
        PHARO_LAUNCHER_MCP_PROFILE: "isolated",
        PHARO_LAUNCHER_MCP_STATE_ROOT: "/tmp/plexus-profile",
      },
    });

    expect(launcher.describeConfig().profile?.name).toBe("isolated");
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

const unusedRunner: LauncherCliRunner = async (args) => {
  throw new Error(`the Launcher was called: ${args.join(" ")}`);
};

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
          pharoVersion: "140",
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
    expect(await launcher.imageInfo({ imageName: "BASE" })).toEqual({
      found: true,
      imagesDir: path.resolve(profile.imagesDir),
      image: list.images[0],
    });
    expect(await launcher.imageInfo({ imageName: "pricing-backup" })).toEqual({
      found: false,
      imagesDir: path.resolve(profile.imagesDir),
      notAnImage: list.notImages[0],
    });
    expect(await launcher.imageInfo({ imageName: "releasecheck" })).toEqual({
      found: false,
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
    const info = await launcher.imageInfo({ imageName: "stuck" });

    expect(list.processListFailure).toBe("listing processes is not supported on freebsd");
    expect(list.images[0]).not.toHaveProperty("pids");
    expect(info).toMatchObject({
      found: true,
      processListFailure: "listing processes is not supported on freebsd",
    });
  });

  it("refuse a call that names no image", async () => {
    const launcher = openPharoLauncher({ runner: unusedRunner });

    await expect(launcher.imageInfo({} as never)).rejects.toThrow(
      "imageName is required",
    );
  });
});

describe("the process tools", () => {
  const home = path.join(os.tmpdir(), "no-such-home");
  const latestMcp = path.join(home, "Documents", "Pharo", "images", "LatestMCP", "LatestMCP.image");
  const plexus = path.join(home, ".plexus", "profiles", "images", "x", "x.image");

  function machine(stuck: string): string[] {
    return [
      `17880 /Applications/PharoLauncher.app/Contents/MacOS/Pharo ${latestMcp}`,
      `71513 /vms/140-x64/Pharo.app/Contents/MacOS/Pharo --headless ${stuck}`,
      `71600 /plexus/vms/140-x64/Pharo.app/Contents/MacOS/Pharo ${plexus}`,
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
    const byName = await launcher.killProcess({ imageName: "LatestMCP" });

    expect(listed.data).toEqual([
      {
        pid: 71513,
        commandLine: `/vms/140-x64/Pharo.app/Contents/MacOS/Pharo --headless ${stuck}`,
        executablePath: "/vms/140-x64/Pharo.app/Contents/MacOS/Pharo",
        imagePath: stuck,
        imageName: "stuck",
      },
    ]);
    expect(byPid.ok).toBe(false);
    expect(byName.ok).toBe(false);
    expect(killed).toEqual([]);
  });

  it("see every Pharo VM outside a profile, as on 0.4.1", async () => {
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

    expect(pids((await launcher.listProcesses()).data)).toEqual([17880, 71513, 71600]);
    expect((await launcher.killProcess({ imageName: "LatestMCP" })).ok).toBe(true);
    expect(killed).toEqual([17880]);
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
    expect((await launcher.killProcess({ imageName: "mcp DEBUG" })).ok).toBe(true);
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
    expect((await launcher.killProcess({ imageName: "pricing" })).ok).toBe(false);
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
      templateName: "Pharo 13.0 - 64bit (stable)",
      newImageName: "pricing",
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        image: {
          name: "pricing",
          imagePath: path.join(profile.imagesDir, "pricing", "pricing.image"),
          pharoVersion: "130",
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
      templateName: "Pharo 13.0 - 64bit (stable)",
      newImageName: "release-check",
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
      templateName: "Pharo 13.0 - 64bit (stable)",
      newImageName: "release-check",
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostic: "Pharo Launcher made release-check but cannot open it: Cannot read meta-inf.ston.",
      failure: { kind: "not-opened", message: "Cannot read meta-inf.ston" },
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
      templateName: "Pharo 13.0 - 64bit (stable)",
      newImageName: "release-check",
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostic: `Pharo Launcher said it created release-check, but ${path.join(path.resolve(profile.imagesDir), "release-check")} does not exist after 30 s.`,
      failure: {
        kind: "not-listed",
        directory: path.join(path.resolve(profile.imagesDir), "release-check"),
        seconds: 30,
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
      templateName: "Pharo 13.0 - 64bit (stable)",
      newImageName: "release-check",
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
      seconds: 0,
    });
  });

  it("asks only the Launcher whether a create worked, outside a profile", async () => {
    const userFilesDir = temporary("pharo-launcher-mcp-user-files-");
    const { runner, calls } = recordingRunner(() => exited(0));
    const launcher = openPharoLauncher({ config: testConfig({ userFilesDir }), runner });

    const result = await launcher.createImage({
      templateName: "Pharo 13.0 - 64bit (stable)",
      newImageName: "Task",
    });

    // The settings name no directory holding it: the Launcher's answer is
    // the answer.
    expect(result).toMatchObject({ ok: true, data: {} });
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
      templateName: "Pharo 99",
      newImageName: "Task",
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
      imageName: "pricing",
      newImageName: "pricing-backup",
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
    const { runner } = recordingRunner(() => exited(0));
    const launcher = openPharoLauncher({
      config: testConfig({ profile }),
      runner,
      imageCopyVerificationTimeoutMs: 0,
    });

    const result = await launcher.copyImage({
      imageName: "pricing",
      newImageName: "pricing-backup",
    });

    expect(result.diagnostic).toBe(
      `Pharo Launcher said it copied pricing to pricing-backup, but ${path.join(path.resolve(profile.imagesDir), "pricing-backup")} does not exist after 0 s.`,
    );
  });
});

describe("listTemplates", () => {
  // Measured: every create from a remote template leaves a PhLLocalTemplate of
  // the same name in the Launcher's cache category, which PLexus 0.16.0 lists
  // too, and then refuses as a name in two categories.
  it("leaves out the templates the Launcher keeps on disk, unless asked", async () => {
    const ston =
      "OrderedCollection[" +
      "PhLLocalTemplate{#name:'Pharo 14.0 - 64bit (next stable)',#zipFile:FileReference{#path:'/x/140.zip'}}," +
      "PhLRemoteTemplate{#name:'Pharo 13.0 - 64bit (stable)',#url:URL['https://files.pharo.org/image/130/latest-64.zip']}," +
      "PhLLocalTemplate{#name:'mine'}]";
    const launcher = openPharoLauncher({ config: testConfig({ profile: profileOnDisk() }), runner: stdout(ston) });

    expect((await launcher.listTemplates({ templateCategory: "Templates" })).data).toEqual([
      { name: "Pharo 13.0 - 64bit (stable)", url: "https://files.pharo.org/image/130/latest-64.zip" },
    ]);
    expect((await launcher.listTemplates({ templateCategory: "Templates", includeLocal: true })).data).toEqual([
      { name: "Pharo 14.0 - 64bit (next stable)", local: true },
      { name: "Pharo 13.0 - 64bit (stable)", url: "https://files.pharo.org/image/130/latest-64.zip" },
      { name: "mine", local: true },
    ]);
  });
});

describe("startImage", () => {
  // PLexus's contract test drives the real library with a fake runner and no
  // profile, for an image on no disk: nothing in the library checks first.
  it("reaches the runner outside a profile, for an image on no disk", async () => {
    const { runner, calls } = recordingRunner(() => exited(0, "launched"));
    const launcher = openPharoLauncher({
      config: testConfig({ userFilesDir: temporary("pharo-launcher-mcp-user-files-") }),
      runner,
    });

    const result = await launcher.startImage({ imageName: "plexus-build-1" });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([["image", "launch", "plexus-build-1"]]);
  });

  // A VM there could not load its own modules, and would say a symbol is
  // missing from a file that is there.
  it("refuses a profile too deep for its VM, as a ToolInputError of its own", async () => {
    const profile = profileOnDisk();
    const deep = {
      ...profile,
      vmsDir: path.join(profile.stateRoot, "v".repeat(launcherModulePathLimit)),
    };
    const launcher = openPharoLauncher({
      config: testConfig({ profile: deep }),
      runner: unusedRunner,
    });

    const refusal = await launcher
      .startImage({ imageName: "release-check" })
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(ProfileTooDeepError);
    expect(refusal).toBeInstanceOf(ToolInputError);
    expect((refusal as Error).message).toContain(
      "The VM directory is too deep for Pharo to load its modules",
    );
  });
});
