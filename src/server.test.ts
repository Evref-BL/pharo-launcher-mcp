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
import { callTool, createServer, toolNames, type CallToolOptions } from "./server.js";
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
      pharo_launcher_config:
        "Say which Pharo Launcher this server runs, and where its images are.",
      pharo_launcher_image_list:
        "List this Launcher's images, each with its Pharo version, architecture, template and whether it runs. nameFilter keeps the images whose name contains it.",
      pharo_launcher_image_info:
        "Describe an image of this Launcher: its path, Pharo version, architecture, template and whether it runs.",
      pharo_launcher_image_create:
        "Create an image from a template. It is not started: pharo_launcher_image_start starts it.",
      pharo_launcher_image_delete:
        "Delete an image and its directory. Nothing asks for a confirmation. A running image is refused: stop it first with pharo_launcher_process_kill.",
      pharo_launcher_image_start:
        "Start an image, optionally with a script for it to run. Unless detached, the call lasts until the image quits.",
      pharo_launcher_process_list:
        "List the Pharo processes running an image of this Launcher, by image name and pid.",
      pharo_launcher_process_kill:
        "Kill a process running an image of this Launcher, by pid or by image name. A pid stops that process alone; an image name stops every process running that image.",
    });
    expect(descriptions.pharo_launcher_image_copy_between_profiles).toMatch(
      / A profile is given by its stateRoot, as pharo_launcher_config prints it\.$/,
    );
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
            vmUpdated: false,
            output: { stdout: "", stderr: "" },
          },
        });
      }
      return exited(0);
    });
    const argumentsByTool: Record<string, unknown> = {
      pharo_launcher_image_copy: { imageName: "base", newImageName: "copy" },
      pharo_launcher_image_create: { templateName: stable, newImageName: "made" },
      pharo_launcher_image_delete: { imageName: "base" },
      pharo_launcher_image_info: { imageName: ok ? "base" : "none" },
      pharo_launcher_image_start: { imageName: "base", script: "x.st" },
      pharo_launcher_process_kill: { imageName: "base" },
      pharo_launcher_image_copy_between_profiles: {
        sourceProfile: { stateRoot: other },
        destinationProfile: { stateRoot: profile.stateRoot },
        sourceImageName: "base",
        destinationImageName: ok ? "fresh" : "base",
      },
    };
    const base = path.join(images, "base", "base.image");
    return callTool(name, argumentsByTool[name] ?? {}, {
      config,
      runner,
      imageCopyVerificationTimeoutMs: 0,
      sleep: async () => {},
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

describe("pharo_launcher_config", () => {
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
      "pharo_launcher_config",
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

    expect(text(await callTool("pharo_launcher_config", {}, options))).toBe(
      [
        `Pharo Launcher ${launcher.launcherDir}, with the settings in ${settings}.`,
        `images: ${images}`,
      ].join("\n"),
    );

    fs.writeFileSync(settings, "PharoLauncherCLIConfiguration { }");
    expect(text(await callTool("pharo_launcher_config", {}, options))).toBe(
      [
        `Pharo Launcher ${launcher.launcherDir}, with the settings in ${settings}, which name no images directory.`,
        `images: ${defaultImages}`,
      ].join("\n"),
    );

    fs.rmSync(settings);
    expect(text(await callTool("pharo_launcher_config", {}, options))).toBe(
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
      "pharo_launcher_config",
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
      "No usable Pharo Launcher in /no/u/PL.app, /no/Applications/PL.app or /no/opt/pl. Install it, or set PHARO_LAUNCHER_DIR to where it is.",
      `images: ${images}`,
    ]);
  });
});

