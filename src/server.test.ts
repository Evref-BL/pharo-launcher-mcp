import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import type { PharoLauncherConfig, PharoLauncherProfileConfig } from "./config.js";
import type { LauncherCliRunner } from "./discovery.js";
import type { LauncherCliResult } from "./launcherCli.js";
import type { LauncherLaunchReport } from "./models.js";
import type { CallToolOptions } from "./launcher.js";
import { callTool, createServer, toolNames } from "./server.js";
import {
  cliMetaInf,
  psRunner,
  tempDirectory,
  tempProfile,
  testConfig,
  writeImage,
} from "./testing/images.js";

const temporaries: string[] = [];

afterEach(() => {
  for (const directory of temporaries.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporary(prefix: string): string {
  const directory = tempDirectory(prefix);
  temporaries.push(directory);
  return directory;
}

function text(result: Awaited<ReturnType<typeof callTool>>): string {
  return result.content[0]?.text ?? "";
}

const nextStable = "Pharo 14.0 - 64bit (next stable)";
const nextStableUrl = "https://files.pharo.org/image/140/latest-64.zip";
const stable = "Pharo 13.0 - 64bit (stable)";
const stableUrl = "https://files.pharo.org/image/130/latest-64.zip";

/** A temporary profile, as the server runs in one. */
function inProfile(): {
  profile: PharoLauncherProfileConfig;
  config: PharoLauncherConfig;
  images: string;
} {
  const profile = tempProfile();
  temporaries.push(profile.stateRoot);
  return { profile, config: testConfig({ profile }), images: path.resolve(profile.imagesDir) };
}

/** No profile: the images directory the user's settings name. */
function outsideProfile(): { config: PharoLauncherConfig; images: string; settings: string } {
  const userFilesDir = temporary("pharo-launcher-mcp-user-files-");
  const images = path.join(userFilesDir, "my images");
  const settings = path.join(userFilesDir, "launcherSettings.ston");
  fs.mkdirSync(images);
  fs.writeFileSync(
    settings,
    `PharoLauncherCLIConfiguration {\n\t#imagesDirectory : FILE [ '${images}' ]\n}\n`,
  );
  return { config: testConfig({ userFilesDir }), images, settings };
}

function exited(
  exitCode: number | null,
  stdout = "",
  stderr = "",
  extra: Partial<LauncherCliResult> = {},
): LauncherCliResult {
  return { exitCode, stdout, stderr, durationMs: 1, timedOut: false, ...extra };
}

/** A runner that records each command and answers what `answer` says. */
function recording(answer: (args: readonly string[]) => LauncherCliResult = () => exited(0)): {
  runner: LauncherCliRunner;
  calls: string[][];
} {
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

function processes(lines: readonly string[] = [], extra: CallToolOptions["nativeProcess"] = {}) {
  return { platform: "linux" as const, runCommand: psRunner(lines), ...extra };
}

describe("the server", () => {
  it("announces the version the package was published with", async () => {
    const packaged = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    const client = new Client({ name: "probe", version: "0.0.0" }, {});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverTransport);
    await client.connect(clientTransport);

    // The health tool used to report this. Initialize is where it lives now,
    // and it is still read from package.json rather than kept by hand.
    expect(client.getServerVersion()?.version).toBe(packaged.version);
    await client.close();
  });

  // No task drew them, and a model reads a schema as what matters.
  it("advertises no table option, raw output or noLaunch", async () => {
    const client = new Client({ name: "probe", version: "0.0.0" }, {});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverTransport);
    await client.connect(clientTransport);

    const listed = JSON.stringify((await client.listTools()).tools);
    for (const name of ["includeRaw", "format", "brief", "rowMode", "delimiter", "noLaunch"]) {
      expect(listed).not.toContain(`"${name}"`);
    }
    await client.close();
  });

  // What a model reads before it calls: which images, what it answers, what it
  // refuses.
  it("describes the tools as answering about this Launcher's images", async () => {
    const client = new Client({ name: "probe", version: "0.0.0" }, {});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverTransport);
    await client.connect(clientTransport);

    const descriptions = Object.fromEntries(
      (await client.listTools()).tools.map((tool) => [tool.name, tool.description]),
    );
    expect(descriptions).toMatchObject({
      config:
        "Say which Pharo Launcher this server runs, and where its images are.",
      image_list:
        "List this Launcher's images, each with its Pharo version, architecture, template and whether it runs. nameFilter keeps the images whose name contains it.",
      image_info:
        "Describe an image of this Launcher: its path, Pharo version, architecture, template and whether it runs.",
      image_create:
        "Create an image from a template. It is not started: image_start starts it.",
      image_delete:
        "Delete an image, its directory and the logs of its starts. Nothing asks for a confirmation. A running image is refused: stop it first with process_kill.",
      image_start:
        "Start an image, optionally with a script for it to run. Unless detached, the call waits for the image to quit, and stops it when the call's time is up.",
      process_list:
        "List the Pharo processes running an image of this Launcher, by image and pid.",
      process_kill:
        "Kill a process running an image of this Launcher, by pid or by image. A pid stops that process alone; an image stops every process running it.",
    });
    await client.close();
  });

  // config prints this server's profile only: another's stateRoot has to be
  // recognizable from the description.
  it("says what a profile is: its stateRoot, or its images directory", async () => {
    const client = new Client({ name: "probe", version: "0.0.0" }, {});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverTransport);
    await client.connect(clientTransport);

    const copy = (await client.listTools()).tools.find(
      (tool) => tool.name === "image_copy_between_profiles",
    );
    const profile = copy?.inputSchema.properties?.destinationProfile as {
      description: string;
      properties: Record<string, { description: string }>;
    };

    expect(copy?.description).toBe(
      "Copy an image from one images directory to another, such as from a user's own " +
        "Launcher into a profile. config prints this server's own stateRoot. Every " +
        "directory must exist: the copy creates none.",
    );
    expect(profile.description).toBe(
      "Where a profile keeps its images: its stateRoot, the directory that holds its " +
        "images/ directory, or an images directory itself as imagesDir. One of the two.",
    );
    expect(Object.keys(profile.properties)).toEqual(["stateRoot", "imagesDir"]);
    await client.close();
  });
});

