import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPharoLauncherConfig } from "./config.js";
import {
  compareCodePoints,
  filterByName,
  findByName,
  processesOfImages,
  readLauncherImage,
  resolveImagesDirectory,
  scanImages,
  settingsImagesDirectory,
  whatItLacks,
  whereCommandLineNamesFile,
} from "./imageStore.js";
import { launcherUserFilesLocation } from "./platform.js";
import {
  cliMetaInf,
  guiMetaInf,
  tempDirectory,
  tempProfile,
  testConfig,
  writeImage,
} from "./testing/images.js";

const created: string[] = [];

function temp(prefix: string): string {
  const directory = tempDirectory(prefix);
  created.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of created.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const nextStable = "Pharo 14.0 - 64bit (next stable)";
const nextStableUrl = "https://files.pharo.org/image/140/latest-64.zip";

function vmProcess(pid: number, commandLine: string) {
  return { pid, commandLine };
}

function commandLineNamesFile(commandLine: string, filePath: string, platform: NodeJS.Platform): boolean {
  return whereCommandLineNamesFile(commandLine, filePath, platform) >= 0;
}

describe("the images directory", () => {
  it("is the profile's in profile mode", () => {
    const profile = tempProfile();
    created.push(profile.stateRoot);

    expect(resolveImagesDirectory(testConfig({ profile }))).toEqual({
      path: path.resolve(profile.imagesDir),
      source: "profile",
    });
  });

  it("is what launcherSettings.ston names, outside a profile", () => {
    const home = temp("pharo-launcher-mcp-home-");
    const config = loadPharoLauncherConfig({ HOME: home }, process.platform);
    const userFiles = config.launcherUserFilesDir!;
    const named = path.join(home, "It's here", "images");
    fs.mkdirSync(userFiles, { recursive: true });
    // A doubled quote is one quote, as STON writes it.
    fs.writeFileSync(
      path.join(userFiles, "launcherSettings.ston"),
      [
        "PharoLauncherCLIConfiguration {",
        `\t#imagesDirectory : FILE [ '${named.replaceAll("'", "''")}' ],`,
        "\t#vmsDirectory : FILE [ '/elsewhere/vms' ]",
        "}",
      ].join("\n"),
    );

    expect(resolveImagesDirectory(config)).toEqual({
      path: named,
      source: "settings",
      settingsFile: path.join(userFiles, "launcherSettings.ston"),
    });
  });

  it("is the Launcher's default when no settings file names one", () => {
    const home = temp("pharo-launcher-mcp-home-");
    const config = loadPharoLauncherConfig({ HOME: home }, process.platform);
    const userFiles = config.launcherUserFilesDir!;

    expect(resolveImagesDirectory(config)).toEqual({
      path: path.join(userFiles, "images"),
      source: "default",
      settingsFile: path.join(userFiles, "launcherSettings.ston"),
    });

    fs.mkdirSync(userFiles, { recursive: true });
    fs.writeFileSync(
      path.join(userFiles, "launcherSettings.ston"),
      "PharoLauncherCLIConfiguration { #launchImageFromALoginShell : true }",
    );
    expect(resolveImagesDirectory(config).source).toBe("default");
  });

  it("is what PHARO_LAUNCHER_MCP_LAUNCHER_CONFIGURATION names, over launcherSettings.ston", () => {
    const home = temp("pharo-launcher-mcp-home-");
    const configuration = path.join(home, "custom.ston");
    const config = loadPharoLauncherConfig(
      { HOME: home, PHARO_LAUNCHER_MCP_LAUNCHER_CONFIGURATION: configuration },
      process.platform,
    );
    fs.mkdirSync(config.launcherUserFilesDir!, { recursive: true });
    fs.writeFileSync(
      path.join(config.launcherUserFilesDir!, "launcherSettings.ston"),
      `PharoLauncherCLIConfiguration { #imagesDirectory : FILE [ '${path.join(home, "settings-images")}' ] }`,
    );
    fs.writeFileSync(
      configuration,
      `PharoLauncherCLIConfiguration { #imagesDirectory : FILE [ '${path.join(home, "configured-images")}' ] }`,
    );

    expect(resolveImagesDirectory(config)).toEqual({
      path: path.join(home, "configured-images"),
      source: "configuration",
      settingsFile: configuration,
    });
  });

  it("keeps the Launcher's user files where each platform's resolver puts them", () => {
    expect(launcherUserFilesLocation({ HOME: "/Users/ada" }, "darwin")).toBe(
      "/Users/ada/Documents/Pharo",
    );
    expect(launcherUserFilesLocation({ HOME: "/home/ada" }, "linux")).toBe(
      "/home/ada/Pharo",
    );
    expect(
      launcherUserFilesLocation({ USERPROFILE: "C:\\Users\\Ada" }, "win32"),
    ).toBe("C:\\Users\\Ada\\Documents\\Pharo");
  });

  it("drops the slash STON writes before a Windows drive letter", () => {
    const settings =
      "PharoLauncherCLIConfiguration { #imagesDirectory : FILE [ '/C:/Users/Ada/Documents/Pharo/images' ] }";

    expect(settingsImagesDirectory(settings, "win32")).toBe(
      "C:/Users/Ada/Documents/Pharo/images",
    );
    expect(settingsImagesDirectory(settings, "linux")).toBe(
      "/C:/Users/Ada/Documents/Pharo/images",
    );
  });
});

describe("the reader", () => {
  it("reads an image as the CLI creates it", () => {
    const imagesDir = temp("pharo-launcher-mcp-images-");
    writeImage(imagesDir, "base", {
      metaInf: cliMetaInf(nextStable, nextStableUrl),
      pharoVersion: "140\n",
    });

    const [entry] = scanImages(imagesDir).images;

    expect(readLauncherImage(entry!)).toEqual({
      name: "base",
      imagePath: path.join(imagesDir, "base", "base.image"),
      pharoVersion: "140",
      architecture: "64",
      template: { name: nextStable, url: nextStableUrl },
      modified: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
    });
  });

  it("reads an image as the GUI leaves it from its meta-inf.ston", () => {
    const imagesDir = temp("pharo-launcher-mcp-images-");
    writeImage(imagesDir, "gui", {
      metaInf: guiMetaInf({
        imageName: "gui",
        pharoVersion: "130",
        architecture: "64",
        templateName: "Pharo 13.0 - 64bit (stable)",
        url: "https://files.pharo.org/image/130/latest-64.zip",
        vmId: "130-x64",
      }),
      pharoVersion: "120",
      format: 6521,
    });

    const image = readLauncherImage(scanImages(imagesDir).images[0]!);

    expect(image).toMatchObject({
      name: "gui",
      pharoVersion: "130",
      architecture: "64",
      vmId: "130-x64",
      // A launch configuration has a #name too: 'Default'.
      template: { name: "Pharo 13.0 - 64bit (stable)" },
    });
  });

  it("reads the architecture off the header when meta-inf.ston has none", () => {
    const imagesDir = temp("pharo-launcher-mcp-images-");
    writeImage(imagesDir, "spur32", { format: 6521 });
    writeImage(imagesDir, "prespur", { format: 6505 });
    writeImage(imagesDir, "unknown", { format: 1234 });

    const images = scanImages(imagesDir).images.map(readLauncherImage);

    expect(images.map((image) => [image.name, image.architecture])).toEqual([
      ["prespur", "32"],
      ["spur32", "32"],
      ["unknown", undefined],
    ]);
  });

  it("tells an image from a directory that is not one, and says what it lacks", () => {
    const imagesDir = temp("pharo-launcher-mcp-images-");
    // A hand copy: the files keep the name they were copied from.
    fs.mkdirSync(path.join(imagesDir, "pricing-backup"));
    fs.writeFileSync(path.join(imagesDir, "pricing-backup", "pricing.image"), "");
    fs.writeFileSync(path.join(imagesDir, "pricing-backup", "pricing.changes"), "");
    writeImage(imagesDir, "D", { changes: false });
    writeImage(imagesDir, "MCP14 debug");
    // This server's temporary copy.
    writeImage(imagesDir, ".tmp-import.copy-1-2-0.tmp");
    fs.writeFileSync(path.join(imagesDir, "loose.image"), "");

    const scan = scanImages(imagesDir);

    expect(scan.images.map((image) => image.name)).toEqual(["MCP14 debug"]);
    expect(scan.notImages).toEqual([
      {
        name: "D",
        directory: path.join(imagesDir, "D"),
        hasImage: true,
        hasChanges: false,
      },
      {
        name: "pricing-backup",
        directory: path.join(imagesDir, "pricing-backup"),
        hasImage: false,
        hasChanges: false,
      },
    ]);
    expect(scan.notImages.map(whatItLacks)).toEqual([
      "holds no D.changes",
      "holds neither pricing-backup.image nor pricing-backup.changes",
    ]);
    expect(
      whatItLacks({ name: "x", hasImage: false, hasChanges: true }),
    ).toBe("holds no x.image");
  });

  it("reports a directory that does not exist", () => {
    const imagesDir = path.join(temp("pharo-launcher-mcp-images-"), "absent");

    expect(scanImages(imagesDir)).toEqual({
      imagesDir,
      exists: false,
      images: [],
      notImages: [],
    });
  });

  it("filters names as the Launcher's includesSubstring:, case-sensitive", () => {
    const imagesDir = temp("pharo-launcher-mcp-images-");
    for (const name of ["pricing", "pricing-2025", "tmp-import", "tmp-scratch", "base"]) {
      writeImage(imagesDir, name);
    }
    const { images } = scanImages(imagesDir);
    const names = (filter: string) =>
      filterByName(images, filter).map((image) => image.name);

    expect(names("pricing")).toEqual(["pricing", "pricing-2025"]);
    expect(names("tmp-")).toEqual(["tmp-import", "tmp-scratch"]);
    expect(names("Pricing")).toEqual([]);
  });

  it("finds a name exactly, else ignoring case, as imageNamed: does", () => {
    const imagesDir = temp("pharo-launcher-mcp-images-");
    writeImage(imagesDir, "pricing");
    writeImage(imagesDir, "pricing-2025");
    const { images } = scanImages(imagesDir);

    expect(findByName(images, "Pricing")?.name).toBe("pricing");
    expect(findByName(images, "pricing")?.name).toBe("pricing");
    expect(findByName(images, "pric")).toBeUndefined();
  });

  it("sorts names by code point", () => {
    expect(["b", "a", "B", "\u{1F600}", "\uFF5E"].sort(compareCodePoints)).toEqual([
      "B",
      "a",
      "b",
      "\uFF5E",
      "\u{1F600}",
    ]);
  });
});

describe("a VM runs an image", () => {
  it("when its command line names the image's file, bounded", () => {
    const image = "/x/images/pricing/pricing.image";

    expect(commandLineNamesFile(`/vm/Pharo ${image}`, image, "linux")).toBe(true);
    expect(commandLineNamesFile(`/vm/Pharo "${image}" eval x`, image, "linux")).toBe(true);
    expect(commandLineNamesFile(`/vm/Pharo '${image}'`, image, "linux")).toBe(true);
    expect(commandLineNamesFile(`${image} --headless`, image, "linux")).toBe(true);
    expect(
      commandLineNamesFile("/vm/Pharo /x/images/pricing/pricing.image.bak", image, "linux"),
    ).toBe(false);
    expect(
      commandLineNamesFile("/vm/Pharo /y/x/images/pricing/pricing.image", image, "linux"),
    ).toBe(false);
    expect(
      whereCommandLineNamesFile(`/vm/Pharo /y${image} ${image}`, image, "linux"),
    ).toBe(`/vm/Pharo /y${image} `.length);
  });

  it("on Windows, whatever the case and the slashes", () => {
    expect(
      commandLineNamesFile(
        '"C:\\Pharo\\Pharo.exe" "c:/users/ada/documents/pharo/images/MCP13/mcp13.IMAGE"',
        "C:\\Users\\Ada\\Documents\\Pharo\\images\\MCP13\\MCP13.image",
        "win32",
      ),
    ).toBe(true);
    expect(
      commandLineNamesFile(
        "/vm/Pharo /x/images/MCP13/mcp13.image",
        "/x/images/MCP13/MCP13.image",
        "linux",
      ),
    ).toBe(false);
  });

  it("whose name holds a space, which ps prints unquoted", () => {
    const imagesDir = temp("pharo-launcher-mcp-images-");
    const imagePath = writeImage(imagesDir, "MCP debug");
    const { images } = scanImages(imagesDir);

    const running = processesOfImages(
      images,
      [vmProcess(123, `/x/vms/130-x64/Pharo.app/Contents/MacOS/Pharo ${imagePath}`)],
      "darwin",
    );

    expect(running).toEqual([
      {
        pid: 123,
        commandLine: `/x/vms/130-x64/Pharo.app/Contents/MacOS/Pharo ${imagePath}`,
        imagePath,
        imageName: "MCP debug",
      },
    ]);
  });

  // The whole path is matched, not the name: `<images>/pricing/pricing.image`
  // is no part of `<images>/pricing-2025/pricing-2025.image`.
  it("only when it is that image, not one whose name starts the same", () => {
    const imagesDir = temp("pharo-launcher-mcp-images-");
    writeImage(imagesDir, "pricing");
    const other = writeImage(imagesDir, "pricing-2025");
    const { images } = scanImages(imagesDir);

    const running = processesOfImages(
      images,
      [vmProcess(7, `/vm/Pharo --headless ${other}`)],
      "linux",
    );

    expect(running.map((vm) => [vm.pid, vm.imageName])).toEqual([[7, "pricing-2025"]]);
  });

  // A VM's own image comes before its script and the script's arguments.
  it("as the first image its command line names, not one a later argument names", () => {
    const imagesDir = temp("pharo-launcher-mcp-images-");
    const alpha = writeImage(imagesDir, "alpha");
    const zeta = writeImage(imagesDir, "zeta");
    const { images } = scanImages(imagesDir);

    const running = processesOfImages(
      images,
      [
        vmProcess(7, `/vms/140-x64/Pharo --headless ${zeta} eval Smalltalk at: #X put: '${alpha}'`),
        vmProcess(8, `/vms/140-x64/Pharo --headless ${alpha} eval ${zeta}`),
      ],
      "linux",
    );

    expect(running.map((vm) => [vm.pid, vm.imageName, vm.imagePath])).toEqual([
      [8, "alpha", alpha],
      [7, "zeta", zeta],
    ]);
  });

  it("when it names the real path of an images directory given through a link", () => {
    const real = temp("pharo-launcher-mcp-images-");
    const linkParent = temp("pharo-launcher-mcp-link-");
    const linked = path.join(linkParent, "images");
    fs.symlinkSync(real, linked, "junction");
    writeImage(real, "stuck");
    const { images } = scanImages(linked);
    const realImage = path.join(fs.realpathSync.native(real), "stuck", "stuck.image");

    const running = processesOfImages(
      images,
      [vmProcess(9, `/vm/Pharo ${realImage}`)],
      process.platform,
    );

    expect(running).toMatchObject([
      { pid: 9, imageName: "stuck", imagePath: path.join(linked, "stuck", "stuck.image") },
    ]);
  });
});
