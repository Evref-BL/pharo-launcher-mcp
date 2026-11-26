import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  copyImageBetweenProfiles,
  resolveProfileLocation,
} from "./crossProfileCopy.js";

/** A profile's state root, with the images/ directory every profile has. */
function tempProfileRoot(name: string): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), `pharo-launcher-mcp-${name}-profile-`),
  );
  fs.mkdirSync(path.join(root, "images"));
  return root;
}

function removeProfileRoot(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

function imageDirectory(profileRoot: string, imageName: string): string {
  return path.join(profileRoot, "images", imageName);
}

function writeImage(
  profileRoot: string,
  imageName: string,
  metadata?: string,
): string {
  const directory = imageDirectory(profileRoot, imageName);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${imageName}.image`), "");
  fs.writeFileSync(path.join(directory, `${imageName}.changes`), "");
  fs.writeFileSync(
    path.join(directory, "meta-inf.ston"),
    metadata ??
      [
        "PhLImage {",
        "\t#vmManager : PhLVirtualMachineManager {",
        "\t\t#imageFile : FileLocator {",
        `\t\t\t#path : RelativePath [ '${imageName}', '${imageName}.image' ],`,
        "\t\t\t#origin : #launcherImagesLocation",
        "\t\t}",
        "\t}",
        "}",
        "",
      ].join("\n"),
  );
  return directory;
}

