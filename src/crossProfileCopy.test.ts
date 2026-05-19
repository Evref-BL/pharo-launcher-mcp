import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  copyImageBetweenProfiles,
  resolveScopedProfileInput,
} from "./crossProfileCopy.js";

function tempProfileRoot(name: string): string {
  return fs.mkdtempSync(
    path.join(os.tmpdir(), `pharo-launcher-mcp-${name}-profile-`),
  );
}

function removeProfileRoot(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

function imageDirectory(profileRoot: string, imageName: string): string {
  return path.join(profileRoot, "images", imageName);
}

function writeImage(profileRoot: string, imageName: string): string {
  const directory = imageDirectory(profileRoot, imageName);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${imageName}.image`), "");
  fs.writeFileSync(path.join(directory, `${imageName}.changes`), "");
  fs.writeFileSync(
    path.join(directory, "meta-inf.ston"),
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
  it("derives a complete explicit profile from a scoped state root", () => {
    const stateRoot = tempProfileRoot("source");
    try {
      const profile = resolveScopedProfileInput(
        { stateRoot, profileName: "cache" },
        "sourceProfile",
      );

      expect(profile).toMatchObject({
        profileName: "cache",
        stateRoot,
        launcherConfiguration: path.join(
          stateRoot,
          "launcher",
          "pharo-launcher-cli-config.ston",
        ),
        imagesDir: path.join(stateRoot, "images"),
        vmsDir: path.join(stateRoot, "vms"),
        templateSourcesDir: path.join(stateRoot, "templates"),
        initScriptsDir: path.join(stateRoot, "init-scripts"),
        logsDir: path.join(stateRoot, "logs"),
        environment: {
          PHARO_LAUNCHER_MCP_PROFILE: "cache",
          PHARO_LAUNCHER_MCP_STATE_ROOT: stateRoot,
          PHARO_LAUNCHER_MCP_IMAGES_DIR: path.join(stateRoot, "images"),
        },
      });
    } finally {
      removeProfileRoot(stateRoot);
    }
  });

  it("rejects ambiguous profile input without scoped roots", () => {
    expect(() =>
      resolveScopedProfileInput({ profileName: "default" }, "sourceProfile"),
    ).toThrow(
      "sourceProfile must include stateRoot or explicit launcherConfiguration",
    );
  });

  it("accepts a complete explicit profile path set without a state root", () => {
    const root = tempProfileRoot("explicit");
    try {
      const profile = resolveScopedProfileInput(
        {
          profileName: "explicit-profile",
          launcherConfiguration: path.join(root, "launcher", "config.ston"),
          imagesDir: path.join(root, "image-store"),
          vmsDir: path.join(root, "vm-store"),
          templateSourcesDir: path.join(root, "template-store"),
          initScriptsDir: path.join(root, "script-store"),
          logsDir: path.join(root, "log-store"),
        },
        "destinationProfile",
      );

      expect(profile).toMatchObject({
        profileName: "explicit-profile",
        imagesDir: path.join(root, "image-store"),
        environment: {
          PHARO_LAUNCHER_MCP_IMAGES_DIR: path.join(root, "image-store"),
          PHARO_LAUNCHER_MCP_LAUNCHER_CONFIGURATION: path.join(
            root,
            "launcher",
            "config.ston",
          ),
        },
      });
      expect(profile.stateRoot).toBeUndefined();
    } finally {
      removeProfileRoot(root);
    }
  });

  it("rejects relative profile paths", () => {
    expect(() =>
      resolveScopedProfileInput(
        { stateRoot: "relative-profile" },
        "destinationProfile",
      ),
    ).toThrow("destinationProfile.stateRoot must be an absolute path");
  });

  it("rejects launcher configuration paths outside a scoped state root", () => {
    const stateRoot = tempProfileRoot("state");
    const otherRoot = tempProfileRoot("other");
    try {
      expect(() =>
        resolveScopedProfileInput(
          {
            stateRoot,
            launcherConfiguration: path.join(otherRoot, "config.ston"),
          },
          "sourceProfile",
        ),
      ).toThrow("sourceProfile.launcherConfiguration must be inside");
    } finally {
      removeProfileRoot(stateRoot);
      removeProfileRoot(otherRoot);
    }
  });

  it("copies an image directory between explicit profiles and repairs metadata", () => {
    const sourceRoot = tempProfileRoot("source");
    const destinationRoot = tempProfileRoot("destination");
    try {
      writeImage(sourceRoot, "Base");

      const result = copyImageBetweenProfiles({
        sourceProfile: { stateRoot: sourceRoot, profileName: "cache" },
        destinationProfile: {
          stateRoot: destinationRoot,
          profileName: "runtime",
        },
        sourceImageName: "Base",
        destinationImageName: "Task",
      });
      const destinationDirectory = imageDirectory(destinationRoot, "Task");

      expect(result).toMatchObject({
        ok: true,
        operation: "copy_between_profiles",
        sourceImageName: "Base",
        destinationImageName: "Task",
        sourceProfile: {
          profileName: "cache",
          stateRoot: sourceRoot,
          imagesDir: path.join(sourceRoot, "images"),
        },
        destinationProfile: {
          profileName: "runtime",
          stateRoot: destinationRoot,
          imagesDir: path.join(destinationRoot, "images"),
        },
        sourceImage: {
          imageName: "Base",
          imageFile: {
            exists: true,
            kind: "file",
          },
          metadataFile: {
            exists: true,
            kind: "file",
          },
        },
        destinationImage: {
          imageName: "Task",
          directory: destinationDirectory,
          imageFile: {
            exists: true,
            kind: "file",
          },
          metadataFile: {
            exists: true,
            kind: "file",
          },
        },
        metadataRepair: {
          status: "repaired",
        },
        verification: {
          ok: true,
          destinationDirectoryExists: true,
          destinationImageFileExists: true,
          destinationMetadataFileExists: true,
          destinationMetadataReferencesDestination: true,
          sourceMetadataReferenceAbsent: true,
          sourceBasenameImageFileAbsent: true,
        },
      });
      expect(fs.existsSync(path.join(destinationDirectory, "Task.image"))).toBe(
        true,
      );
      expect(fs.existsSync(path.join(destinationDirectory, "Task.changes"))).toBe(
        true,
      );
      expect(fs.existsSync(path.join(destinationDirectory, "Base.image"))).toBe(
        false,
      );
      expect(
        fs.readFileSync(path.join(destinationDirectory, "meta-inf.ston"), "utf8"),
      ).toContain("RelativePath [ 'Task', 'Task.image' ]");
      expect(result.touchedPaths.copiedDirectories[0]).toMatchObject({
        from: imageDirectory(sourceRoot, "Base"),
      });
      expect(result.cleanup.destinationImageDirectory).toBe(destinationDirectory);
    } finally {
      removeProfileRoot(sourceRoot);
      removeProfileRoot(destinationRoot);
    }
  });

  it("fails before mutation when the source image is missing", () => {
    const sourceRoot = tempProfileRoot("source");
    const destinationRoot = tempProfileRoot("destination");
    try {
      const result = copyImageBetweenProfiles({
        sourceProfile: { stateRoot: sourceRoot },
        destinationProfile: { stateRoot: destinationRoot },
        sourceImageName: "Missing",
        destinationImageName: "Task",
      });

      expect(result).toMatchObject({
        ok: false,
        diagnostic: "Source image directory is missing.",
      });
      expect(fs.existsSync(imageDirectory(destinationRoot, "Task"))).toBe(false);
    } finally {
      removeProfileRoot(sourceRoot);
      removeProfileRoot(destinationRoot);
    }
  });

  it("fails before mutation when the destination image already exists", () => {
    const sourceRoot = tempProfileRoot("source");
    const destinationRoot = tempProfileRoot("destination");
    try {
      writeImage(sourceRoot, "Base");
      writeImage(destinationRoot, "Task");

      const result = copyImageBetweenProfiles({
        sourceProfile: { stateRoot: sourceRoot },
        destinationProfile: { stateRoot: destinationRoot },
        sourceImageName: "Base",
        destinationImageName: "Task",
      });

      expect(result).toMatchObject({
        ok: false,
        diagnostic: "Destination image already exists.",
        action:
          "Choose a different destinationImageName or delete the existing destination image with the destination profile active.",
        touchedPaths: {
          copiedDirectories: [],
        },
      });
    } finally {
      removeProfileRoot(sourceRoot);
      removeProfileRoot(destinationRoot);
    }
  });

  it("cleans the temporary copy when destination metadata verification fails", () => {
    const sourceRoot = tempProfileRoot("source");
    const destinationRoot = tempProfileRoot("destination");
    try {
      const sourceDirectory = imageDirectory(sourceRoot, "Base");
      fs.mkdirSync(sourceDirectory, { recursive: true });
      fs.writeFileSync(path.join(sourceDirectory, "Base.image"), "");
      fs.writeFileSync(path.join(sourceDirectory, "meta-inf.ston"), "PhLImage {}");

      const result = copyImageBetweenProfiles({
        sourceProfile: { stateRoot: sourceRoot },
        destinationProfile: { stateRoot: destinationRoot },
        sourceImageName: "Base",
        destinationImageName: "Task",
      });

      expect(result).toMatchObject({
        ok: false,
        diagnostic: expect.stringContaining(
          "Copied image verification failed",
        ),
        metadataRepair: {
          status: "unchanged",
        },
        verification: {
          ok: false,
          destinationMetadataReferencesDestination: false,
        },
      });
      expect(fs.existsSync(imageDirectory(destinationRoot, "Task"))).toBe(false);
      expect(result.touchedPaths.removedTemporaryPaths).toHaveLength(1);
      expect(fs.existsSync(result.touchedPaths.removedTemporaryPaths[0] ?? "")).toBe(
        false,
      );
    } finally {
      removeProfileRoot(sourceRoot);
      removeProfileRoot(destinationRoot);
    }
  });
});