// Every tool, succeeding and failing: text for a model, never the library's
// object. A new tool fails this until it has an answer.
describe("every answer is text", () => {
  function scenario(name: string, ok: boolean) {
    const { profile, config, images } = inProfile();
    writeImage(images, "base", { metaInf: cliMetaInf(nextStable, nextStableUrl), pharoVersion: "140" });
    const other = temporary("pharo-launcher-mcp-other-profile-");
    writeImage(path.join(other, "images"), "base", { metaInf: cliMetaInf(stable, stableUrl) });
    fs.mkdirSync(profile.templateSourcesDir, { recursive: true });
    fs.writeFileSync(path.join(profile.templateSourcesDir, "sources.list"), "sources");
    const { runner } = recording((args) => {
      if (!ok) {
        return exited(1, "", "It went wrong.");
      }
      if (args[1] === "create" || args[1] === "copy") {
        writeImage(images, String(args.at(-1)), { metaInf: cliMetaInf(stable, stableUrl) });
      }
      if (args[1] === "categories") {
        return exited(0, "*1  Official distributions\n");
      }
      if (args[0] === "template" && args[1] === "list") {
        return exited(0, `OrderedCollection[PhLRemoteTemplate{#name:'${nextStable}'}]`);
      }
      if (args[1] === "launch") {
        return exited(0, "", "", {
          launch: {
            by: "vm",
            imagePath: path.join(images, "base", "base.image"),
            displayMode: "headless",
            vmPath: "/vms/140-x64/pharo",
            vmId: "140-x64",
            vmDirectory: "/vms/140-x64",
            vmUpdated: false,
            output: { stdout: "", stderr: "" },
          },
        });
      }
      return exited(0);
    });
    const argumentsByTool: Record<string, unknown> = {
      image_copy: { image: "base", newImage: "copy" },
      image_create: { template: stable, image: "made" },
      image_delete: { image: "base" },
      image_info: { image: ok ? "base" : "none" },
      image_start: { image: "base", script: "x.st" },
      process_kill: { image: "base" },
      image_copy_between_profiles: {
        sourceProfile: { stateRoot: other },
        destinationProfile: { stateRoot: profile.stateRoot },
        image: "base",
        newImage: ok ? "fresh" : "base",
      },
    };
    const base = path.join(images, "base", "base.image");
    return callTool(name, argumentsByTool[name] ?? {}, {
      config,
      runner,
      imageCopyVerificationTimeoutMs: 0,
      sleep: async () => {},
      fetchTemplateSources: async () => "sources",
      nativeProcess: processes(ok ? [`71513 /vms/pharo ${base}`] : [], {
        killProcess: () => {},
        isAlive: () => false,
      }),
    });
  }

  it.each(toolNames.flatMap((name) => [[name, "succeeding"], [name, "failing"]] as const))(
    "%s, %s",
    async (name, outcome) => {
      const answer = text(await scenario(name, outcome === "succeeding"));

      expect(answer).not.toMatch(/^\s*[{[]/);
      for (const field of ['"parser"', '"command"', "durationMs", '"ok"']) {
        expect(answer).not.toContain(field);
      }
      expect(answer).not.toContain("There is no tool");
      expect(answer.length).toBeGreaterThan(0);
    },
  );
});

describe("config", () => {
  function installation(): Pick<
    PharoLauncherConfig,
    "launcherDir" | "launcherVm" | "installationLauncherImage"
  > {
    const launcherDir = temporary("pharo-launcher-mcp-installation-");
    fs.writeFileSync(path.join(launcherDir, "pharo"), "");
    fs.writeFileSync(path.join(launcherDir, "PharoLauncher.image"), "");
    return {
      launcherDir,
      launcherVm: path.join(launcherDir, "pharo"),
      installationLauncherImage: path.join(launcherDir, "PharoLauncher.image"),
    };
  }

  it("names the Launcher, the profile and its images, in profile mode", async () => {
    const { profile, config, images } = inProfile();
    const launcher = installation();

    const result = await callTool(
      "config",
      {},
      { config: { ...config, ...launcher }, runner: unusedRunner },
    );

    expect(result.isError).toBeUndefined();
    expect(text(result)).toBe(
      [
        `Pharo Launcher ${launcher.launcherDir}, profile isolated.`,
        `stateRoot: ${profile.stateRoot}`,
        `images: ${images}`,
      ].join("\n"),
    );
  });

  it("says which settings name the images, outside a profile", async () => {
    const { config, images, settings } = outsideProfile();
    const launcher = installation();
    const options = { config: { ...config, ...launcher }, runner: unusedRunner };
    const defaultImages = path.join(path.dirname(settings), "images");

    expect(text(await callTool("config", {}, options))).toBe(
      [
        `Pharo Launcher ${launcher.launcherDir}, with the settings in ${settings}.`,
        `images: ${images}`,
      ].join("\n"),
    );

    fs.writeFileSync(settings, "PharoLauncherCLIConfiguration { }");
    expect(text(await callTool("config", {}, options))).toBe(
      [
        `Pharo Launcher ${launcher.launcherDir}, with the settings in ${settings}, which name no images directory.`,
        `images: ${defaultImages}`,
      ].join("\n"),
    );

    fs.rmSync(settings);
    expect(text(await callTool("config", {}, options))).toBe(
      [
        `Pharo Launcher ${launcher.launcherDir}, with its default settings: ${settings} does not exist yet.`,
        `images: ${defaultImages}`,
      ].join("\n"),
    );
  });

  it("names where it looked when no Launcher is usable", async () => {
    const { config, images } = outsideProfile();
    const candidate = (
      source: "macos-user-app" | "macos-system-app" | "platform-default",
      launcherDir: string,
    ) => ({
      source,
      launcherDir,
      launcherVm: path.join(launcherDir, "vm"),
      installationLauncherImage: path.join(launcherDir, "image"),
    });
    const candidates = [
      candidate("macos-user-app", "/no/u/PL.app"),
      candidate("macos-system-app", "/no/Applications/PL.app"),
      candidate("platform-default", "/no/opt/pl"),
    ];

    const result = await callTool(
      "config",
      {},
      {
        config: {
          ...config,
          discovery: { source: "macos-user-app", selected: candidates[0]!, candidates },
        },
        runner: unusedRunner,
      },
    );

    expect(result.isError).toBeUndefined();
    expect(text(result).split("\n")).toEqual([
      `No usable Pharo Launcher in ${path.resolve("/no/u/PL.app")}, ${path.resolve("/no/Applications/PL.app")} or ${path.resolve("/no/opt/pl")}. Install it, or set PHARO_LAUNCHER_DIR to where it is.`,
      `images: ${images}`,
    ]);
  });
});

describe("image_list", () => {
  const nextStableImage = { metaInf: cliMetaInf(nextStable, nextStableUrl), pharoVersion: "140" };
  const shared = 'images (each pharo=14.0 architecture=64 template="Pharo 14.0 - 64bit (next stable)"):';
  const alone = 'pharo=14.0 architecture=64 template="Pharo 14.0 - 64bit (next stable)"';

  it("names every image, what they share once, and the pids of those that run", async () => {
    const { config, images } = inProfile();
    const paths: Record<string, string> = {};
    for (const name of ["base", "pricing", "pricing-2025", "server", "stuck", "tmp-import"]) {
      paths[name] = writeImage(images, name, nextStableImage);
    }
    writeImage(images, "pricing-backup", { image: false, changes: false });

    const result = await callTool(
      "image_list",
      {},
      {
        config,
        runner: unusedRunner,
        nativeProcess: processes([
          `71490 /vms/140-x64/pharo ${paths.server}`,
          `71513 /vms/140-x64/pharo --headless ${paths.stuck}`,
        ]),
      },
    );

    expect(result.isError).toBeUndefined();
    expect(text(result)).toBe(
      [
        `6 images in ${images}.`,
        `Warning: pricing-backup is not an image: ${path.join(images, "pricing-backup")} holds neither pricing-backup.image nor pricing-backup.changes.`,
        shared,
        "  base",
        "  pricing",
        "  pricing-2025",
        "  server pids=71490",
        "  stuck pids=71513",
        "  tmp-import",
      ].join("\n"),
    );
  });

  it("refuses an argument it never took, naming the ones it takes", async () => {
    const { config, images } = inProfile();
    writeImage(images, "base", nextStableImage);
    const result = await callTool(
      "image_list",
      { nameFilter: "base", bogus: 1 },
      { config, runner: unusedRunner, nativeProcess: processes() },
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      "Invalid arguments for image_list. bogus is not accepted here. It takes nameFilter.",
    );
  });

  it("refuses an argument of an earlier release, naming those it takes", async () => {
    const { config } = inProfile();
    const options = { config, runner: unusedRunner, nativeProcess: processes() };

    expect(text(await callTool("image_list", { includeRaw: true }, options))).toBe(
      "Invalid arguments for image_list. includeRaw is not accepted here. It takes nameFilter.",
    );
  });

  it.each<[string, string[], string[], Record<string, unknown>, string[]]>([
    ["one running", ["base"], ["base"], {}, ["1 image in <images>.", "images:", `  base ${alone} pids=1`]],
    [
      "filtered",
      ["tmp-a", "tmp-b", "c"],
      [],
      { nameFilter: "tmp-" },
      ["2 of 3 images in <images> match tmp-.", shared, "  tmp-a", "  tmp-b"],
    ],
    [
      "a filter holding a space",
      ["MCP debug", "c"],
      [],
      { nameFilter: "MCP debug" },
      ['1 of 2 images in <images> match "MCP debug".', "images:", `  "MCP debug" ${alone}`],
    ],
    ["none", [], [], {}, ["No images in <images>."]],
  ])("%s", async (_label, names, running, input, expected) => {
    const { config, images } = inProfile();
    const lines = names.map((name, index) => {
      const imagePath = writeImage(images, name, nextStableImage);
      return running.includes(name) ? `${index + 1} /vms/pharo ${imagePath}` : "";
    });

    const result = await callTool("image_list", input, {
      config,
      runner: unusedRunner,
      nativeProcess: processes(lines.filter(Boolean)),
    });

    expect(text(result)).toBe(expected.join("\n").replaceAll("<images>", images));
  });

  it("shows what each image does not share, and quotes a name holding a space", async () => {
    const { config, images } = inProfile();
    writeImage(images, "MCP14 debug", nextStableImage);
    writeImage(images, "old", { pharoVersion: "90", format: 6521 });

    const result = await callTool(
      "image_list",
      {},
      { config, runner: unusedRunner, nativeProcess: processes() },
    );

    expect(text(result).split("\n").slice(1)).toEqual([
      "images:",
      `  "MCP14 debug" ${alone}`,
      "  old pharo=9.0 architecture=32",
    ]);
  });

  it("says when its directory does not exist", async () => {
    const { profile, config, images } = inProfile();
    fs.rmSync(profile.imagesDir, { recursive: true });

    const result = await callTool(
      "image_list",
      {},
      { config, runner: unusedRunner, nativeProcess: processes() },
    );

    expect(text(result)).toBe(`No images in ${images}, which does not exist.`);
  });

  it("says why it cannot tell which images run", async () => {
    const { config, images } = inProfile();
    writeImage(images, "a", { pharoVersion: "140" });
    writeImage(images, "b", { pharoVersion: "140" });

    const result = await callTool(
      "image_list",
      {},
      { config, runner: unusedRunner, nativeProcess: { platform: "freebsd" } },
    );

    expect(text(result).split("\n").slice(0, 2)).toEqual([
      `2 images in ${images}.`,
      "Warning: cannot tell which images run: listing processes is not supported on freebsd.",
    ]);
  });

  it("warns only about directories its filter keeps", async () => {
    const { config, images } = inProfile();
    writeImage(images, "tmp-a", { pharoVersion: "140" });
    writeImage(images, "tmp-half", { changes: false });
    writeImage(images, "other-half", { image: false });

    const result = await callTool(
      "image_list",
      { nameFilter: "tmp-" },
      { config, runner: unusedRunner, nativeProcess: processes() },
    );

    expect(text(result).split("\n")).toEqual([
      `1 of 1 image in ${images} match tmp-.`,
      `Warning: tmp-half is not an image: ${path.join(images, "tmp-half")} holds no tmp-half.changes.`,
      "images:",
      "  tmp-a pharo=14.0 architecture=64",
    ]);
  });
});

describe("image_info", () => {
  it("describes an image and the VMs running it", async () => {
    const { config, images } = inProfile();
    const stuck = writeImage(images, "stuck", {
      metaInf: cliMetaInf(nextStable, nextStableUrl),
      pharoVersion: "140",
    });
    const modified = new Date("2026-11-14T11:08:01.500Z");
    fs.utimesSync(stuck, modified, modified);
    const options = (lines: string[]) => ({
      config,
      runner: unusedRunner,
      nativeProcess: processes(lines),
    });

    const one = await callTool(
      "image_info",
      { image: "stuck" },
      options([`71513 /vms/pharo ${stuck}`]),
    );
    const two = await callTool(
      "image_info",
      { image: "STUCK" },
      options([`71520 /vms/pharo ${stuck}`, `71513 /vms/pharo ${stuck}`]),
    );
    const none = await callTool("image_info", { image: "stuck" }, options([]));

    expect(one.isError).toBeUndefined();
    expect(text(one)).toBe(
      [
        "Image stuck runs as pid 71513.",
        `path: ${path.join(images, "stuck", "stuck.image")}`,
        "pharo: 14.0",
        "architecture: 64",
        `template: ${nextStable}`,
        `templateUrl: ${nextStableUrl}`,
        "modified: 2026-11-14T11:08:01Z",
      ].join("\n"),
    );
    expect(text(two).split("\n")[0]).toBe("Image stuck runs as pids 71513, 71520.");
    expect(text(none).split("\n")[0]).toBe("Image stuck is not running.");
  });

  it("leaves out what the reader has not, and says when it cannot tell whether it runs", async () => {
    const { config, images } = inProfile();
    const bare = writeImage(images, "bare", { format: 1 });
    const modified = new Date("2026-11-14T11:08:01Z");
    fs.utimesSync(bare, modified, modified);

    const result = await callTool(
      "image_info",
      { image: "bare" },
      { config, runner: unusedRunner, nativeProcess: { platform: "freebsd" } },
    );

    expect(text(result)).toBe(
      [
        "Image bare.",
        "Warning: cannot tell whether it runs: listing processes is not supported on freebsd.",
        `path: ${path.join(images, "bare", "bare.image")}`,
        "modified: 2026-11-14T11:08:01Z",
      ].join("\n"),
    );
  });

  it("refuses a name the profile's images directory does not hold, with no Launcher call", async () => {
    const { config, images } = inProfile();
    writeImage(images, "pricing-backup", { image: false, changes: false });
    const options = { config, runner: unusedRunner, nativeProcess: processes() };
    const answer = async (image: string) => callTool("image_info", { image }, options);

    const missing = await answer("releasecheck");

    expect(missing.isError).toBe(true);
    expect(text(missing)).toBe(
      `There is no image releasecheck in ${images}. image_list says which images there are.`,
    );
    expect(text(await answer("pricing-backup"))).toBe(
      `There is no image pricing-backup in ${images}: its directory holds neither pricing-backup.image nor pricing-backup.changes.`,
    );
  });
});

describe("image_create", () => {
  const createArgs = ["image", "create", "--no-launch", "--templateName", stable, "release-check"];

  function created(images: string, extra: Partial<LauncherCliResult> = {}) {
    return recording((args) => {
      if (args[1] === "create") {
        writeImage(images, "release-check", { metaInf: cliMetaInf(stable, stableUrl), pharoVersion: "130" });
        return exited(0, "", "", extra);
      }
      return exited(0);
    });
  }

  it("says what it made", async () => {
    const { config, images } = inProfile();
    const { runner, calls } = created(images);

    const result = await callTool(
      "image_create",
      { template: stable, image: "release-check" },
      { config, runner },
    );

    expect(result.isError).toBeUndefined();
    expect(text(result)).toBe(
      [
        `Created image release-check from template ${stable}.`,
        `path: ${path.join(images, "release-check", "release-check.image")}`,
        "pharo: 13.0",
        "architecture: 64",
      ].join("\n"),
    );
    expect(calls).toEqual([createArgs, ["image", "info", "release-check"]]);
  });

  it("warns that it outlived the call, when the image is there", async () => {
    const { config, images } = inProfile();
    const { runner } = created(images, { exitCode: null, timedOut: true });

    const result = await callTool(
      "image_create",
      { template: stable, image: "release-check" },
      { config, runner },
    );

    expect(result.isError).toBeUndefined();
    expect(text(result).split("\n").slice(0, 2)).toEqual([
      `Created image release-check from template ${stable}.`,
      "Warning: Pharo Launcher needed more than the call's 30 s, but finished.",
    ]);
  });

  it("says it did not finish, when it outlived the call and the image is not there", async () => {
    const { config } = inProfile();
    const { runner } = recording(() => exited(null, "", "", { timedOut: true }));

    const result = await callTool(
      "image_create",
      { template: stable, image: "release-check" },
      { config, runner, imageCopyVerificationTimeoutMs: 0, sleep: async () => {} },
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      "Pharo Launcher did not finish create image release-check within 30 s.",
    );
  });

  it("refuses a name taken in any case, with no Launcher call, in profile mode", async () => {
    const { config, images } = inProfile();
    writeImage(images, "Pricing-Backup");

    const result = await callTool(
      "image_create",
      { template: stable, image: "pricing-backup" },
      { config, runner: unusedRunner },
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      `There is already an image Pricing-Backup in ${images}. Pick another name, or delete it first with image_delete.`,
    );
  });

  it("lets the Launcher refuse a taken name outside a profile", async () => {
    const { config, images } = outsideProfile();
    writeImage(images, "pricing-backup");
    const { runner, calls } = recording(() =>
      exited(1, "", "An image with the same name already exists."),
    );

    const result = await callTool(
      "image_create",
      { template: stable, image: "pricing-backup" },
      { config, runner },
    );

    expect(calls).toHaveLength(1);
    expect(text(result)).toBe(
      "Pharo Launcher could not create image pricing-backup: An image with the same name already exists.",
    );
  });

  it("says what the directory lacks when the image never appears, and when the Launcher cannot open it", async () => {
    const { config, images } = inProfile();
    const never = recording(() => exited(0));
    const unopened = recording((args) => {
      if (args[1] === "create") {
        writeImage(images, "release-check");
        return exited(0);
      }
      return exited(1, "", "STONReaderError: unexpected token");
    });
    const options = { config, imageCopyVerificationTimeoutMs: 0, sleep: async () => {} };
    const input = { template: stable, image: "release-check" };

    const neverListed = await callTool("image_create", input, { ...options, runner: never.runner });
    const neverOpened = await callTool("image_create", input, { ...options, runner: unopened.runner });

    expect(neverListed.isError).toBe(true);
    expect(text(neverListed)).toBe(
      `Pharo Launcher said it created release-check, but ${path.join(images, "release-check")} does not exist after 0 s.`,
    );
    expect(neverOpened.isError).toBe(true);
    expect(text(neverOpened)).toBe(
      "Pharo Launcher made release-check but cannot open it: STONReaderError: unexpected token.",
    );
  });

  it("quotes a name holding a space when the image never appears or cannot be opened", async () => {
    const { config, images } = inProfile();
    const never = recording(() => exited(0));
    const unopened = recording((args) => {
      if (args[1] === "create") {
        writeImage(images, "MCP debug");
        return exited(0);
      }
      return exited(1, "", "STONReaderError: unexpected token");
    });
    const options = { config, imageCopyVerificationTimeoutMs: 0, sleep: async () => {} };
    const input = { template: stable, image: "MCP debug" };

    const neverListed = await callTool("image_create", input, { ...options, runner: never.runner });
    const neverOpened = await callTool("image_create", input, { ...options, runner: unopened.runner });

    expect(text(neverListed)).toBe(
      `Pharo Launcher said it created "MCP debug", but ${path.join(images, "MCP debug")} does not exist after 0 s.`,
    );
    expect(text(neverOpened)).toBe(
      'Pharo Launcher made "MCP debug" but cannot open it: STONReaderError: unexpected token.',
    );
  });

  it("points at the template list or the categories when the Launcher finds neither", async () => {
    const { profile, config } = inProfile();
    const noTemplate = recording(() =>
      exited(1, "Pharo 99 not found, please enter a correct template name"),
    );
    const noCategory = recording(() =>
      exited(1, "Nightly not found, please enter a correct category name"),
    );
    const inNightly = { template: stable, category: "Nightly", image: "x" };

    const template = await callTool(
      "image_create",
      { template: "Pharo 99", image: "x" },
      { config, runner: noTemplate.runner },
    );
    const noSources = await callTool("image_create", inNightly, { config, runner: noCategory.runner });
    fs.mkdirSync(profile.templateSourcesDir, { recursive: true });
    fs.writeFileSync(path.join(profile.templateSourcesDir, "sources.list"), "a source");
    const category = await callTool("image_create", inNightly, { config, runner: noCategory.runner });

    expect(text(template)).toBe(
      "Pharo Launcher could not create image x: Pharo 99 not found, please enter a correct template name. template_list says which templates there are.",
    );
    expect(text(noSources)).toBe(
      "There are no templates yet: call template_update first.",
    );
    expect(text(category)).toBe(
      "Pharo Launcher could not create image x: Nightly not found, please enter a correct category name. template_category_list says which categories there are.",
    );
  });

  it("says a signal ended a Launcher that wrote nothing", async () => {
    const { config } = inProfile();
    const { runner } = recording(() => exited(null, "", "", { signal: "SIGKILL" }));

    const result = await callTool(
      "image_create",
      { template: stable, image: "release-check" },
      { config, runner },
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      "Pharo Launcher could not create image release-check: it was killed by signal SIGKILL.",
    );
  });

  it("gives a Launcher that could not start as its diagnostic lines", async () => {
    const { profile, config } = inProfile();
    const runner: LauncherCliRunner = async () => {
      throw new Error("spawn bash ENOENT");
    };

    const result = await callTool(
      "image_create",
      { template: stable, image: "Task" },
      { config, runner },
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^Failed to start PharoLauncher CLI command: spawn bash ENOENT\n/);
    expect(text(result)).toContain(`PHARO_LAUNCHER_MCP_STATE_ROOT: ${profile.stateRoot}`);
  });
});

describe("image_copy", () => {
  it("says what it copied", async () => {
    const { config, images } = inProfile();
    writeImage(images, "pricing");
    const { runner, calls } = recording((args) => {
      if (args[1] === "copy") {
        writeImage(images, "pricing-backup");
      }
      return exited(0);
    });

    const result = await callTool(
      "image_copy",
      { image: "pricing", newImage: "pricing-backup" },
      { config, runner },
    );

    expect(text(result)).toBe(
      [
        "Copied image pricing to pricing-backup.",
        `path: ${path.join(images, "pricing-backup", "pricing-backup.image")}`,
      ].join("\n"),
    );
    expect(calls).toEqual([
      ["image", "copy", "pricing", "pricing-backup"],
      ["image", "info", "pricing-backup"],
    ]);
  });

  it("refuses a source it does not find and a taken target, in profile mode", async () => {
    const { config, images } = inProfile();
    writeImage(images, "pricing");
    writeImage(images, "pricing-backup");
    const options = { config, runner: unusedRunner };

    const source = await callTool("image_copy", { image: "pricng", newImage: "x" }, options);
    const target = await callTool(
      "image_copy",
      { image: "pricing", newImage: "PRICING-BACKUP" },
      options,
    );

    expect(text(source)).toBe(
      `There is no image pricng in ${images}. image_list says which images there are.`,
    );
    expect(text(target)).toBe(
      `There is already an image pricing-backup in ${images}. Pick another name, or delete it first with image_delete.`,
    );
  });

  it("gives the Launcher's own refusal outside a profile", async () => {
    const { config } = outsideProfile();
    const { runner } = recording(() => exited(1, "Target image name 'pricing-backup' already used."));

    const result = await callTool(
      "image_copy",
      { image: "pricing", newImage: "pricing-backup" },
      { config, runner },
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      "Pharo Launcher could not copy image pricing to pricing-backup: Target image name 'pricing-backup' already used.",
    );
  });

  it("says what the directory lacks when the copy never appears", async () => {
    const { config, images } = inProfile();
    writeImage(images, "pricing");
    const { runner } = recording(() => exited(0));

    const result = await callTool(
      "image_copy",
      { image: "pricing", newImage: "pricing-backup" },
      { config, runner, imageCopyVerificationTimeoutMs: 0, sleep: async () => {} },
    );

    expect(text(result)).toBe(
      `Pharo Launcher said it copied pricing to pricing-backup, but ${path.join(images, "pricing-backup")} does not exist after 0 s.`,
    );
  });

  it("quotes names holding a space when the copy never appears", async () => {
    const { config, images } = inProfile();
    writeImage(images, "MCP debug");
    const { runner } = recording(() => exited(0));

    const result = await callTool(
      "image_copy",
      { image: "MCP debug", newImage: "MCP debug 2" },
      { config, runner, imageCopyVerificationTimeoutMs: 0, sleep: async () => {} },
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      `Pharo Launcher said it copied "MCP debug" to "MCP debug 2", but ${path.join(images, "MCP debug 2")} does not exist after 0 s.`,
    );
  });
});

describe("image_delete", () => {
  it("deletes a stopped image", async () => {
    const { config, images } = inProfile();
    writeImage(images, "tmp-scratch");
    const { runner, calls } = recording();

    const result = await callTool(
      "image_delete",
      { image: "tmp-scratch" },
      { config, runner, nativeProcess: processes() },
    );

    expect(result.isError).toBeUndefined();
    expect(text(result)).toBe("Deleted image tmp-scratch.");
    expect(calls).toEqual([["image", "delete", "--force", "tmp-scratch"]]);
  });

  it("refuses a running image, in every mode, with no Launcher call, and deletes it once its VM is gone", async () => {
    for (const { config, images } of [inProfile(), outsideProfile()]) {
      const scratch = writeImage(images, "tmp-scratch");
      const { runner, calls } = recording();
      const answer = async (lines: string[]) =>
        callTool(
          "image_delete",
          { image: "tmp-scratch" },
          { config, runner, nativeProcess: processes(lines) },
        );

      const one = await answer([`71513 /vms/pharo ${scratch}`]);
      const two = await answer([`71513 /vms/pharo ${scratch}`, `71520 /vms/pharo ${scratch}`]);
      const refusedCalls = calls.length;
      const gone = await answer([]);

      expect(one.isError).toBe(true);
      expect(text(one)).toBe(
        "Image tmp-scratch runs as pid 71513: stop it with process_kill, then delete it.",
      );
      expect(text(two)).toBe(
        "Image tmp-scratch runs as pids 71513, 71520: stop it with process_kill, then delete it.",
      );
      expect(refusedCalls).toBe(0);
      expect(gone.isError).toBeUndefined();
      expect(text(gone)).toBe("Deleted image tmp-scratch.");
      expect(calls).toEqual([["image", "delete", "--force", "tmp-scratch"]]);
    }
  });

  it("refuses when it cannot tell whether the image runs", async () => {
    const { config, images } = inProfile();
    writeImage(images, "tmp-scratch");

    const result = await callTool(
      "image_delete",
      { image: "tmp-scratch" },
      {
        config,
        runner: unusedRunner,
        nativeProcess: {
          platform: "linux",
          runCommand: async () => {
            throw new Error("ps exited with 1");
          },
        },
      },
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      "Cannot tell whether tmp-scratch runs (ps exited with 1), so it was not deleted.",
    );
  });

  it("refuses a name it does not find in profile mode, and asks the Launcher outside one", async () => {
    const profile = inProfile();
    const outside = outsideProfile();
    const { runner, calls } = recording(() =>
      exited(1, "Local image 'tmp-scratch' not found. Please enter a correct local image."),
    );

    const refused = await callTool(
      "image_delete",
      { image: "tmp-scratch" },
      { config: profile.config, runner: unusedRunner, nativeProcess: processes() },
    );
    const asked = await callTool(
      "image_delete",
      { image: "tmp-scratch" },
      { config: outside.config, runner, nativeProcess: processes() },
    );

    expect(text(refused)).toBe(
      `There is no image tmp-scratch in ${profile.images}. image_list says which images there are.`,
    );
    expect(calls).toEqual([["image", "delete", "--force", "tmp-scratch"]]);
    expect(text(asked)).toBe(
      "Pharo Launcher could not delete image tmp-scratch: Local image 'tmp-scratch' not found. Please enter a correct local image.",
    );
  });
});

describe("image_start", () => {
  function vmLaunch(
    images: string,
    extra: Partial<Extract<LauncherLaunchReport, { by: "vm" }>> = {},
  ): LauncherLaunchReport {
    return {
      by: "vm",
      imagePath: path.join(images, "release-check", "release-check.image"),
      displayMode: "headless",
      vmPath: "/vms/130-x64/pharo",
      vmId: "130-x64",
      vmDirectory: "/vms/130-x64",
      vmUpdated: false,
      ...extra,
    };
  }

  function started(result: Partial<LauncherCliResult>) {
    return recording(() => ({ ...exited(0), ...result }));
  }

  function start(config: PharoLauncherConfig, input: Record<string, unknown>, runner: LauncherCliRunner) {
    return callTool("image_start", { image: "release-check", ...input }, { config, runner });
  }

  const tail = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
  const endings: Array<[string, Partial<LauncherCliResult>, { stdout: string; stderr: string }, boolean, string[]]> = [
    ["quit", {}, { stdout: "Loaded.\nSaved.\n", stderr: "" }, false, [
      "release-check quit with exit code 0.",
      "Its output ends with:",
      "  Loaded.",
      "  Saved.",
    ]],
    ["failed, keeping the last 20 lines", { exitCode: 1 }, { stdout: "", stderr: tail.join("\n") }, true, [
      "release-check quit with exit code 1.",
      "Its error output ends with:",
      ...tail.slice(10).map((line) => `  ${line}`),
    ]],
    ["outlived the call", { exitCode: null, timedOut: true }, { stdout: "", stderr: "" }, true, [
      "release-check did not quit within 30 s and was stopped: a start that is not detached lasts as long as the call. Pass detached: true to leave it running.",
    ]],
    ["was killed", { exitCode: null, signal: "SIGSEGV" }, { stdout: "", stderr: "Segmentation fault\n" }, true, [
      "release-check was killed by signal SIGSEGV.",
      "Its error output ends with:",
      "  Segmentation fault",
    ]],
  ];

  it.each(endings)("says a waited start %s", async (_label, command, output, isError, expected) => {
    const { config, images } = inProfile();
    writeImage(images, "release-check");
    const { runner } = started({ ...command, launch: vmLaunch(images, { output }) });

    const result = await start(config, { script: "check.st" }, runner);

    expect(result.isError ?? false).toBe(isError);
    expect(text(result).split("\n")).toEqual(expected);
  });

  // Measured on the real VMs: a Pharo 14 image given no script prints its
  // usage and exits 1, a Pharo 13 one exits 0.
  it("names a downloaded VM, a window, and a headless image with nothing to run", async () => {
    const { config, images } = inProfile();
    writeImage(images, "release-check");
    const interactive = started({
      launch: vmLaunch(images, { displayMode: "interactive", vmUpdated: true, output: { stdout: "", stderr: "" } }),
    });
    const headless = started({ exitCode: 1, launch: vmLaunch(images, { output: { stdout: "", stderr: "" } }) });

    expect(text(await start(config, { displayMode: "interactive" }, interactive.runner))).toBe(
      ["release-check quit with exit code 0.", "Downloaded VM 130-x64 for it first."].join("\n"),
    );
    expect(text(await start(config, {}, headless.runner))).toBe(
      [
        "release-check quit with exit code 1.",
        "A headless image with no script has nothing to run and quits: pass a script, or displayMode: interactive.",
      ].join("\n"),
    );
  });

  it("names the pid and the logs of a detached start", async () => {
    const { config, images } = inProfile();
    writeImage(images, "release-check");
    const logs = { stdout: "/logs/out.log", stderr: "/logs/err.log" };
    const plain = started({ launch: vmLaunch(images, { pid: 73028, logs }) });
    const window = started({ launch: vmLaunch(images, { pid: 73028, logs, displayMode: "interactive" }) });
    const logsLine = `logs: ${logs.stdout} and ${logs.stderr}`;

    expect(text(await start(config, { detached: true, script: "x.st" }, plain.runner))).toBe(
      ["Started release-check headless, detached, as pid 73028.", logsLine].join("\n"),
    );
    expect(text(await start(config, { detached: true, displayMode: "interactive" }, window.runner))).toBe(
      ["Started release-check with its window, detached, as pid 73028.", logsLine].join("\n"),
    );
  });

  it("says what the Launcher did, outside a profile", async () => {
    const { config, images } = outsideProfile();
    writeImage(images, "release-check");
    const logs = { stdout: "/logs/a.out.log", stderr: "/logs/a.err.log" };
    const detached = started({ launch: { by: "launcher", pid: 73100, logs } });
    const quit = started({ exitCode: 1, stderr: "Error", launch: { by: "launcher" } });
    const killed = started({ exitCode: null, signal: "SIGKILL", launch: { by: "launcher" } });

    expect(text(await start(config, { detached: true }, detached.runner))).toBe(
      [
        "Pharo Launcher is starting release-check (its own pid 73100); process_list shows the image's VM once it runs.",
        `logs: ${logs.stdout} and ${logs.stderr}`,
      ].join("\n"),
    );
    expect(text(await start(config, {}, quit.runner))).toBe(
      ["release-check quit with exit code 1.", "Its error output ends with:", "  Error"].join("\n"),
    );
    expect(text(await start(config, {}, killed.runner))).toBe(
      "Pharo Launcher could not start image release-check: it was killed by signal SIGKILL.",
    );
  });

  it("gives the Launcher's refusal of an image it does not find, outside a profile", async () => {
    const { config } = outsideProfile();
    const { runner } = started({
      exitCode: 1,
      stdout: "Local image 'nope' not found. Please enter a correct local image.",
      launch: { by: "launcher" },
    });

    const result = await callTool("image_start", { image: "nope" }, { config, runner });

    expect(text(result)).toBe(
      "Pharo Launcher could not start image nope: Local image 'nope' not found. Please enter a correct local image.",
    );
  });

  it("refuses an image it does not find in profile mode, and gives the library's own failures", async () => {
    const { config, images } = inProfile();
    writeImage(images, "release-check");
    const noVersion =
      "Cannot tell which VM release-check needs: neither its meta-inf.ston, its pharo.version nor its template gives a Pharo version.";
    const { runner } = recording(() => exited(1, "", noVersion));

    const missing = await callTool(
      "image_start",
      { image: "releasecheck" },
      { config, runner: unusedRunner },
    );
    const noVm = await start(config, {}, runner);

    expect(text(missing)).toBe(
      `There is no image releasecheck in ${images}. image_list says which images there are.`,
    );
    expect(noVm.isError).toBe(true);
    expect(text(noVm)).toBe(noVersion);
  });

  it("answers a profile too deep for its VM with what to do", async () => {
    const profile = tempProfile();
    temporaries.push(profile.stateRoot);
    const deep = { ...profile, vmsDir: path.join(profile.stateRoot, "v".repeat(300)) };
    writeImage(profile.imagesDir, "release-check");

    const result = await start(testConfig({ profile: deep }), {}, unusedRunner);

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^The VM directory is too deep for Pharo to load its modules: /);
  });

  it("gives the display mode refusal outside a profile as it is", async () => {
    const { config, images } = outsideProfile();
    writeImage(images, "release-check");

    const result = await callTool(
      "image_start",
      { image: "release-check", displayMode: "interactive" },
      { config },
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^displayMode needs a scoped launcher profile\. /);
  });
});

describe("image_copy_between_profiles", () => {
  function profiles() {
    const source = temporary("pharo-launcher-mcp-source-profile-");
    const destination = temporary("pharo-launcher-mcp-destination-profile-");
    writeImage(path.join(source, "images"), "pricing", { metaInf: cliMetaInf(stable, stableUrl) });
    fs.mkdirSync(path.join(destination, "images"));
    return { source, destination };
  }

  function copy(source: string, destination: string, image = "pricing", newImage = image) {
    return callTool(
      "image_copy_between_profiles",
      {
        sourceProfile: { stateRoot: source },
        destinationProfile: { stateRoot: destination },
        image,
        newImage,
      },
      { runner: unusedRunner },
    );
  }

  it("names both profiles by their state root", async () => {
    const { source, destination } = profiles();

    const same = await copy(source, destination);
    const renamed = await copy(source, destination, "pricing", "pricing-2");

    expect(same.isError).toBeUndefined();
    expect(text(same)).toBe(
      [
        `Copied image pricing from ${source} to ${destination}.`,
        `path: ${path.join(destination, "images", "pricing", "pricing.image")}`,
      ].join("\n"),
    );
    expect(text(renamed).split("\n")[0]).toBe(
      `Copied image pricing from ${source} to ${destination} as pricing-2.`,
    );
  });

  it("says why it could not copy", async () => {
    const { source, destination } = profiles();
    fs.rmSync(path.join(writeImage(path.join(source, "images"), "no-image")));
    await copy(source, destination);

    expect(text(await copy(source, destination, "no-image"))).toBe(
      `Cannot copy image no-image: ${path.join(source, "images", "no-image")} holds no no-image.image.`,
    );
    expect(text(await copy(source, destination))).toBe(
      `Cannot copy image pricing to ${path.join(destination, "images", "pricing")}: that path already exists, and a copy never replaces it. Pick another newImage, or remove it first.`,
    );
  });

  it("says a stateRoot is the directory that holds images/, and creates none", async () => {
    const { source, destination } = profiles();
    const missing = path.join(destination, "team");
    const empty = temporary("pharo-launcher-mcp-not-a-profile-");
    const advice =
      "Give as stateRoot the directory that holds the profile's images/ directory, " +
      "or the images directory itself as imagesDir; config prints this server's own stateRoot.";

    const notThere = await copy(source, missing);
    const noImages = await copy(source, empty);

    expect(notThere.isError).toBe(true);
    expect(text(notThere)).toBe(
      `Cannot copy image pricing: destinationProfile.stateRoot ${missing} does not exist. ${advice}`,
    );
    expect(text(noImages)).toBe(
      `Cannot copy image pricing: destinationProfile.stateRoot ${empty} holds no images/ directory. ${advice}`,
    );
    expect(fs.existsSync(missing)).toBe(false);
    expect(fs.existsSync(path.join(empty, "images"))).toBe(false);
  });

  it("copies from an images directory given as it is", async () => {
    const { source, destination } = profiles();

    const result = await callTool(
      "image_copy_between_profiles",
      {
        sourceProfile: { imagesDir: path.join(source, "images") },
        destinationProfile: { stateRoot: destination },
        image: "pricing",
        newImage: "pricing",
      },
      { runner: unusedRunner },
    );

    expect(text(result).split("\n")[0]).toBe(
      `Copied image pricing from ${path.join(source, "images")} to ${destination}.`,
    );
  });

  it("says a copy that did not check out was removed", async () => {
    const { source, destination } = profiles();
    fs.writeFileSync(path.join(source, "images", "pricing", "meta-inf.ston"), "PhLImage {}");

    const result = await copy(source, destination, "pricing", "task");

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      "Cannot copy image pricing: the copy did not check out (its meta-inf.ston does not name task.image), so it was removed.",
    );
  });

  it("says what it takes when its arguments are wrong", async () => {
    const result = await callTool(
      "image_copy_between_profiles",
      {
        sourceProfile: {},
        destinationProfile: { stateRoot: "/tmp/x" },
        image: "a",
        newImage: "b",
      },
      { runner: unusedRunner },
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      "Invalid arguments for image_copy_between_profiles. sourceProfile takes stateRoot or imagesDir, one of the two. It takes sourceProfile, destinationProfile, image, newImage.",
    );
  });
});