describe("cross-profile image copy", () => {
  it("reads a profile from its stateRoot, or its images directory", () => {
    expect(resolveProfileLocation({ stateRoot: "/p/cache" }, "sourceProfile")).toEqual({
      stateRoot: path.resolve("/p/cache"),
      imagesDir: path.join(path.resolve("/p/cache"), "images"),
    });
    expect(resolveProfileLocation({ imagesDir: "/u/Pharo/images" }, "sourceProfile")).toEqual({
      imagesDir: path.resolve("/u/Pharo/images"),
    });
  });

  it.each([
    [{}, "sourceProfile takes stateRoot or imagesDir, one of the two"],
    [{ stateRoot: "/a", imagesDir: "/b" }, "sourceProfile takes stateRoot or imagesDir, one of the two"],
    [{ stateRoot: "/a", vmsDir: "/v" }, "sourceProfile takes stateRoot or imagesDir, not vmsDir"],
    [{ stateRoot: "relative" }, "sourceProfile.stateRoot must be an absolute path"],
  ])("refuses the profile %j", (profile, message) => {
    expect(() => resolveProfileLocation(profile, "sourceProfile")).toThrow(message);
  });

  it("copies an image between profiles, renamed, and repairs its metadata", async () => {
    const sourceRoot = tempProfileRoot("source");
    const destinationRoot = tempProfileRoot("destination");
    try {
      writeImage(sourceRoot, "Base");

      const result = await copyImageBetweenProfiles({
        sourceProfile: { stateRoot: sourceRoot },
        destinationProfile: { stateRoot: destinationRoot },
        image: "Base",
        newImage: "Task",
      });
      const destinationDirectory = imageDirectory(destinationRoot, "Task");

      expect(result).toEqual({
        ok: true,
        image: "Base",
        newImage: "Task",
        sourceProfile: { stateRoot: sourceRoot, imagesDir: path.join(sourceRoot, "images") },
        destinationProfile: {
          stateRoot: destinationRoot,
          imagesDir: path.join(destinationRoot, "images"),
        },
        source: imageDirectory(sourceRoot, "Base"),
        destination: {
          directory: destinationDirectory,
          imagePath: path.join(destinationDirectory, "Task.image"),
        },
      });
      expect(fs.existsSync(path.join(destinationDirectory, "Task.image"))).toBe(true);
      expect(fs.existsSync(path.join(destinationDirectory, "Task.changes"))).toBe(true);
      expect(fs.existsSync(path.join(destinationDirectory, "Base.image"))).toBe(false);
      expect(fs.readFileSync(path.join(destinationDirectory, "meta-inf.ston"), "utf8")).toContain(
        "RelativePath [ 'Task', 'Task.image' ]",
      );
    } finally {
      removeProfileRoot(sourceRoot);
      removeProfileRoot(destinationRoot);
    }
  });

  it("copies from an images directory given as it is", async () => {
    const sourceRoot = tempProfileRoot("user");
    const destinationRoot = tempProfileRoot("destination");
    try {
      writeImage(sourceRoot, "Mine");

      const result = await copyImageBetweenProfiles({
        sourceProfile: { imagesDir: path.join(sourceRoot, "images") },
        destinationProfile: { stateRoot: destinationRoot },
        image: "Mine",
        newImage: "Mine",
      });

      expect(result.ok).toBe(true);
      expect(fs.existsSync(path.join(imageDirectory(destinationRoot, "Mine"), "Mine.image"))).toBe(true);
    } finally {
      removeProfileRoot(sourceRoot);
      removeProfileRoot(destinationRoot);
    }
  });

  it("refuses an input that is not an object, with a rejected promise", async () => {
    await expect(copyImageBetweenProfiles(undefined)).rejects.toThrow("arguments must be an object");
  });

  it("accepts launcher metadata without an image FileLocator during cross-profile copy", async () => {
    const sourceRoot = tempProfileRoot("source");
    const destinationRoot = tempProfileRoot("destination");
    try {
      writeImage(
        sourceRoot,
        "HomeCache-d58cf946b1bd39a08c35c3ca",
        [
          "PhLImage {",
          "\t#originTemplate : PhLRemoteTemplate {",
          "\t\t#name : 'Pharo 13.0 - 64bit (stable)',",
          "\t\t#url : URL [ 'https://files.pharo.org/image/130/latest-64.zip' ]",
          "\t},",
          "\t#launchConfigurations : OrderedCollection [ ],",
          "\t#shouldRunInitializationScript : true",
          "}",
          "",
        ].join("\n"),
      );

      const result = await copyImageBetweenProfiles({
        sourceProfile: { stateRoot: sourceRoot },
        destinationProfile: { stateRoot: destinationRoot },
        image: "HomeCache-d58cf946b1bd39a08c35c3ca",
        newImage: "MCPPharo-dev-nexus-mcp-pharo-dev",
      });
      const destinationDirectory = imageDirectory(
        destinationRoot,
        "MCPPharo-dev-nexus-mcp-pharo-dev",
      );

      expect(result.ok).toBe(true);
      expect(
        fs.existsSync(
          path.join(destinationDirectory, "MCPPharo-dev-nexus-mcp-pharo-dev.image"),
        ),
      ).toBe(true);
      expect(
        fs.existsSync(
          path.join(
            destinationDirectory,
            "HomeCache-d58cf946b1bd39a08c35c3ca.image",
          ),
        ),
      ).toBe(false);
      const destinationMetadata = fs.readFileSync(
        path.join(destinationDirectory, "meta-inf.ston"),
        "utf8",
      );
      expect(destinationMetadata).toContain("#originTemplate");
      expect(destinationMetadata).not.toContain("RelativePath");
    } finally {
      removeProfileRoot(sourceRoot);
      removeProfileRoot(destinationRoot);
    }
  });

  it("repairs prefixed temp FileLocator metadata during cross-profile copy", async () => {
    const sourceRoot = tempProfileRoot("source");
    const destinationRoot = tempProfileRoot("destination");
    try {
      writeImage(
        sourceRoot,
        "Base",
        [
          "PhLImage {",
          "\t#vmManager : PhLVirtualMachineManager {",
          "\t\t#imageFile : FileLocator {",
          "\t\t\t#path : RelativePath [ 'home-cache-run', 'home', 'profiles', 'pharo-launcher-mcp', 'image-cache', 'images', 'Base', 'Base.image' ],",
          "\t\t\t#origin : #temp",
          "\t\t}",
          "\t}",
          "}",
          "",
        ].join("\n"),
      );

      const result = await copyImageBetweenProfiles({
        sourceProfile: { stateRoot: sourceRoot },
        destinationProfile: { stateRoot: destinationRoot },
        image: "Base",
        newImage: "Task",
      });
      const destinationDirectory = imageDirectory(destinationRoot, "Task");

      expect(result.ok).toBe(true);
      const repaired = fs.readFileSync(
        path.join(destinationDirectory, "meta-inf.ston"),
        "utf8",
      );
      expect(repaired).toContain("RelativePath [ 'Task', 'Task.image' ]");
      expect(repaired).toContain("#origin : #launcherImagesLocation");
      expect(repaired).not.toContain("home-cache-run");
      expect(repaired).not.toContain("Base.image");
    } finally {
      removeProfileRoot(sourceRoot);
      removeProfileRoot(destinationRoot);
    }
  });

  it("rejects copied metadata that still references a prefixed source image path", async () => {
    const sourceRoot = tempProfileRoot("source");
    const destinationRoot = tempProfileRoot("destination");
    try {
      writeImage(
        sourceRoot,
        "Base",
        [
          "PhLImage {",
          "\t#vmManager : PhLVirtualMachineManager {",
          "\t\t#imageFile : FileLocator {",
          "\t\t\t#path : RelativePath [ 'Task', 'Task.image' ],",
          "\t\t\t#origin : #launcherImagesLocation",
          "\t\t}",
          "\t}",
          "\t#staleReference : RelativePath [ 'tmp-root', 'images', 'Base', 'Base.image' ]",
          "}",
          "",
        ].join("\n"),
      );

      const result = await copyImageBetweenProfiles({
        sourceProfile: { stateRoot: sourceRoot },
        destinationProfile: { stateRoot: destinationRoot },
        image: "Base",
        newImage: "Task",
      });

      expect(result).toMatchObject({
        ok: false,
        failure: "preflight",
        diagnostic: "its meta-inf.ston still names Base.image",
      });
      expect(fs.existsSync(imageDirectory(destinationRoot, "Task"))).toBe(false);
    } finally {
      removeProfileRoot(sourceRoot);
      removeProfileRoot(destinationRoot);
    }
  });

  it("fails before copying when the source image is missing", async () => {
    const sourceRoot = tempProfileRoot("source");
    const destinationRoot = tempProfileRoot("destination");
    try {
      const result = await copyImageBetweenProfiles({
        sourceProfile: { stateRoot: sourceRoot },
        destinationProfile: { stateRoot: destinationRoot },
        image: "Missing",
        newImage: "Task",
      });

      expect(result).toMatchObject({
        ok: false,
        failure: "source-missing",
        diagnostic: `${imageDirectory(sourceRoot, "Missing")} does not exist`,
      });
      expect(fs.existsSync(imageDirectory(destinationRoot, "Task"))).toBe(false);
    } finally {
      removeProfileRoot(sourceRoot);
      removeProfileRoot(destinationRoot);
    }
  });

  it("never replaces an image the destination has", async () => {
    const sourceRoot = tempProfileRoot("source");
    const destinationRoot = tempProfileRoot("destination");
    try {
      writeImage(sourceRoot, "Base");
      writeImage(destinationRoot, "Task");

      const result = await copyImageBetweenProfiles({
        sourceProfile: { stateRoot: sourceRoot },
        destinationProfile: { stateRoot: destinationRoot },
        image: "Base",
        newImage: "Task",
      });

      expect(result).toMatchObject({
        ok: false,
        failure: "destination-exists",
        diagnostic: `${imageDirectory(destinationRoot, "Task")} already exists, and a copy never replaces it`,
        action: "Copy under another newImage, or remove that directory first.",
      });
    } finally {
      removeProfileRoot(sourceRoot);
      removeProfileRoot(destinationRoot);
    }
  });

  it("removes the temporary copy when it does not check out", async () => {
    const sourceRoot = tempProfileRoot("source");
    const destinationRoot = tempProfileRoot("destination");
    try {
      const sourceDirectory = imageDirectory(sourceRoot, "Base");
      fs.mkdirSync(sourceDirectory, { recursive: true });
      fs.writeFileSync(path.join(sourceDirectory, "Base.image"), "");
      fs.writeFileSync(path.join(sourceDirectory, "meta-inf.ston"), "PhLImage {}");

      const result = await copyImageBetweenProfiles({
        sourceProfile: { stateRoot: sourceRoot },
        destinationProfile: { stateRoot: destinationRoot },
        image: "Base",
        newImage: "Task",
      });

      expect(result).toMatchObject({
        ok: false,
        failure: "preflight",
        diagnostic: "its meta-inf.ston does not name Task.image",
      });
      expect(fs.readdirSync(path.join(destinationRoot, "images"))).toEqual([]);
    } finally {
      removeProfileRoot(sourceRoot);
      removeProfileRoot(destinationRoot);
    }
  });

  it.each([
    ["source-image-missing", "Base.image"],
    ["source-metadata-missing", "meta-inf.ston"],
  ])("says %s when the source lacks %s", async (failure, missing) => {
    const sourceRoot = tempProfileRoot("source");
    const destinationRoot = tempProfileRoot("destination");
    try {
      fs.rmSync(path.join(writeImage(sourceRoot, "Base"), missing));

      const result = await copyImageBetweenProfiles({
        sourceProfile: { stateRoot: sourceRoot },
        destinationProfile: { stateRoot: destinationRoot },
        image: "Base",
        newImage: "Base",
      });

      expect(result).toMatchObject({ ok: false, failure });
    } finally {
      removeProfileRoot(sourceRoot);
      removeProfileRoot(destinationRoot);
    }
  });

  it("says a copy that threw is an exception", async () => {
    const sourceRoot = tempProfileRoot("source");
    const destinationRoot = tempProfileRoot("destination");
    const destinationImages = path.join(destinationRoot, "not-a-directory");
    try {
      writeImage(sourceRoot, "Base");
      fs.writeFileSync(destinationImages, "");

      const result = await copyImageBetweenProfiles({
        sourceProfile: { stateRoot: sourceRoot },
        destinationProfile: { imagesDir: destinationImages },
        image: "Base",
        newImage: "Task",
      });

      expect(result).toMatchObject({ ok: false, failure: "exception" });
      expect(result.diagnostic).toBeDefined();
    } finally {
      removeProfileRoot(sourceRoot);
      removeProfileRoot(destinationRoot);
    }
  });

  it("refuses a stateRoot that does not exist, and creates nothing", async () => {
    const sourceRoot = tempProfileRoot("source");
    const parent = tempProfileRoot("parent");
    const destinationRoot = path.join(parent, "team");
    try {
      writeImage(sourceRoot, "Base");

      const result = await copyImageBetweenProfiles({
        sourceProfile: { stateRoot: sourceRoot },
        destinationProfile: { stateRoot: destinationRoot },
        image: "Base",
        newImage: "Base",
      });

      expect(result).toMatchObject({
        ok: false,
        failure: "profile-path-missing",
        missingProfilePaths: [
          { profile: "destinationProfile", field: "stateRoot", path: destinationRoot, given: true },
        ],
        diagnostic: `destinationProfile.stateRoot ${destinationRoot} does not exist.`,
      });
      expect(fs.existsSync(destinationRoot)).toBe(false);
    } finally {
      removeProfileRoot(sourceRoot);
      removeProfileRoot(parent);
    }
  });

  it("refuses a stateRoot that holds no images/ directory, and creates none", async () => {
    // The directory that holds the profiles, given as one of them.
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-launcher-mcp-profiles-"));
    const sourceRoot = path.join(parent, "profile");
    try {
      writeImage(sourceRoot, "Base");

      const result = await copyImageBetweenProfiles({
        sourceProfile: { stateRoot: sourceRoot },
        destinationProfile: { stateRoot: parent },
        image: "Base",
        newImage: "Base",
      });

      expect(result).toMatchObject({
        ok: false,
        failure: "profile-path-missing",
        missingProfilePaths: [
          {
            profile: "destinationProfile",
            field: "imagesDir",
            path: path.join(parent, "images"),
            given: false,
          },
        ],
        diagnostic: `destinationProfile.stateRoot ${parent} holds no images/ directory.`,
      });
      expect(fs.existsSync(path.join(parent, "images"))).toBe(false);
    } finally {
      removeProfileRoot(parent);
    }
  });

  it("refuses an images directory that does not exist", async () => {
    const sourceRoot = tempProfileRoot("source");
    const missing = path.join(sourceRoot, "nowhere");
    try {
      writeImage(sourceRoot, "Base");

      const result = await copyImageBetweenProfiles({
        sourceProfile: { stateRoot: sourceRoot },
        destinationProfile: { imagesDir: missing },
        image: "Base",
        newImage: "Base",
      });

      expect(result).toMatchObject({
        ok: false,
        failure: "profile-path-missing",
        diagnostic: `destinationProfile.imagesDir ${missing} does not exist.`,
      });
    } finally {
      removeProfileRoot(sourceRoot);
    }
  });
});
