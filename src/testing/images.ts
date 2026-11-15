/**
 * Images directories for tests, laid out as Pharo Launcher leaves them. Not
 * built into the package.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PharoLauncherConfig, PharoLauncherProfileConfig } from "../config.js";
import type { LauncherProcess } from "../models.js";
import type { NativeProcessCommandRunner } from "../processTools.js";

export function tempDirectory(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** The format numbers an image header starts with, little-endian. */
export const imageFormat64 = 68021;

export interface ImageFixture {
  /** meta-inf.ston, as written; none when left out. */
  metaInf?: string;
  /** pharo.version, as written; none when left out. */
  pharoVersion?: string;
  /** The header's format number; 68021 when left out. */
  format?: number;
  image?: boolean;
  changes?: boolean;
}

/** Writes `<imagesDir>/<name>` holding what the fixture says; its image path. */
export function writeImage(
  imagesDir: string,
  name: string,
  fixture: ImageFixture = {},
): string {
  const directory = path.join(imagesDir, name);
  const imagePath = path.join(directory, `${name}.image`);
  fs.mkdirSync(directory, { recursive: true });
  if (fixture.image !== false) {
    const header = Buffer.alloc(16);
    header.writeUInt32LE(fixture.format ?? imageFormat64, 0);
    fs.writeFileSync(imagePath, header);
  }
  if (fixture.changes !== false) {
    fs.writeFileSync(path.join(directory, `${name}.changes`), "");
  }
  if (fixture.metaInf !== undefined) {
    fs.writeFileSync(path.join(directory, "meta-inf.ston"), fixture.metaInf);
  }
  if (fixture.pharoVersion !== undefined) {
    fs.writeFileSync(path.join(directory, "pharo.version"), fixture.pharoVersion);
  }

  return imagePath;
}

function stonString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** meta-inf.ston as `image create` writes it: the template alone. */
export function cliMetaInf(templateName: string, url: string): string {
  return [
    "PhLImage {",
    "\t#originTemplate : PhLRemoteTemplate {",
    `\t\t#name : ${stonString(templateName)},`,
    `\t\t#url : URL [ ${stonString(url)} ]`,
    "\t},",
    "\t#launchConfigurations : OrderedCollection [ ],",
    "\t#shouldRunInitializationScript : true",
    "}",
  ].join("\n");
}

/** meta-inf.ston as the GUI leaves it once it launched the image. */
export function guiMetaInf(options: {
  imageName: string;
  pharoVersion: string;
  architecture: string;
  templateName: string;
  url: string;
  vmId: string;
}): string {
  return [
    "PhLImage {",
    "\t#formatNumber : 68021,",
    `\t#architecture : ${stonString(options.architecture)},`,
    `\t#pharoVersion : ${stonString(options.pharoVersion)},`,
    "\t#originTemplate : PhLRemoteTemplate {",
    `\t\t#name : ${stonString(options.templateName)},`,
    `\t\t#url : URL [ ${stonString(options.url)} ]`,
    "\t},",
    "\t#vmManager : PhLVirtualMachineManager {",
    "\t\t#imageFile : FileLocator {",
    `\t\t\t#path : RelativePath [ ${stonString(options.imageName)}, ${stonString(`${options.imageName}.image`)} ],`,
    "\t\t\t#origin : #launcherImagesLocation",
    "\t\t},",
    "\t\t#imageFormatNumber : 68021,",
    `\t\t#imageVersion : ${stonString(options.pharoVersion)}`,
    "\t},",
    "\t#launchConfigurations : OrderedCollection [",
    "\t\tPhLLaunchConfiguration {",
    "\t\t\t#image : @1,",
    "\t\t\t#name : 'Default',",
    "\t\t\t#imageArguments : OrderedCollection [ ],",
    "\t\t\t#vm : PhLVirtualMachine {",
    "\t\t\t\t#manager : @4,",
    "\t\t\t\t#flavour : '',",
    `\t\t\t\t#id : ${stonString(options.vmId)},`,
    "\t\t\t\t#blessing : 'stable'",
    "\t\t\t}",
    "\t\t}",
    "\t],",
    "\t#shouldRunInitializationScript : false",
    "}",
  ].join("\n");
}

/** A profile under a temporary state root, its images directory made. */
export function tempProfile(prefix = "pharo-launcher-mcp-profile-"): PharoLauncherProfileConfig {
  const stateRoot = tempDirectory(prefix);
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
  fs.mkdirSync(profile.imagesDir, { recursive: true });
  return profile;
}

/** A config naming no real installation, in a profile or with user files of its own. */
export function testConfig(
  scope: { profile: PharoLauncherProfileConfig } | { userFilesDir: string },
): PharoLauncherConfig {
  const launcherDir = path.join(os.tmpdir(), "no-pharo-launcher");
  return {
    launcherDir,
    launcherVm: path.join(launcherDir, "pharo"),
    installationLauncherImage: path.join(launcherDir, "PharoLauncher.image"),
    ...("profile" in scope
      ? {
          profile: scope.profile,
          launcherImage: scope.profile.launcherImage,
          launcherConfiguration: path.join(
            scope.profile.stateRoot,
            "launcher",
            "pharo-launcher-cli-config.ston",
          ),
        }
      : {
          launcherImage: path.join(launcherDir, "PharoLauncher.image"),
          launcherUserFilesDir: scope.userFilesDir,
        }),
  };
}

/** A `ps -axo pid=,args=` that prints these lines, and only answers `ps`. */
export function psRunner(lines: readonly string[]): NativeProcessCommandRunner {
  return async (command) => {
    if (command !== "ps") {
      throw new Error(`unexpected process command ${command}`);
    }
    return lines.join("\n");
  };
}

/** The pids of these processes, in their order. */
export function pids(processes: readonly LauncherProcess[] | undefined): number[] {
  return (processes ?? []).map((process) => process.pid);
}
