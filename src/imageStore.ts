/**
 * This Launcher's images, read from its images directory by the Launcher's own
 * rule, with no Launcher call.
 *
 * The Launcher never writes an image's file into its STON
 * (`PhLImage class>>stonAllInstVarNames` rejects `#file`), and its text table
 * pads and shortens cells, so neither names an image reliably. Its own rule is
 * `PhLDirectoryBasedImageRepository>>withImagesFilesCollect:`: an image is a
 * directory `D` of the images directory holding `D.image` and `D.changes`,
 * named `D`. The same in 3.0, 3.4.5 and 4.0-alpha-2.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PharoLauncherConfig } from "./config.js";
import type { LauncherImage, LauncherProcess, NotAnImage } from "./models.js";
import { launcherUserFilesLocation } from "./platform.js";
import type { NativeProcessScope } from "./processTools.js";

/** Where the images directory came from. */
export type ImagesDirectorySource =
  /** The profile's, which this server writes into the Launcher's configuration. */
  | "profile"
  /** `#imagesDirectory` of `PHARO_LAUNCHER_MCP_LAUNCHER_CONFIGURATION`. */
  | "configuration"
  /** `#imagesDirectory` of `<user files>/launcherSettings.ston`. */
  | "settings"
  /** `<user files>/images`, the Launcher's default, when the file names none. */
  | "default";

export interface ImagesDirectory {
  path: string;
  source: ImagesDirectorySource;
  /** Outside a profile: the settings file read, or looked for. */
  settingsFile?: string;
}

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

/**
 * The `#imagesDirectory : FILE [ '…' ]` of a Launcher configuration. A doubled
 * quote is one quote; on Windows the slash `stonFilePath` writes before a drive
 * letter (`/C:/…`) is dropped.
 */
export function settingsImagesDirectory(
  content: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const match = /#imagesDirectory\s*:\s*FILE\s*\[\s*'((?:''|[^'])*)'\s*\]/.exec(
    content,
  );
  const value = match?.[1]?.replaceAll("''", "'");
  if (!value) {
    return undefined;
  }

  return platform === "win32" && /^\/[A-Za-z]:(?:[\\/]|$)/.test(value)
    ? value.slice(1)
    : value;
}

function readTextFile(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * The images directory the Launcher this server runs reads.
 *
 * In profile mode it is the profile's, which the server itself writes into the
 * Launcher's configuration. Outside a profile it is what the configuration the
 * CLI reads names (`PharoLauncherCLIConfiguration class>>preferencesFile`),
 * else the Launcher's default (`PhLDirectoryBasedImageRepository class>>defaultLocation`).
 */
export function resolveImagesDirectory(
  config: PharoLauncherConfig,
  platform: NodeJS.Platform = process.platform,
): ImagesDirectory {
  const paths = pathApi(platform);
  if (config.profile) {
    return { path: paths.resolve(config.profile.imagesDir), source: "profile" };
  }

  const userFiles =
    config.launcherUserFilesDir ??
    launcherUserFilesLocation(process.env, platform) ??
    launcherUserFilesLocation({ HOME: os.homedir() }, platform)!;
  const settingsFile = config.launcherConfiguration
    ? paths.resolve(config.launcherConfiguration)
    : paths.join(userFiles, "launcherSettings.ston");
  const content = readTextFile(settingsFile);
  const named =
    content === undefined ? undefined : settingsImagesDirectory(content, platform);
  if (named) {
    return {
      path: paths.resolve(named),
      source: config.launcherConfiguration ? "configuration" : "settings",
      settingsFile,
    };
  }

  return {
    path: paths.resolve(paths.join(userFiles, "images")),
    source: "default",
    settingsFile,
  };
}

/** An image, as the cheap pass reads it: its name and its files. */
export interface ImageEntry {
  name: string;
  directory: string;
  imagePath: string;
  /** When `D.image` was last written: ISO 8601, UTC, whole seconds. */
  modified: string;
}

export interface ImageScan {
  imagesDir: string;
  exists: boolean;
  /** In name order, by code point. */
  images: ImageEntry[];
  /** In name order, by code point. */
  notImages: NotAnImage[];
}

function fileStat(filePath: string): fs.Stats | undefined {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat : undefined;
  } catch {
    return undefined;
  }
}

function isDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function isoSeconds(date: Date): string {
  return new Date(Math.floor(date.getTime() / 1000) * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
}

/** What the directory `name` of the images directory is. */
export type ImageDirectory =
  | { kind: "image"; image: ImageEntry }
  | { kind: "not-an-image"; notAnImage: NotAnImage }
  | { kind: "missing"; directory: string };

/** Reads one directory of the images directory, under exactly this name. */
export function readImageDirectory(
  imagesDir: string,
  name: string,
): ImageDirectory {
  const directory = path.join(imagesDir, name);
  if (!isDirectory(directory)) {
    return { kind: "missing", directory };
  }

  const imagePath = path.join(directory, `${name}.image`);
  const image = fileStat(imagePath);
  const hasChanges = fileStat(path.join(directory, `${name}.changes`)) !== undefined;
  if (image && hasChanges) {
    return {
      kind: "image",
      image: { name, directory, imagePath, modified: isoSeconds(image.mtime) },
    };
  }

  return {
    kind: "not-an-image",
    notAnImage: { name, directory, hasImage: image !== undefined, hasChanges },
  };
}

/** Compares names by code point, which `<` on strings does not for every one. */
export function compareCodePoints(left: string, right: string): number {
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const a = left.codePointAt(i)!;
    const b = right.codePointAt(j)!;
    if (a !== b) {
      return a - b;
    }
    i += a > 0xffff ? 2 : 1;
    j += b > 0xffff ? 2 : 1;
  }

  return left.length - i - (right.length - j);
}

function byName(left: { name: string }, right: { name: string }): number {
  return compareCodePoints(left.name, right.name);
}

/**
 * The cheap pass: every directory of the images directory, as an image or not,
 * with no metadata. A hidden directory is skipped, which the Launcher does
 * not do: those are this server's temporary copies (`.<name>.copy-….tmp`).
 */
export function scanImages(imagesDir: string): ImageScan {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(imagesDir, { withFileTypes: true });
  } catch {
    return {
      imagesDir,
      exists: fs.existsSync(imagesDir),
      images: [],
      notImages: [],
    };
  }

  const images: ImageEntry[] = [];
  const notImages: NotAnImage[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    if (
      !entry.isDirectory() &&
      !(entry.isSymbolicLink() && isDirectory(path.join(imagesDir, entry.name)))
    ) {
      continue;
    }

    const read = readImageDirectory(imagesDir, entry.name);
    if (read.kind === "image") {
      images.push(read.image);
    } else if (read.kind === "not-an-image") {
      notImages.push(read.notAnImage);
    }
  }

  return {
    imagesDir,
    exists: true,
    images: images.sort(byName),
    notImages: notImages.sort(byName),
  };
}

/**
 * The one named exactly so, else the one whose name differs from it only in
 * case: the Launcher's `imageNamed:` and `hasImageNamed:` compare names
 * ignoring case.
 */
export function findByName<T extends { name: string }>(
  items: readonly T[],
  name: string,
): T | undefined {
  const lower = name.toLowerCase();
  return (
    items.find((item) => item.name === name) ??
    items.find((item) => item.name.toLowerCase() === lower)
  );
}

/**
 * Those whose name contains the filter, case-sensitive, as the Launcher's
 * `includesSubstring:`.
 */
export function filterByName<T extends { name: string }>(
  items: readonly T[],
  nameFilter: string | undefined,
): T[] {
  return nameFilter === undefined
    ? [...items]
    : items.filter((item) => item.name.includes(nameFilter));
}

/** What a directory lacks to be the image it is named after. */
export function whatItLacks(
  notAnImage: Pick<NotAnImage, "name" | "hasImage" | "hasChanges">,
): string {
  const { name, hasImage, hasChanges } = notAnImage;
  if (!hasImage && !hasChanges) {
    return `holds neither ${name}.image nor ${name}.changes`;
  }

  return hasImage ? `holds no ${name}.changes` : `holds no ${name}.image`;
}

// meta-inf.ston is read as the Launcher writes it, pretty-printed: `#key :
// value`, any spacing, `''` for one quote. Only what a field needs is read, so
// a field this reader does not know never makes the file unreadable.

