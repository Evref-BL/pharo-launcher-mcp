import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PharoLauncherConfig } from "./config.js";
import { repairCopiedImageMetadata } from "./imageMetadata.js";

function profileConfig(stateRoot: string): PharoLauncherConfig {
  return {
    launcherDir: "C:\\PL",
    launcherVm: "C:\\PL\\PharoConsole.exe",
    installationLauncherImage: "C:\\PL\\PharoLauncher.image",
    launcherImage: path.join(stateRoot, "launcher", "PharoLauncher.image"),
    launcherConfiguration: path.join(
      stateRoot,
      "launcher",
      "pharo-launcher-cli-config.ston",
    ),
    profile: {
      name: "isolated",
      stateRoot,
      launcherImage: path.join(stateRoot, "launcher", "PharoLauncher.image"),
      imagesDir: path.join(stateRoot, "images"),
      vmsDir: path.join(stateRoot, "vms"),
      templateSourcesDir: path.join(stateRoot, "templates"),
      initScriptsDir: path.join(stateRoot, "init-scripts"),
      logsDir: path.join(stateRoot, "logs"),
    },
  };
}

describe("repairCopiedImageMetadata", () => {
  it("updates copied Pharo Launcher metadata to the target image file", () => {
    const stateRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pharo-launcher-mcp-profile-"),
    );
    const config = profileConfig(stateRoot);
    const targetDirectory = path.join(
      config.profile!.imagesDir,
      "PlexusSmokeTarget",
    );
    fs.mkdirSync(targetDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(targetDirectory, "PlexusSmokeTarget.image"),
      "",
    );
    const metaInfPath = path.join(targetDirectory, "meta-inf.ston");
    fs.writeFileSync(
      metaInfPath,
      [
        "PhLImage {",
        "\t#vmManager : PhLVirtualMachineManager {",
        "\t\t#imageFile : FileLocator {",
        "\t\t\t#path : RelativePath [ 'MCP12-2', 'MCP12-2.image' ],",
        "\t\t\t#origin : #launcherImagesLocation",
        "\t\t}",
        "\t}",
        "}",
        "",
      ].join("\n"),
    );

    expect(
      repairCopiedImageMetadata(config, "MCP12-2", "PlexusSmokeTarget"),
    ).toMatchObject({ status: "repaired", metaInfPath });
    expect(fs.readFileSync(metaInfPath, "utf8")).toContain(
      "RelativePath [ 'PlexusSmokeTarget', 'PlexusSmokeTarget.image' ]",
    );

    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  it("does not rewrite metadata when no profile is active", () => {
    const result = repairCopiedImageMetadata(
      {
        launcherDir: "C:\\PL",
        launcherVm: "C:\\PL\\PharoConsole.exe",
        installationLauncherImage: "C:\\PL\\PharoLauncher.image",
        launcherImage: "C:\\PL\\PharoLauncher.image",
      },
      "Source",
      "Target",
    );

    expect(result).toMatchObject({ status: "skipped" });
  });
});