describe("the process tools", () => {
  const home = path.join(os.tmpdir(), "no-such-home");
  const latestMcp = path.join(home, "Documents", "Pharo", "images", "LatestMCP", "LatestMCP.image");
  const profiled = path.join(home, ".tool", "profiles", "images", "x", "x.image");

  function machine(...images: string[]): string[] {
    return [
      `17880 /Applications/PharoLauncher.app/Contents/MacOS/Pharo ${latestMcp}`,
      ...images.map((image, index) => `${71513 + index * 7} /vms/140-x64/Pharo --headless ${image}`),
      `71600 /tool/vms/140-x64/Pharo ${profiled}`,
    ];
  }

  it("list the processes of this Launcher's images alone, in every mode", async () => {
    for (const { config, images } of [inProfile(), outsideProfile()]) {
      const stuck = writeImage(images, "stuck");
      const server = writeImage(images, "server");

      const result = await callTool(
        "process_list",
        {},
        {
          config,
          runner: unusedRunner,
          nativeProcess: processes([...machine(stuck), `71490 /vms/pharo ${server}`]),
        },
      );

      expect(result.isError).toBeUndefined();
      expect(text(result)).toBe(
        [
          `2 processes run images in ${images}.`,
          "processes:",
          "  server pid=71490",
          "  stuck pid=71513",
        ].join("\n"),
      );
    }
  });

  it.each([
    [[] as string[], "No process runs an image in <images>."],
    [["MCP debug"], '1 process runs an image in <images>.\nprocesses:\n  "MCP debug" pid=71513'],
  ])("list %o", async (names, expected) => {
    const { config, images } = inProfile();
    const paths = names.map((name) => writeImage(images, name));

    const result = await callTool(
      "process_list",
      {},
      { config, runner: unusedRunner, nativeProcess: processes(machine(...paths)) },
    );

    expect(text(result)).toBe(expected.replaceAll("<images>", images));
  });

  it("say why they could not list", async () => {
    const { config } = inProfile();
    const options = { config, runner: unusedRunner, nativeProcess: { platform: "freebsd" as const } };

    const listed = await callTool("process_list", {}, options);
    const killed = await callTool("process_kill", { pid: 1 }, options);

    expect(listed.isError).toBe(true);
    expect(text(listed)).toBe(
      "Could not list processes: listing processes is not supported on freebsd.",
    );
    expect(text(killed)).toBe(text(listed));
  });

  /** A process table, a kill that records, and pids that exit when `alive` says. */
  function killing(
    lines: string[],
    alive: (pid: number, polls: number) => boolean = () => false,
    refused: Record<number, string> = {},
  ) {
    const killed: number[] = [];
    const polls = new Map<number, number>();
    const sleeps: number[] = [];
    return {
      killed,
      sleeps,
      options: {
        runner: unusedRunner,
        sleep: async (milliseconds: number) => {
          sleeps.push(milliseconds);
        },
        nativeProcess: processes(lines, {
          killProcess: (pid: number) => {
            if (refused[pid]) {
              throw Object.assign(new Error(refused[pid]), { code: "EPERM" });
            }
            killed.push(pid);
          },
          isAlive: (pid: number) => {
            const count = (polls.get(pid) ?? 0) + 1;
            polls.set(pid, count);
            return refused[pid] !== undefined || alive(pid, count);
          },
        }),
      },
    };
  }

  it("kill by name and by pid, and say what they killed", async () => {
    const { config, images } = inProfile();
    const stuck = writeImage(images, "stuck");
    const lines = [`71513 /vms/pharo ${stuck}`, `71520 /vms/pharo ${stuck}`];

    const one = killing([lines[0]!]);
    const byName = await callTool("process_kill", { image: "STUCK" }, { config, ...one.options });
    const two = killing(lines);
    const both = await callTool("process_kill", { image: "stuck" }, { config, ...two.options });
    const pid = killing(lines);
    const byPid = await callTool("process_kill", { pid: "71520" }, { config, ...pid.options });

    expect(text(byName)).toBe("Killed stuck (pid 71513).");
    expect(one.killed).toEqual([71513]);
    expect(text(both)).toBe("Killed stuck (pids 71513, 71520).");
    expect(two.killed).toEqual([71513, 71520]);
    expect(text(byPid)).toBe("Killed stuck (pid 71520).");
    expect(pid.killed).toEqual([71520]);
  });

  it("kill nothing outside this Launcher's images, in every mode", async () => {
    for (const { config, images } of [inProfile(), outsideProfile()]) {
      const stuck = writeImage(images, "stuck");
      const { killed, options } = killing(machine(stuck));

      const byName = await callTool("process_kill", { image: "LatestMCP" }, { config, ...options });
      const byPid = await callTool("process_kill", { pid: 17880 }, { config, ...options });

      expect(byName.isError).toBe(true);
      expect(text(byName)).toBe(
        "No process runs image LatestMCP. process_list says which run.",
      );
      expect(text(byPid)).toBe(
        `No process of an image in ${images} has pid 17880. process_list says which run.`,
      );
      expect(killed).toEqual([]);
    }
  });

  it("answer once every killed pid is gone, and say which is still there after 10 s", async () => {
    const { config, images } = inProfile();
    const stuck = writeImage(images, "stuck");
    const lines = [`71513 /vms/pharo ${stuck}`, `71520 /vms/pharo ${stuck}`];
    // 71513 exits after a few polls; 71520 never does.
    const slow = killing(lines, (pid, polls) => pid === 71520 || polls < 4);

    const result = await callTool("process_kill", { image: "stuck" }, { config, ...slow.options });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      "Killed stuck (pid 71513); pid 71520 still runs 10 s after being killed.",
    );
    expect(slow.sleeps).toEqual(Array.from({ length: 50 }, () => 200));
  });

  it("go on past a kill that fails, and say which failed", async () => {
    const { config, images } = inProfile();
    const stuck = writeImage(images, "stuck");
    const lines = [`71513 /vms/pharo ${stuck}`, `71520 /vms/pharo ${stuck}`];
    const partly = killing(lines, () => false, { 71513: "kill EPERM" });
    const none = killing([lines[0]!], () => false, { 71513: "kill EPERM" });

    const result = await callTool("process_kill", { image: "stuck" }, { config, ...partly.options });
    const nothing = await callTool("process_kill", { pid: 71513 }, { config, ...none.options });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Killed stuck (pid 71520); could not kill pid 71513: kill EPERM.");
    expect(partly.killed).toEqual([71520]);
    expect(text(nothing)).toBe("Could not kill pid 71513: kill EPERM.");
  });

  it("take one target, and a pid only as a number", async () => {
    const { config } = inProfile();
    const answer = async (input: Record<string, unknown>) =>
      text(await callTool("process_kill", input, { config, runner: unusedRunner }));

    expect(await answer({ pid: 1, image: "x" })).toBe(
      "Invalid arguments for process_kill. Give pid or image, not both. It takes image, pid.",
    );
    expect(await answer({})).toBe(
      "Invalid arguments for process_kill. Give the pid or the image of the process to kill. It takes image, pid.",
    );
    expect(await answer({ pid: "stuck" })).toBe(
      "Invalid arguments for process_kill. pid must be a process id, a whole number. It takes image, pid.",
    );
  });
});