function skipString(source: string, index: number): number {
  let i = index + 1;
  while (i < source.length) {
    if (source[i] === "'") {
      if (source[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }

  return i;
}

function endOfValue(source: string, index: number): number {
  let depth = 0;
  let i = index;
  while (i < source.length) {
    const char = source[i];
    if (char === "'") {
      i = skipString(source, i);
      continue;
    }
    if (char === "{" || char === "[" || char === "(") {
      depth += 1;
    } else if (char === "}" || char === "]" || char === ")") {
      if (depth === 0) {
        return i;
      }
      depth -= 1;
    } else if (char === "," && depth === 0) {
      return i;
    }
    i += 1;
  }

  return i;
}

/** The first `{` that opens an object, outside any string. */
function firstObjectOpen(source: string): number {
  let i = 0;
  while (i < source.length) {
    if (source[i] === "'") {
      i = skipString(source, i);
      continue;
    }
    if (source[i] === "{") {
      return i;
    }
    i += 1;
  }

  return -1;
}

/** The fields of the object whose `{` is at `open`, as their source. */
function stonFields(source: string, open: number): Map<string, string> {
  const fields = new Map<string, string>();
  const key = /\s*#([A-Za-z_][A-Za-z0-9_]*)\s*:/y;
  let i = open + 1;

  while (i < source.length) {
    while (/[\s,]/.test(source[i] ?? "")) {
      i += 1;
    }
    key.lastIndex = i;
    const match = key.exec(source);
    if (!match) {
      break;
    }

    const valueStart = key.lastIndex;
    const valueEnd = endOfValue(source, valueStart);
    fields.set(match[1]!, source.slice(valueStart, valueEnd).trim());
    i = valueEnd;
  }

  return fields;
}

function objectFields(value: string | undefined): Map<string, string> | undefined {
  if (value === undefined || !/^[A-Za-z]\w*\s*\{/.test(value)) {
    return undefined;
  }

  return stonFields(value, value.indexOf("{"));
}

function stringValue(value: string | undefined): string | undefined {
  const match = value === undefined ? null : /^'((?:''|[^'])*)'$/s.exec(value);
  return match ? match[1]!.replaceAll("''", "'") : undefined;
}

function urlValue(value: string | undefined): string | undefined {
  const url =
    value === undefined
      ? null
      : /^URL\s*\[\s*('(?:''|[^'])*')\s*\]$/s.exec(value);
  return stringValue(url ? url[1] : value);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

interface MetaInf {
  pharoVersion?: string;
  architecture?: string;
  template?: { name: string; url?: string };
  vmId?: string;
}

/** What the Launcher records about an image, read from its meta-inf.ston. */
export function readMetaInf(source: string): MetaInf {
  const open = firstObjectOpen(source);
  if (open < 0) {
    return {};
  }

  const fields = stonFields(source, open);
  const template = objectFields(fields.get("originTemplate"));
  const templateName = nonEmpty(stringValue(template?.get("name")));
  const templateUrl = nonEmpty(urlValue(template?.get("url")));
  const configurations = fields.get("launchConfigurations");
  const firstConfigurationOpen =
    configurations === undefined ? -1 : firstObjectOpen(configurations);
  const vm =
    firstConfigurationOpen < 0
      ? undefined
      : objectFields(
          stonFields(configurations!, firstConfigurationOpen).get("vm"),
        );
  const pharoVersion = nonEmpty(stringValue(fields.get("pharoVersion")));
  const architecture = nonEmpty(stringValue(fields.get("architecture")));
  const vmId = nonEmpty(stringValue(vm?.get("id")));

  return {
    ...(pharoVersion ? { pharoVersion } : {}),
    ...(architecture ? { architecture } : {}),
    ...(templateName
      ? { template: { name: templateName, ...(templateUrl ? { url: templateUrl } : {}) } }
      : {}),
    ...(vmId ? { vmId } : {}),
  };
}

/**
 * The architecture an image's header says: its first four bytes, read
 * little-endian, are its format (`PhLVirtualMachineManager class>>imageFormat64bits`,
 * `imageFormat32bits`, `imageFormatPreSpur`).
 */
export function headerArchitecture(imagePath: string): "64" | "32" | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(imagePath, "r");
    const header = Buffer.alloc(4);
    if (fs.readSync(descriptor, header, 0, 4, 0) < 4) {
      return undefined;
    }

    const format = header.readUInt32LE(0);
    if (format === 68021) {
      return "64";
    }
    return format === 6521 || format === 6505 ? "32" : undefined;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

function asArchitecture(value: string | undefined): "64" | "32" | undefined {
  return value === "64" || value === "32" ? value : undefined;
}

/**
 * The full pass, for one image: what its meta-inf.ston, its pharo.version and
 * its header say. A missing or unreadable file leaves its fields out.
 */
export function readLauncherImage(entry: ImageEntry): LauncherImage {
  const metaInfSource = readTextFile(path.join(entry.directory, "meta-inf.ston"));
  const metaInf = metaInfSource === undefined ? {} : readMetaInf(metaInfSource);
  const pharoVersion =
    metaInf.pharoVersion ??
    nonEmpty(readTextFile(path.join(entry.directory, "pharo.version"))?.trim());
  const architecture =
    asArchitecture(metaInf.architecture) ?? headerArchitecture(entry.imagePath);

  return {
    name: entry.name,
    imagePath: entry.imagePath,
    ...(pharoVersion ? { pharoVersion } : {}),
    ...(architecture ? { architecture } : {}),
    ...(metaInf.template ? { template: metaInf.template } : {}),
    ...(metaInf.vmId ? { vmId: metaInf.vmId } : {}),
    modified: entry.modified,
  };
}

function isBound(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char) || char === '"' || char === "'";
}

/**
 * Whether a command line names this file: it holds the path, starting at the
 * start of the line or after whitespace or a quote, and ending at its end or
 * before whitespace or a quote. On Windows case does not count, and `/` and
 * `\` are alike.
 *
 * Matched from the image's side because `ps` prints no quotes: for
 * `…/images/MCP debug/MCP debug.image` a token read off the line is
 * `debug.image`, which resolves nowhere. The bounds keep a VM on
 * `pricing-2025` from counting for `pricing`.
 */
export function commandLineNamesFile(
  commandLine: string,
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const normalize =
    platform === "win32"
      ? (value: string) => value.replaceAll("\\", "/").toLowerCase()
      : (value: string) => value;
  const line = normalize(commandLine);
  const target = normalize(filePath);
  if (target.length === 0) {
    return false;
  }

  for (let at = line.indexOf(target); at >= 0; at = line.indexOf(target, at + 1)) {
    if (isBound(line[at - 1]) && isBound(line[at + target.length])) {
      return true;
    }
  }

  return false;
}

function realPath(filePath: string): string | undefined {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return undefined;
  }
}