describe("pharo_launcher_image_list", () => {
  const nextStableImage = { metaInf: cliMetaInf(nextStable, nextStableUrl), pharoVersion: "140" };
  const shared = 'images (each pharoVersion=140 architecture=64 template="Pharo 14.0 - 64bit (next stable)"):';
  const alone = 'pharoVersion=140 architecture=64 template="Pharo 14.0 - 64bit (next stable)"';

  it("names every image, what they share once, and which run", async () => {
    const { config, images } = inProfile();
    const paths: Record<string, string> = {};
    for (const name of ["base", "pricing", "pricing-2025", "server", "stuck", "tmp-import"]) {
      paths[name] = writeImage(images, name, nextStableImage);
    }
    writeImage(images, "pricing-backup", { image: false, changes: false });

    const result = await callTool(
      "pharo_launcher_image_list",
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
        `6 images in ${images}, 2 running.`,
        `Warning: pricing-backup is not an image: ${images}/pricing-backup holds neither pricing-backup.image nor pricing-backup.changes.`,
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

  it("answers the same text whatever format or includeRaw an older caller passes", async () => {
    const { config, images } = inProfile();
    writeImage(images, "base", nextStableImage);
    writeImage(images, "pricing", nextStableImage);
    const options = { config, runner: unusedRunner, nativeProcess: processes() };

    expect(
      text(
        await callTool(
          "pharo_launcher_image_list",
          { format: "text", includeRaw: true, brief: 1 },
          options,
        ),
      ),
    ).toBe(text(await callTool("pharo_launcher_image_list", {}, options)));
  });

  it.each([
    ["one image", ["base"], [], {}, ["1 image in <images>, not running.", "images:", `  base ${alone}`]],
    ["one running", ["base"], ["base"], {}, ["1 image in <images>, running.", "images:", `  base ${alone} pids=1`]],
    ["none running", ["a", "b"], [], {}, ["2 images in <images>, none running.", shared, "  a", "  b"]],
    [
      "filtered",
      ["tmp-a", "tmp-b", "c"],
      [],
      { nameFilter: "tmp-" },
      ["2 of 3 images in <images> have tmp- in their name, none running.", shared, "  tmp-a", "  tmp-b"],
    ],
    [
      "filtered to one",
      ["tmp-a", "c"],
      ["tmp-a"],
      { nameFilter: "tmp-" },
      ["1 of 2 images in <images> has tmp- in its name, running.", "images:", `  tmp-a ${alone} pids=1`],
    ],
    ["filtered to none", ["a", "b"], [], { nameFilter: "tmp-" }, ["No image in <images> has tmp- in its name, out of 2."]],
    [
      "a filter holding a space",
      ["MCP debug", "c"],
      [],
      { nameFilter: "MCP debug" },
      [
        '1 of 2 images in <images> has "MCP debug" in its name, not running.',
        "images:",
        `  "MCP debug" ${alone}`,
      ],
    ],
    ["none", [], [], {}, ["No images in <images>."]],
  ])("%s", async (_label, names, running, input, expected) => {
    const { config, images } = inProfile();
    const lines = names.map((name, index) => {
      const imagePath = writeImage(images, name, nextStableImage);
      return running.includes(name) ? `${index + 1} /vms/pharo ${imagePath}` : "";
    });

    const result = await callTool("pharo_launcher_image_list", input, {
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
      "pharo_launcher_image_list",
      {},
      { config, runner: unusedRunner, nativeProcess: processes() },
    );

    expect(text(result).split("\n").slice(1)).toEqual([
      "images:",
      `  "MCP14 debug" ${alone}`,
      "  old pharoVersion=90 architecture=32",
    ]);
  });

  it("says when its directory does not exist", async () => {
    const { profile, config, images } = inProfile();
    fs.rmSync(profile.imagesDir, { recursive: true });

    const result = await callTool(
      "pharo_launcher_image_list",
      {},
      { config, runner: unusedRunner, nativeProcess: processes() },
    );

    expect(text(result)).toBe(`No images in ${images}, which does not exist.`);
  });

  it("drops the running part when it cannot tell, and says why", async () => {
    const { config, images } = inProfile();
    writeImage(images, "a", { pharoVersion: "140" });
    writeImage(images, "b", { pharoVersion: "140" });

    const result = await callTool(
      "pharo_launcher_image_list",
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
      "pharo_launcher_image_list",
      { nameFilter: "tmp-" },
      { config, runner: unusedRunner, nativeProcess: processes() },
    );

    expect(text(result).split("\n")).toEqual([
      `1 of 1 image in ${images} has tmp- in its name, not running.`,
      `Warning: tmp-half is not an image: ${images}/tmp-half holds no tmp-half.changes.`,
      "images:",
      "  tmp-a pharoVersion=140 architecture=64",
    ]);
  });
});

describe("pharo_launcher_image_info", () => {
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
      "pharo_launcher_image_info",
      { imageName: "stuck" },
      options([`71513 /vms/pharo ${stuck}`]),
    );
    const two = await callTool(
      "pharo_launcher_image_info",
      { imageName: "STUCK" },
      options([`71520 /vms/pharo ${stuck}`, `71513 /vms/pharo ${stuck}`]),
    );
    const none = await callTool("pharo_launcher_image_info", { imageName: "stuck" }, options([]));

    expect(one.isError).toBeUndefined();
    expect(text(one)).toBe(
      [
        "Image stuck runs as pid 71513.",
        `path: ${images}/stuck/stuck.image`,
        "pharoVersion: 140",
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
      "pharo_launcher_image_info",
      { imageName: "bare" },
      { config, runner: unusedRunner, nativeProcess: { platform: "freebsd" } },
    );

    expect(text(result)).toBe(
      [
        "Image bare.",
        "Warning: cannot tell whether it runs: listing processes is not supported on freebsd.",
        `path: ${images}/bare/bare.image`,
        "modified: 2026-11-14T11:08:01Z",
      ].join("\n"),
    );
  });

  it("refuses a name the profile's images directory does not hold, with no Launcher call", async () => {
    const { config, images } = inProfile();
    writeImage(images, "pricing-backup", { image: false, changes: false });
    writeImage(images, "half", { changes: false });
    writeImage(images, "other-half", { image: false });
    const options = { config, runner: unusedRunner, nativeProcess: processes() };
    const answer = async (imageName: string) =>
      callTool("pharo_launcher_image_info", { imageName }, options);

    const missing = await answer("releasecheck");

    expect(missing.isError).toBe(true);
    expect(text(missing)).toBe(
      `There is no image releasecheck in ${images}. pharo_launcher_image_list says which images there are.`,
    );
    expect(text(await answer("pricing-backup"))).toBe(
      `There is no image pricing-backup in ${images}: its directory holds neither pricing-backup.image nor pricing-backup.changes.`,
    );
    expect(text(await answer("half"))).toBe(
      `There is no image half in ${images}: its directory holds no half.changes.`,
    );
    expect(text(await answer("other-half"))).toBe(
      `There is no image other-half in ${images}: its directory holds no other-half.image.`,
    );
  });

  it("asks the Launcher about a name it does not find, outside a profile", async () => {
    const { config, images } = outsideProfile();
    const knows = recording(() => exited(0, "Image name: releasecheck"));
    const doesNot = recording(() =>
      exited(1, "Local image 'releasecheck' not found. Please enter a correct local image."),
    );

    const known = await callTool(
      "pharo_launcher_image_info",
      { imageName: "releasecheck" },
      { config, runner: knows.runner, nativeProcess: processes() },
    );
    const unknown = await callTool(
      "pharo_launcher_image_info",
      { imageName: "releasecheck" },
      { config, runner: doesNot.runner, nativeProcess: processes() },
    );

    expect(knows.calls).toEqual([["image", "info", "releasecheck"]]);
    expect(known.isError).toBeUndefined();
    expect(text(known)).toBe(
      `Pharo Launcher knows an image releasecheck, but ${images}, where this server reads images, does not hold it. pharo_launcher_config says where that directory comes from.`,
    );
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toBe(
      "Pharo Launcher could not read image releasecheck: Local image 'releasecheck' not found. Please enter a correct local image.",
    );
  });
});

describe("pharo_launcher_image_create", () => {
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
      "pharo_launcher_image_create",
      { templateName: stable, newImageName: "release-check", noLaunch: false },
      { config, runner },
    );

    expect(result.isError).toBeUndefined();
    expect(text(result)).toBe(
      [
        `Created image release-check from template ${stable}.`,
        `path: ${images}/release-check/release-check.image`,
        "pharoVersion: 130",
        "architecture: 64",
      ].join("\n"),
    );
    expect(calls).toEqual([createArgs, ["image", "info", "release-check"]]);
  });

  it("warns that it outlived the call, when the image is there", async () => {
    const { config, images } = inProfile();
    const { runner } = created(images, { exitCode: null, timedOut: true });

    const result = await callTool(
      "pharo_launcher_image_create",
      { templateName: stable, newImageName: "release-check" },
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
      "pharo_launcher_image_create",
      { templateName: stable, newImageName: "release-check" },
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
      "pharo_launcher_image_create",
      { templateName: stable, newImageName: "pricing-backup" },
      { config, runner: unusedRunner },
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      `There is already an image Pricing-Backup in ${images}. Pick another name, or delete it first with pharo_launcher_image_delete.`,
    );
  });

  it("lets the Launcher refuse a taken name outside a profile", async () => {
    const { config, images } = outsideProfile();
    writeImage(images, "pricing-backup");
    const { runner, calls } = recording(() =>
      exited(1, "", "An image with the same name already exists."),
    );

    const result = await callTool(
      "pharo_launcher_image_create",
      { templateName: stable, newImageName: "pricing-backup" },
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
    const input = { templateName: stable, newImageName: "release-check" };

    const neverListed = await callTool("pharo_launcher_image_create", input, { ...options, runner: never.runner });
    const neverOpened = await callTool("pharo_launcher_image_create", input, { ...options, runner: unopened.runner });

    expect(neverListed.isError).toBe(true);
    expect(text(neverListed)).toBe(
      `Pharo Launcher said it created release-check, but ${images}/release-check does not exist after 0 s.`,
    );
    expect(neverOpened.isError).toBe(true);
    expect(text(neverOpened)).toBe(
      "Pharo Launcher made release-check but cannot open it: STONReaderError: unexpected token.",
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
    const inNightly = { templateName: stable, templateCategory: "Nightly", newImageName: "x" };

    const template = await callTool(
      "pharo_launcher_image_create",
      { templateName: "Pharo 99", newImageName: "x" },
      { config, runner: noTemplate.runner },
    );
    const noSources = await callTool("pharo_launcher_image_create", inNightly, { config, runner: noCategory.runner });
    fs.mkdirSync(profile.templateSourcesDir, { recursive: true });
    fs.writeFileSync(path.join(profile.templateSourcesDir, "sources.list"), "a source");
    const category = await callTool("pharo_launcher_image_create", inNightly, { config, runner: noCategory.runner });

    expect(text(template)).toBe(
      "Pharo Launcher could not create image x: Pharo 99 not found, please enter a correct template name. pharo_launcher_template_list says which templates there are.",
    );
    expect(text(noSources)).toBe(
      "There are no templates yet: call pharo_launcher_template_update first.",
    );
    expect(text(category)).toBe(
      "Pharo Launcher could not create image x: Nightly not found, please enter a correct category name. pharo_launcher_template_category_list says which categories there are.",
    );
  });

  it("gives a Launcher that could not start as its diagnostic lines", async () => {
    const { profile, config } = inProfile();
    const runner: LauncherCliRunner = async () => {
      throw new Error("spawn bash ENOENT");
    };

    const result = await callTool(
      "pharo_launcher_image_create",
      { templateName: stable, newImageName: "Task" },
      { config, runner },
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^Failed to start PharoLauncher CLI command: spawn bash ENOENT\n/);
    expect(text(result)).toContain(`PHARO_LAUNCHER_MCP_STATE_ROOT: ${profile.stateRoot}`);
  });
});

describe("pharo_launcher_image_copy", () => {
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
      "pharo_launcher_image_copy",
      { imageName: "pricing", newImageName: "pricing-backup" },
      { config, runner },
    );

    expect(text(result)).toBe(
      [
        "Copied image pricing to pricing-backup.",
        `path: ${images}/pricing-backup/pricing-backup.image`,
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

    const source = await callTool("pharo_launcher_image_copy", { imageName: "pricng", newImageName: "x" }, options);
    const target = await callTool(
      "pharo_launcher_image_copy",
      { imageName: "pricing", newImageName: "PRICING-BACKUP" },
      options,
    );

    expect(text(source)).toBe(
      `There is no image pricng in ${images}. pharo_launcher_image_list says which images there are.`,
    );
    expect(text(target)).toBe(
      `There is already an image pricing-backup in ${images}. Pick another name, or delete it first with pharo_launcher_image_delete.`,
    );
  });

  it("gives the Launcher's own refusal outside a profile", async () => {
    const { config } = outsideProfile();
    const { runner } = recording(() => exited(1, "Target image name 'pricing-backup' already used."));

    const result = await callTool(
      "pharo_launcher_image_copy",
      { imageName: "pricing", newImageName: "pricing-backup" },
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
      "pharo_launcher_image_copy",
      { imageName: "pricing", newImageName: "pricing-backup" },
      { config, runner, imageCopyVerificationTimeoutMs: 0, sleep: async () => {} },
    );

    expect(text(result)).toBe(
      `Pharo Launcher said it copied pricing to pricing-backup, but ${images}/pricing-backup does not exist after 0 s.`,
    );
  });
});