describe("the templates", () => {
  it("list the categories in the Launcher's order, and its default", async () => {
    const { config } = inProfile();
    const answer = async (stdout: string) =>
      text(
        await callTool(
          "template_category_list",
          {},
          { config, runner: recording(() => exited(0, stdout)).runner },
        ),
      );

    expect(
      await answer(
        "*1  Official distributions\n 2  Pharo Mooc\n 3  Moose\n 4  Deprecated distributions\n 5  Nightly builds\n",
      ),
    ).toBe(
      [
        "5 template categories; Official distributions is the default.",
        "categories:",
        "  Official distributions",
        "  Pharo Mooc",
        "  Moose",
        "  Deprecated distributions",
        "  Nightly builds",
      ].join("\n"),
    );
    expect(await answer("1  Official distributions\n2  Pharo Mooc\n")).toBe(
      ["2 template categories.", "categories:", "  Official distributions", "  Pharo Mooc"].join("\n"),
    );
    expect(await answer("1  Official distributions\n")).toBe(
      ["1 template category.", "categories:", "  Official distributions"].join("\n"),
    );
    expect(await answer("")).toBe("No template categories.");
  });

  it("run the brief category listing", async () => {
    const { config } = inProfile();
    const { runner, calls } = recording(() => exited(1, "", "boom"));

    const result = await callTool("template_category_list", {}, { config, runner });

    expect(calls).toEqual([["template", "categories", "--brief"]]);
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Pharo Launcher could not list template categories: boom.");
  });

  it("list template names, without their URLs", async () => {
    const { config } = inProfile();
    const ston =
      "OrderedCollection[" +
      "PhLRemoteTemplate{#name:'Pharo 15.0 - 64bit (development version, latest)',#url:URL['https://x/150.zip']}," +
      `PhLRemoteTemplate{#name:'${nextStable}',#url:URL['${nextStableUrl}']},` +
      "PhLLocalTemplate{#name:'mine'}]";
    const { runner, calls } = recording(() => exited(0, ston));
    const listing = async (input: Record<string, unknown>, stdout: string) =>
      text(
        await callTool("template_list", input, {
          config,
          runner: recording(() => exited(0, stdout)).runner,
        }),
      );

    const inCategory = await callTool(
      "template_list",
      { category: "Official distributions" },
      { config, runner },
    );
    const inDefault = await callTool("template_list", {}, { config, runner });

    expect(calls).toEqual([
      ["template", "list", "--templateCategory", "Official distributions", "--ston"],
      ["template", "list", "--ston"],
    ]);
    expect(text(inCategory)).toBe(
      [
        "3 templates in Official distributions.",
        "templates:",
        "  Pharo 15.0 - 64bit (development version, latest)",
        `  ${nextStable}`,
        "  mine",
      ].join("\n"),
    );
    expect(text(inDefault).split("\n")[0]).toBe("3 templates in the default category.");
    expect(await listing({ category: "Moose" }, "OrderedCollection[PhLLocalTemplate{#name:'m'}]")).toBe(
      ["1 template in Moose.", "templates:", "  m"].join("\n"),
    );
    expect(await listing({ category: "Moose" }, "OrderedCollection[]")).toBe(
      "No templates in Moose.",
    );
  });

  it("say there are no templates yet, or no such category", async () => {
    const { profile, config } = inProfile();
    const notFound = recording(() =>
      exited(1, "Image template category 'Nightly' not found. Please enter a correct image tamplate category name."),
    );

    const noSources = await callTool("template_list", { category: "Nightly" }, { config, runner: notFound.runner });
    const defaultNoSources = await callTool("template_list", {}, { config, runner: notFound.runner });
    fs.mkdirSync(profile.templateSourcesDir, { recursive: true });
    fs.writeFileSync(path.join(profile.templateSourcesDir, "sources.list"), "a source");
    const noCategory = await callTool("template_list", { category: "Nightly" }, { config, runner: notFound.runner });
    const timedOut = await callTool(
      "template_list",
      {},
      { config, runner: recording(() => exited(null, "", "", { timedOut: true })).runner },
    );

    expect(noSources.isError).toBe(true);
    expect(text(noSources)).toBe("There are no templates yet: call template_update first.");
    expect(text(defaultNoSources)).toBe(text(noSources));
    expect(text(noCategory)).toBe(
      "There is no template category Nightly. template_category_list lists them.",
    );
    expect(text(timedOut)).toBe("Pharo Launcher did not finish list templates within 30 s.");
  });

  it("refresh the list, and download the profile's sources each time", async () => {
    const { profile, config } = inProfile();
    const { runner, calls } = recording((args) =>
      args[1] === "update" ? exited(0) : exited(0, "OrderedCollection[PhLRemoteTemplate{#name:'Pharo 13'}]"),
    );
    const sources = path.join(profile.templateSourcesDir, "sources.list");
    const update = (fetched: () => Promise<string>) =>
      callTool("template_update", {}, { config, runner, fetchTemplateSources: fetched });

    const downloaded = await update(async () => "Pharo 14.0 - 64bit (next stable)");
    const refreshed = await update(async () => "Pharo 14.0 - 64bit (next stable)");
    const updated = await update(async () => "Pharo 14.0 - 64bit (stable)");
    const kept = await update(async () => {
      throw new Error("getaddrinfo ENOTFOUND files.pharo.org");
    });

    expect(text(downloaded)).toBe(
      "Refreshed the template list, and downloaded this profile's sources.list from https://files.pharo.org/pharo-launcher/sources.list.",
    );
    expect(text(refreshed)).toBe("Refreshed the template list.");
    expect(text(updated)).toBe(
      "Refreshed the template list, and updated this profile's sources.list from https://files.pharo.org/pharo-launcher/sources.list.",
    );
    expect(kept.isError).toBeFalsy();
    expect(text(kept)).toBe(
      "Refreshed the template list, but kept this profile's sources.list: downloading https://files.pharo.org/pharo-launcher/sources.list failed (getaddrinfo ENOTFOUND files.pharo.org).",
    );
    expect(fs.readFileSync(sources, "utf8")).toBe("Pharo 14.0 - 64bit (stable)");
    expect(calls).toEqual(Array(4).fill([["template", "update"], ["template", "list", "--ston"]]).flat());
  });

  it("say why the refresh is not done", async () => {
    const { profile, config } = inProfile();
    const failedDownload = await callTool("template_update", {}, {
      config,
      runner: recording().runner,
      fetchTemplateSources: async () => {
        throw new Error("HTTP 503 Service Unavailable");
      },
    });
    fs.mkdirSync(profile.templateSourcesDir, { recursive: true });
    fs.writeFileSync(path.join(profile.templateSourcesDir, "sources.list"), "a source");
    const probe = await callTool("template_update", {}, {
      config,
      fetchTemplateSources: async () => "a source",
      runner: recording((args) =>
        args[1] === "update" ? exited(0) : exited(1, "", "Image template category 'x' not found."),
      ).runner,
    });
    const launcher = await callTool("template_update", {}, {
      config,
      runner: recording(() => exited(1, "", "no network")).runner,
    });

    expect(failedDownload.isError).toBe(true);
    expect(text(failedDownload)).toBe(
      `Refreshed the template list, but this profile still has no template sources: downloading https://files.pharo.org/pharo-launcher/sources.list failed (HTTP 503 Service Unavailable). Call template_update again, or put a sources.list in ${profile.templateSourcesDir}.`,
    );
    expect(text(probe)).toBe(
      "Refreshed the template list, but Pharo Launcher still cannot list templates: Image template category 'x' not found.",
    );
    expect(text(launcher)).toBe("Pharo Launcher could not refresh the template list: no network.");
  });
});

describe("arguments", () => {
  it("say which tool refused them and what it takes", async () => {
    const wrongType = await callTool("image_delete", { image: 42 }, { runner: unusedRunner });
    const missing = await callTool("image_delete", {}, { runner: unusedRunner });

    expect(wrongType.isError).toBe(true);
    expect(text(wrongType)).toBe(
      "Invalid arguments for image_delete. image must be a non-empty string. It takes image.",
    );
    expect(text(missing)).toBe(
      "Invalid arguments for image_delete. image is required. It takes image.",
    );
  });

  it.each([
    "missing_tool",
    "health",
    "raw_command",
    "vm_list",
    "template_info",
    "pharo_launcher_image_list",
  ])("answer %s as no tool", async (name) => {
    const result = await callTool(name, {});

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(`There is no tool ${name}.`);
  });
});