/**
 * The processes running these images, each named as its image and given the
 * path as the reader built it: a VM runs image `D` when its command line names
 * `<images>/D/D.image`, as built or as its real path. In image name order,
 * then pid.
 */
export function processesOfImages(
  images: readonly ImageEntry[],
  processes: readonly LauncherProcess[],
  platform: NodeJS.Platform = process.platform,
): LauncherProcess[] {
  if (processes.length === 0 || images.length === 0) {
    return [];
  }

  const spellings = images.map((image) => {
    const real = realPath(image.imagePath);
    return {
      image,
      paths: real && real !== image.imagePath ? [image.imagePath, real] : [image.imagePath],
    };
  });

  return processes
    .flatMap((process) => {
      const match = spellings.find(({ paths }) =>
        paths.some((filePath) =>
          commandLineNamesFile(process.commandLine, filePath, platform),
        ),
      );
      return match
        ? [{ ...process, imagePath: match.image.imagePath, imageName: match.image.name }]
        : [];
    })
    .sort(
      (left, right) =>
        compareCodePoints(left.imageName ?? "", right.imageName ?? "") ||
        left.pid - right.pid,
    );
}

/**
 * The process tools' view of this images directory: the VMs running one of
 * its images, and for a kill given an image name, the VMs of the image found
 * as every tool finds it, exactly, else ignoring case.
 */
export function imagesProcessScope(
  imagesDir: string,
  platform: NodeJS.Platform = process.platform,
): NativeProcessScope {
  let scan: ImageScan | undefined;
  const images = (): ImageEntry[] => (scan ??= scanImages(imagesDir)).images;

  return {
    select: (processes) => processesOfImages(images(), processes, platform),
    imageTargets: (processes, imageName) => {
      const image = findByName(images(), imageName);
      return image
        ? processes.filter((process) => process.imageName === image.name)
        : [];
    },
  };
}