describe("pharo_launcher_image_delete", () => {
  it("deletes a stopped image", async () => {
    const { config, images } = inProfile();
    writeImage(images, "tmp-scratch");
    const { runner, calls } = recording();

    const result = await callTool(
      "pharo_launcher_image_delete",
      { imageName: "tmp-scratch", force: true },
      { config, runner, nativeProcess: processes() },
    );

    expect(result.isError).toBeUndefined();
    expect(text(result)).toBe("Deleted image tmp-scratch.");
    expect(calls).toEqual([["image", "delete", "--force", "tmp-scratch"]]);
  });

  it("refuses a running image, in every mode, with no Launcher call", async () => {
    for (const { config, images } of [inProfile(), outsideProfile()]) {
      const scratch = writeImage(images, "tmp-scratch");
      const answer = async (lines: string[]) =>
        callTool(
          "pharo_launcher_image_delete",
          { imageName: "tmp-scratch" },
          { config, runner: unusedRunner, nativeProcess: processes(lines) },
        );

      const one = await answer([`71513 /vms/pharo ${scratch}`]);
      const two = await answer([`71513 /vms/pharo ${scratch}`, `71520 /vms/pharo ${scratch}`]);

      expect(one.isError).toBe(true);
      expect(text(one)).toBe(
        "Image tmp-scratch runs as pid 71513: stop it with pharo_launcher_process_kill, then delete it.",
      );
      expect(text(two)).toBe(
        "Image tmp-scratch runs as pids 71513, 71520: stop it with pharo_launcher_process_kill, then delete it.",
      );
    }
  });

  it("refuses when it cannot tell whether the image runs", async () => {
    const { config, images } = inProfile();
    writeImage(images, "tmp-scratch");

    const result = await callTool(
      "pharo_launcher_image_delete",
      { imageName: "tmp-scratch" },
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
      "pharo_launcher_image_delete",
      { imageName: "tmp-scratch" },
      { config: profile.config, runner: unusedRunner, nativeProcess: processes() },
    );
    const asked = await callTool(
      "pharo_launcher_image_delete",
      { imageName: "tmp-scratch" },
      { config: outside.config, runner, nativeProcess: processes() },
    );

    expect(text(refused)).toBe(
      `There is no image tmp-scratch in ${profile.images}. pharo_launcher_image_list says which images there are.`,
    );
    expect(calls).toEqual([["image", "delete", "--force", "tmp-scratch"]]);
    expect(text(asked)).toBe(
      "Pharo Launcher could not delete image tmp-scratch: Local image 'tmp-scratch' not found. Please enter a correct local image.",
    );
  });
});

describe("pharo_launcher_image_start", () => {
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
      vmUpdated: false,
      ...extra,
    };
  }

  function started(result: Partial<LauncherCliResult>) {
    return recording(() => ({ ...exited(0), ...result }));
  }

  function start(config: PharoLauncherConfig, input: Record<string, unknown>, runner: LauncherCliRunner) {
    return callTool("pharo_launcher_image_start", { imageName: "release-check", ...input }, { config, runner });
  }

  it("says how a waited start ran, and what the VM wrote", async () => {
    const { config, images } = inProfile();
    writeImage(images, "release-check");
    const { runner } = started({
      launch: vmLaunch(images, { output: { stdout: "Loaded.\nSaved.\n", stderr: "" } }),
    });

    const result = await start(config, { script: "check.st" }, runner);

    expect(result.isError).toBeUndefined();
    expect(text(result)).toBe(
      [
        "release-check ran headless and quit with exit code 0.",
        "Its output ends with:",
        "  Loaded.",
        "  Saved.",
      ].join("\n"),
    );
  });

  it("names a downloaded VM, a window, and a headless image with nothing to run", async () => {
    const { config, images } = inProfile();
    writeImage(images, "release-check");
    const interactive = started({
      launch: vmLaunch(images, {
        displayMode: "interactive",
        vmUpdated: true,
        output: { stdout: "", stderr: "" },
      }),
    });
    const headless = started({
      launch: vmLaunch(images, { output: { stdout: "", stderr: "usage: pharo" } }),
    });

    const window = await start(config, { displayMode: "interactive" }, interactive.runner);
    const noScript = await start(config, {}, headless.runner);

    expect(text(window)).toBe(
      [
        "release-check ran with its window and quit with exit code 0.",
        "Downloaded VM 130-x64 for it first.",
      ].join("\n"),
    );
    expect(text(noScript)).toBe(
      [
        "release-check ran headless and quit with exit code 0.",
        "A headless image with no script has nothing to run and quits: pass a script, or displayMode: interactive.",
        "Its error output ends with:",
        "  usage: pharo",
      ].join("\n"),
    );
  });

  it("keeps the last 20 lines of what the VM wrote", async () => {
    const { config, images } = inProfile();
    writeImage(images, "release-check");
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
    const { runner } = started({
      exitCode: 1,
      launch: vmLaunch(images, { output: { stdout: "", stderr: lines.join("\n") } }),
    });

    const result = await start(config, { script: "x.st" }, runner);

    expect(result.isError).toBe(true);
    expect(text(result).split("\n")).toEqual([
      "release-check quit with exit code 1.",
      "Its error output ends with:",
      ...lines.slice(10).map((line) => `  ${line}`),
    ]);
  });

  it("says a waited start past the call's timeout was stopped", async () => {
    const { config, images } = inProfile();
    writeImage(images, "release-check");
    const { runner } = started({
      exitCode: null,
      timedOut: true,
      launch: vmLaunch(images, { output: { stdout: "", stderr: "" } }),
    });

    const result = await start(config, { script: "x.st" }, runner);

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      "release-check did not quit within 30 s and was stopped: a start that is not detached lasts as long as the call. Pass detached: true to leave it running.",
    );
  });

  it("names the pid and the logs of a detached start", async () => {
    const { config, images } = inProfile();
    writeImage(images, "release-check");
    const logs = {
      stdout: "/logs/x-release-check-launch.out.log",
      stderr: "/logs/x-release-check-launch.err.log",
    };
    const plain = started({ launch: vmLaunch(images, { pid: 73028, logs }) });
    const window = started({
      launch: vmLaunch(images, { pid: 73028, logs, displayMode: "interactive", vmUpdated: true }),
    });
    const logsLine = `logs: ${logs.stdout} and ${logs.stderr}`;

    const headless = await start(config, { detached: true, script: "x.st" }, plain.runner);
    const noScript = await start(config, { detached: true }, plain.runner);
    const interactive = await start(config, { detached: true, displayMode: "interactive" }, window.runner);

    expect(text(headless)).toBe(
      ["Started release-check headless, detached, as pid 73028.", logsLine].join("\n"),
    );
    expect(text(noScript)).toBe(
      [
        "Started release-check headless, detached, as pid 73028.",
        "Warning: a headless image given no script usually quits at once; pharo_launcher_process_list says whether it still runs. Pass a script, or displayMode: interactive.",
        logsLine,
      ].join("\n"),
    );
    expect(text(interactive)).toBe(
      [
        "Started release-check with its window, detached, as pid 73028.",
        "Downloaded VM 130-x64 for it first.",
        logsLine,
      ].join("\n"),
    );
  });

  it("says the Launcher is starting it, outside a profile", async () => {
    const { config, images } = outsideProfile();
    writeImage(images, "release-check");
    const logs = { stdout: "/logs/a.out.log", stderr: "/logs/a.err.log" };
    const detached = started({ launch: { by: "launcher", pid: 73100, logs } });
    const waited = started({ stdout: "Hello", launch: { by: "launcher" } });
    const quit = started({ exitCode: 1, stderr: "Error", launch: { by: "launcher" } });

    expect(text(await start(config, { detached: true }, detached.runner))).toBe(
      [
        "Pharo Launcher is starting release-check (its own pid 73100); pharo_launcher_process_list shows the image's VM once it runs.",
        `logs: ${logs.stdout} and ${logs.stderr}`,
      ].join("\n"),
    );
    expect(text(await start(config, {}, waited.runner))).toBe(
      ["release-check ran and quit with exit code 0.", "Its output ends with:", "  Hello"].join("\n"),
    );
    expect(text(await start(config, {}, quit.runner))).toBe(
      ["release-check quit with exit code 1.", "Its error output ends with:", "  Error"].join("\n"),
    );
  });

  it("gives the Launcher's refusal of an image it does not find, outside a profile", async () => {
    const { config } = outsideProfile();
    const { runner } = started({
      exitCode: 1,
      stdout: "Local image 'nope' not found. Please enter a correct local image.",
      launch: { by: "launcher" },
    });

    const result = await callTool("pharo_launcher_image_start", { imageName: "nope" }, { config, runner });

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
      "pharo_launcher_image_start",
      { imageName: "releasecheck" },
      { config, runner: unusedRunner },
    );
    const noVm = await start(config, {}, runner);

    expect(text(missing)).toBe(
      `There is no image releasecheck in ${images}. pharo_launcher_image_list says which images there are.`,
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
      "pharo_launcher_image_start",
      { imageName: "release-check", displayMode: "interactive" },
      { config },
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^displayMode needs a scoped launcher profile\. /);
  });
});

describe("pharo_launcher_image_copy_between_profiles", () => {
  function profiles() {
    const source = temporary("pharo-launcher-mcp-source-profile-");
    const destination = temporary("pharo-launcher-mcp-destination-profile-");
    writeImage(path.join(source, "images"), "pricing", { metaInf: cliMetaInf(stable, stableUrl) });
    return { source, destination };
  }

  function copy(source: string, destination: string, sourceImageName = "pricing", destinationImageName = sourceImageName) {
    return callTool(
      "pharo_launcher_image_copy_between_profiles",
      {
        sourceProfile: { stateRoot: source },
        destinationProfile: { stateRoot: destination },
        sourceImageName,
        destinationImageName,
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
        `path: ${destination}/images/pricing/pricing.image`,
      ].join("\n"),
    );
    expect(text(renamed).split("\n")[0]).toBe(
      `Copied image pricing from ${source} to ${destination} as pricing-2.`,
    );
  });

  it("says why it could not copy", async () => {
    const { source, destination } = profiles();
    fs.rmSync(path.join(writeImage(path.join(source, "images"), "no-image")));
    writeImage(path.join(source, "images"), "no-record");
    await copy(source, destination);

    expect(text(await copy(source, destination, "pricng"))).toBe(
      `Cannot copy image pricng: ${source}/images/pricng does not exist.`,
    );
    expect(text(await copy(source, destination, "no-image"))).toBe(
      `Cannot copy image no-image: ${source}/images/no-image holds no no-image.image.`,
    );
    expect(text(await copy(source, destination, "no-record"))).toBe(
      `Cannot copy image no-record: ${source}/images/no-record holds no meta-inf.ston, Pharo Launcher's record of the image.`,
    );
    expect(text(await copy(source, destination))).toBe(
      `Cannot copy image pricing to ${destination}/images/pricing: that path already exists, and a copy never replaces it. Pick another destinationImageName, or remove it first.`,
    );
  });

  it("says a copy that did not check out was removed", async () => {
    const { source, destination } = profiles();
    fs.writeFileSync(path.join(source, "images", "pricing", "meta-inf.ston"), "PhLImage {}");

    const result = await copy(source, destination, "pricing", "task");

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      "Cannot copy image pricing: the copy did not check out (destination image metadata does not reference the requested image file), so it was removed.",
    );
  });

  it("says what it takes when its arguments are wrong", async () => {
    const result = await callTool(
      "pharo_launcher_image_copy_between_profiles",
      {
        sourceProfile: {},
        destinationProfile: { stateRoot: "/tmp/x" },
        sourceImageName: "a",
        destinationImageName: "b",
      },
      { runner: unusedRunner },
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      "Invalid arguments for pharo_launcher_image_copy_between_profiles. sourceProfile must include stateRoot or explicit launcherConfiguration, imagesDir, vmsDir, templateSourcesDir, initScriptsDir, logsDir. It takes sourceProfile, destinationProfile, sourceImageName, destinationImageName.",
    );
  });
});

describe("the process tools", () => {
  const home = path.join(os.tmpdir(), "no-such-home");
  const latestMcp = path.join(home, "Documents", "Pharo", "images", "LatestMCP", "LatestMCP.image");
  const plexus = path.join(home, ".plexus", "profiles", "images", "x", "x.image");

  function machine(...images: string[]): string[] {
    return [
      `17880 /Applications/PharoLauncher.app/Contents/MacOS/Pharo ${latestMcp}`,
      ...images.map((image, index) => `${71513 + index * 7} /vms/140-x64/Pharo --headless ${image}`),
      `71600 /plexus/vms/140-x64/Pharo ${plexus}`,
    ];
  }

  it("list the processes of this Launcher's images alone, in every mode", async () => {
    for (const { config, images } of [inProfile(), outsideProfile()]) {
      const stuck = writeImage(images, "stuck");
      const server = writeImage(images, "server");

      const result = await callTool(
        "pharo_launcher_process_list",
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
      "pharo_launcher_process_list",
      {},
      { config, runner: unusedRunner, nativeProcess: processes(machine(...paths)) },
    );

    expect(text(result)).toBe(expected.replaceAll("<images>", images));
  });

  it("say why they could not list", async () => {
    const { config } = inProfile();
    const options = { config, runner: unusedRunner, nativeProcess: { platform: "freebsd" as const } };

    const listed = await callTool("pharo_launcher_process_list", {}, options);
    const killed = await callTool("pharo_launcher_process_kill", { pid: 1 }, options);

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
    const byName = await callTool("pharo_launcher_process_kill", { imageName: "STUCK" }, { config, ...one.options });
    const two = killing(lines);
    const both = await callTool("pharo_launcher_process_kill", { imageName: "stuck" }, { config, ...two.options });
    const pid = killing(lines);
    const byPid = await callTool("pharo_launcher_process_kill", { pid: "71520" }, { config, ...pid.options });

    expect(text(byName)).toBe("Killed stuck (pid 71513).");
    expect(one.killed).toEqual([71513]);
    expect(text(both)).toBe("Killed 2 processes of stuck (pids 71513, 71520).");
    expect(two.killed).toEqual([71513, 71520]);
    expect(text(byPid)).toBe("Killed pid 71520, which ran stuck.");
    expect(pid.killed).toEqual([71520]);
  });

  it("kill nothing outside this Launcher's images, in every mode", async () => {
    for (const { config, images } of [inProfile(), outsideProfile()]) {
      const stuck = writeImage(images, "stuck");
      const { killed, options } = killing(machine(stuck));

      const byName = await callTool("pharo_launcher_process_kill", { imageName: "LatestMCP" }, { config, ...options });
      const byPid = await callTool("pharo_launcher_process_kill", { pid: 17880 }, { config, ...options });

      expect(byName.isError).toBe(true);
      expect(text(byName)).toBe(
        "No process runs image LatestMCP. pharo_launcher_process_list says which run.",
      );
      expect(text(byPid)).toBe(
        `No process of an image in ${images} has pid 17880. pharo_launcher_process_list says which run.`,
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

    const result = await callTool("pharo_launcher_process_kill", { imageName: "stuck" }, { config, ...slow.options });

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

    const result = await callTool("pharo_launcher_process_kill", { imageName: "stuck" }, { config, ...partly.options });
    const nothing = await callTool("pharo_launcher_process_kill", { pid: 71513 }, { config, ...none.options });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Killed stuck (pid 71520); could not kill pid 71513: kill EPERM.");
    expect(partly.killed).toEqual([71520]);
    expect(text(nothing)).toBe("Could not kill pid 71513: kill EPERM.");
  });

  it("take one target, and a pid only as a number", async () => {
    const { config } = inProfile();
    const answer = async (input: Record<string, unknown>) =>
      text(await callTool("pharo_launcher_process_kill", input, { config, runner: unusedRunner }));

    expect(await answer({ pid: 1, imageName: "x" })).toBe(
      "Invalid arguments for pharo_launcher_process_kill. Give pid or imageName, not both. It takes imageName, pid.",
    );
    expect(await answer({})).toBe(
      "Invalid arguments for pharo_launcher_process_kill. Give the pid or the imageName of the process to kill. It takes imageName, pid.",
    );
    expect(await answer({ pid: "stuck" })).toBe(
      "Invalid arguments for pharo_launcher_process_kill. pid must be a process id, a whole number. It takes imageName, pid.",
    );
  });
});

describe("the templates", () => {
  it("list the categories in the Launcher's order, and its default", async () => {
    const { config } = inProfile();
    const answer = async (stdout: string) =>
      text(
        await callTool(
          "pharo_launcher_template_category_list",
          { format: "ston" },
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

    const result = await callTool("pharo_launcher_template_category_list", {}, { config, runner });

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
        await callTool("pharo_launcher_template_list", input, {
          config,
          runner: recording(() => exited(0, stdout)).runner,
        }),
      );

    const inCategory = await callTool(
      "pharo_launcher_template_list",
      { templateCategory: "Official distributions", rowMode: true },
      { config, runner },
    );
    const inDefault = await callTool("pharo_launcher_template_list", {}, { config, runner });

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
    expect(await listing({ templateCategory: "Moose" }, "OrderedCollection[PhLLocalTemplate{#name:'m'}]")).toBe(
      ["1 template in Moose.", "templates:", "  m"].join("\n"),
    );
    expect(await listing({ templateCategory: "Moose" }, "OrderedCollection[]")).toBe(
      "No templates in Moose.",
    );
  });

  it("say there are no templates yet, or no such category", async () => {
    const { profile, config } = inProfile();
    const notFound = recording(() =>
      exited(1, "Image template category 'Nightly' not found. Please enter a correct image tamplate category name."),
    );

    const noSources = await callTool("pharo_launcher_template_list", { templateCategory: "Nightly" }, { config, runner: notFound.runner });
    const defaultNoSources = await callTool("pharo_launcher_template_list", {}, { config, runner: notFound.runner });
    fs.mkdirSync(profile.templateSourcesDir, { recursive: true });
    fs.writeFileSync(path.join(profile.templateSourcesDir, "sources.list"), "a source");
    const noCategory = await callTool("pharo_launcher_template_list", { templateCategory: "Nightly" }, { config, runner: notFound.runner });
    const timedOut = await callTool(
      "pharo_launcher_template_list",
      {},
      { config, runner: recording(() => exited(null, "", "", { timedOut: true })).runner },
    );

    expect(noSources.isError).toBe(true);
    expect(text(noSources)).toBe("There are no templates yet: call pharo_launcher_template_update first.");
    expect(text(defaultNoSources)).toBe(text(noSources));
    expect(text(noCategory)).toBe(
      "There is no template category Nightly. pharo_launcher_template_category_list lists them.",
    );
    expect(text(timedOut)).toBe("Pharo Launcher did not finish list templates within 30 s.");
  });

  it("refresh the list, and download the profile's sources", async () => {
    const { profile, config } = inProfile();
    const { runner, calls } = recording((args) =>
      args[1] === "update" ? exited(0) : exited(0, "OrderedCollection[PhLRemoteTemplate{#name:'Pharo 13'}]"),
    );

    const downloaded = await callTool("pharo_launcher_template_update", {}, {
      config,
      runner,
      fetchTemplateSources: async () => "https://files.pharo.org/image/130/latest-64.zip",
    });
    const refreshed = await callTool("pharo_launcher_template_update", {}, { config, runner });

    expect(text(downloaded)).toBe(
      "Refreshed the template list, and downloaded this profile's sources.list from https://files.pharo.org/pharo-launcher/sources.list.",
    );
    expect(fs.readFileSync(path.join(profile.templateSourcesDir, "sources.list"), "utf8")).toContain(
      "latest-64.zip",
    );
    expect(text(refreshed)).toBe("Refreshed the template list.");
    expect(calls).toEqual([
      ["template", "update"],
      ["template", "list", "--ston"],
      ["template", "update"],
      ["template", "list", "--ston"],
    ]);
  });

  it("say why the refresh is not done", async () => {
    const { profile, config } = inProfile();
    const failedDownload = await callTool("pharo_launcher_template_update", {}, {
      config,
      runner: recording().runner,
      fetchTemplateSources: async () => {
        throw new Error("HTTP 503 Service Unavailable");
      },
    });
    fs.mkdirSync(profile.templateSourcesDir, { recursive: true });
    fs.writeFileSync(path.join(profile.templateSourcesDir, "sources.list"), "a source");
    const probe = await callTool("pharo_launcher_template_update", {}, {
      config,
      runner: recording((args) =>
        args[1] === "update" ? exited(0) : exited(1, "", "Image template category 'x' not found."),
      ).runner,
    });
    const launcher = await callTool("pharo_launcher_template_update", {}, {
      config,
      runner: recording(() => exited(1, "", "no network")).runner,
    });

    expect(failedDownload.isError).toBe(true);
    expect(text(failedDownload)).toBe(
      `Refreshed the template list, but this profile still has no template sources: downloading https://files.pharo.org/pharo-launcher/sources.list failed (HTTP 503 Service Unavailable). Call pharo_launcher_template_update again, or put a sources.list in ${profile.templateSourcesDir}.`,
    );
    expect(text(probe)).toBe(
      "Refreshed the template list, but Pharo Launcher still cannot list templates: Image template category 'x' not found.",
    );
    expect(text(launcher)).toBe("Pharo Launcher could not refresh the template list: no network.");
  });
});

describe("arguments", () => {
  it("say which tool refused them and what it takes", async () => {
    const wrongType = await callTool("pharo_launcher_image_delete", { imageName: 42 }, { runner: unusedRunner });
    const missing = await callTool("pharo_launcher_image_delete", {}, { runner: unusedRunner });

    expect(wrongType.isError).toBe(true);
    expect(text(wrongType)).toBe(
      "Invalid arguments for pharo_launcher_image_delete. imageName must be a non-empty string. It takes imageName.",
    );
    expect(text(missing)).toBe(
      "Invalid arguments for pharo_launcher_image_delete. imageName is required. It takes imageName.",
    );
  });

  it.each([
    "missing_tool",
    "pharo_launcher_health",
    "pharo_launcher_raw_command",
    "pharo_launcher_vm_list",
    "pharo_launcher_template_info",
  ])("answer %s as no tool", async (name) => {
    const result = await callTool(name, {});

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(`There is no tool ${name}.`);
  });
});
