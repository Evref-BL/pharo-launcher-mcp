import fs from "node:fs";
import path from "node:path";
import { InvalidInputError, validImageName } from "./commandCatalog.js";
import { repairCopiedImageMetadataInDirectory } from "./imageMetadata.js";
import {
  findByName,
  readImageDirectory,
  readLauncherImage,
  scanImages,
  whatItLacks,
} from "./imageStore.js";
import type { LauncherImage, NameTaken, NoSuchImage } from "./models.js";

/**
 * An images directory: the one a profile keeps under its `stateRoot`, or one
 * given as it is, such as the user's own Launcher's.
 */
export type ProfileLocation =
  | { stateRoot: string; imagesDir?: never }
  | { imagesDir: string; stateRoot?: never };

export interface CopyBetweenProfilesInput {
  sourceProfile: ProfileLocation;
  destinationProfile: ProfileLocation;
  /** The image to copy. */
  image: string;
  /** The copy's name, which may be the image's. */
  newImage: string;
}

/** A profile path that does not exist, which a copy does not create. */
export interface MissingProfilePath {
  profile: "sourceProfile" | "destinationProfile";
  field: "stateRoot" | "imagesDir";
  path: string;
  /** False for the images directory a `stateRoot` should hold. */
  given: boolean;
}

/**
 * Why a copy between profiles made no copy: a profile path that does not
 * exist (`profile-path-missing`, each named in `paths`); a source that is not
 * an image (`no-such-image`) or has no meta-inf.ston (`no-metadata`); a new
 * name an image of the destination has already, in any case (`name-taken`),
 * or a directory of that exact name that is not one (`destination-exists`),
 * which a copy never replaces; a copy that did not check out, removed
 * (`preflight`) or left in place once moved there (`post-move`); or copying
 * threw (`exception`), leaving behind a temporary directory it could not
 * remove (`leftBehind`).
 */
export type CopyBetweenProfilesFailure =
  | { kind: "profile-path-missing"; paths: MissingProfilePath[] }
  | NoSuchImage
  | { kind: "no-metadata" }
  | NameTaken
  | { kind: "destination-exists" }
  | { kind: "preflight" }
  | { kind: "post-move" }
  | { kind: "exception"; leftBehind?: string };

/** A profile as the copy read it. */
export interface ResolvedProfile {
  stateRoot?: string;
  imagesDir: string;
}

/** An image's directory, and its image file. */
export interface ImageLocation {
  directory: string;
  imagePath: string;
}

/**
 * A copy between profiles, answered as `copyImage` answers: its `data` is the
 * copy, read from its new directory.
 */
export interface CopyBetweenProfilesResult {
  ok: boolean;
  data?: { image: LauncherImage };
  failure?: CopyBetweenProfilesFailure;
  /** Why it failed; there whenever `ok` is false. */
  diagnostic?: string;
  /** What to do about it. */
  action?: string;
  sourceProfile: ResolvedProfile;
  destinationProfile: ResolvedProfile;
  /** The source image, where it was found. */
  source: ImageLocation;
  /** The copy, where it goes. */
  destination: ImageLocation;
}

function inputObject(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new InvalidInputError(`${label} must be an object`);
  }

  return input as Record<string, unknown>;
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidInputError(`${key} is required`);
  }

  return value;
}

function absolutePath(value: unknown, key: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidInputError(`${key} must be a non-empty string`);
  }
  if (!path.isAbsolute(value)) {
    throw new InvalidInputError(`${key} must be an absolute path`);
  }

  return path.resolve(value);
}

/** A profile given by its stateRoot or its imagesDir, one of the two; `null` is left out. */
export function resolveProfileLocation(
  input: unknown,
  label: "sourceProfile" | "destinationProfile",
): ResolvedProfile {
  const object = Object.fromEntries(
    Object.entries(inputObject(input, label)).filter(([, value]) => value !== null),
  );
  const unknown = Object.keys(object).filter((key) => key !== "stateRoot" && key !== "imagesDir");
  if (unknown.length > 0) {
    throw new InvalidInputError(`${label} takes stateRoot or imagesDir, not ${unknown.join(", ")}`);
  }
  if ((object.stateRoot === undefined) === (object.imagesDir === undefined)) {
    throw new InvalidInputError(`${label} takes stateRoot or imagesDir, one of the two`);
  }

  if (object.stateRoot !== undefined) {
    const stateRoot = absolutePath(object.stateRoot, `${label}.stateRoot`);
    return { stateRoot, imagesDir: path.join(stateRoot, "images") };
  }
  return { imagesDir: absolutePath(object.imagesDir, `${label}.imagesDir`) };
}

interface CopyRequest {
  sourceProfile: ResolvedProfile;
  destinationProfile: ResolvedProfile;
  image: string;
  newImage: string;
}

function parseCopyRequest(input: unknown): CopyRequest {
  const object = inputObject(input, "arguments");
  const image = validImageName(requiredString(object, "image"), "image");
  const newImage = validImageName(requiredString(object, "newImage"), "newImage");

  return {
    sourceProfile: resolveProfileLocation(object.sourceProfile, "sourceProfile"),
    destinationProfile: resolveProfileLocation(object.destinationProfile, "destinationProfile"),
    image,
    newImage,
  };
}

function stonStringParts(source: string): string[] {
  const parts: string[] = [];
  let part: string | undefined;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char !== "'") {
      if (part !== undefined) {
        part += char;
      }
      continue;
    }

    if (part === undefined) {
      part = "";
      continue;
    }

    if (source[index + 1] === "'") {
      part += "'";
      index += 1;
      continue;
    }

    parts.push(part);
    part = undefined;
  }

  return parts;
}

function relativePathBodyEnd(metadataContent: string, bracketStart: number): number {
  let inString = false;

  for (let index = bracketStart + 1; index < metadataContent.length; index += 1) {
    const char = metadataContent[index];
    if (char === "'") {
      if (inString && metadataContent[index + 1] === "'") {
        index += 1;
        continue;
      }
      inString = !inString;
      continue;
    }

    if (!inString && char === "]") {
      return index;
    }
  }

  return -1;
}

function relativePathBodies(metadataContent: string): string[] {
  const bodies: string[] = [];
  let searchStart = 0;

  while (searchStart < metadataContent.length) {
    const relativePathStart = metadataContent.indexOf("RelativePath", searchStart);
    if (relativePathStart < 0) {
      break;
    }

    const bracketStart = metadataContent.indexOf("[", relativePathStart);
    if (bracketStart < 0) {
      break;
    }

    const bracketEnd = relativePathBodyEnd(metadataContent, bracketStart);
    if (bracketEnd < 0) {
      break;
    }

    bodies.push(metadataContent.slice(bracketStart + 1, bracketEnd));
    searchStart = bracketEnd + 1;
  }

  return bodies;
}

function metadataReferencesImagePath(
  metadataContent: string,
  imageName: string,
): boolean {
  return metadataImagePathReferences(metadataContent).some(
    (parts) =>
      parts.length >= 2 &&
      parts.at(-2) === imageName &&
      parts.at(-1) === `${imageName}.image`,
  );
}

function metadataImagePathReferences(metadataContent: string): string[][] {
  const references: string[][] = [];
  for (const relativePathBody of relativePathBodies(metadataContent)) {
    const parts = stonStringParts(relativePathBody);
    if (parts.at(-1)?.endsWith(".image")) {
      references.push(parts);
    }
  }

  return references;
}

function metadataSupportsLauncherDirectoryFallback(
  metadataContent: string,
): boolean {
  return (
    /PhLImage\s*\{/.test(metadataContent) &&
    /#originTemplate\s*:/.test(metadataContent) &&
    /#launchConfigurations\s*:/.test(metadataContent)
  );
}

type PathKind = "missing" | "file" | "directory" | "other";

function pathKind(filePath: string): PathKind {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other";
  } catch {
    return "missing";
  }
}

/** How a profile is named to a reader: by its state root, else its images directory. */
export function profileLabel(profile: ResolvedProfile): string {
  return profile.stateRoot ?? profile.imagesDir;
}

// A copy creates no profile path. One that does not exist was guessed, and an
// images directory made for it would hold a copy no Launcher reads, under an
// answer that says it succeeded. A missing stateRoot is named alone: the
// images directory taken from it is missing with it.
function missingProfilePaths(
  profile: ResolvedProfile,
  label: MissingProfilePath["profile"],
): MissingProfilePath[] {
  if (profile.stateRoot !== undefined) {
    if (!fs.existsSync(profile.stateRoot)) {
      return [{ profile: label, field: "stateRoot", path: profile.stateRoot, given: true }];
    }
    return fs.existsSync(profile.imagesDir)
      ? []
      : [{ profile: label, field: "imagesDir", path: profile.imagesDir, given: false }];
  }
  return fs.existsSync(profile.imagesDir)
    ? []
    : [{ profile: label, field: "imagesDir", path: profile.imagesDir, given: true }];
}

/** `A, B and C`. */
function allOf(items: readonly string[]): string {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** `A /a and B /b do not exist.`, then each stateRoot that holds no images/. */
function missingProfilePathsText(
  request: CopyRequest,
  missing: readonly MissingProfilePath[],
): string {
  const absent = missing
    .filter((each) => each.given)
    .map((each) => `${each.profile}.${each.field} ${each.path}`);
  return [
    absent.length > 0 && `${allOf(absent)} ${absent.length === 1 ? "does" : "do"} not exist.`,
    ...missing
      .filter((each) => !each.given)
      .map(
        (each) =>
          `${each.profile}.stateRoot ${request[each.profile].stateRoot} holds no images/ directory.`,
      ),
  ]
    .filter(Boolean)
    .join(" ");
}

function uniqueTemporaryDirectory(parent: string, newImage: string): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = `${process.pid}-${Date.now()}-${attempt}`;
    const candidate = path.join(parent, `.${newImage}.copy-${suffix}.tmp`);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error("Could not allocate a temporary destination image directory");
}

function renameCopiedCompanionFile(
  directory: string,
  image: string,
  newImage: string,
  extension: ".image" | ".changes",
): void {
  if (image === newImage) {
    return;
  }

  const sourcePath = path.join(directory, `${image}${extension}`);
  const destinationPath = path.join(directory, `${newImage}${extension}`);
  if (!fs.existsSync(sourcePath)) {
    return;
  }
  if (fs.existsSync(destinationPath)) {
    throw new Error(
      `Copied image directory contains both ${image}${extension} and ${newImage}${extension}`,
    );
  }

  fs.renameSync(sourcePath, destinationPath);
}

/** Why a copied image directory is not the image asked for, or nothing. */
function copyProblem(directory: string, image: string, newImage: string): string | undefined {
  const metadataFile = path.join(directory, "meta-inf.ston");
  if (pathKind(directory) !== "directory") {
    return "the image directory does not exist after the copy";
  }
  if (pathKind(path.join(directory, `${newImage}.image`)) !== "file") {
    return `it holds no ${newImage}.image`;
  }
  if (pathKind(path.join(directory, `${newImage}.changes`)) !== "file") {
    return `it holds no ${newImage}.changes`;
  }
  if (pathKind(metadataFile) !== "file") {
    return "it holds no meta-inf.ston";
  }

  const metadata = fs.readFileSync(metadataFile, "utf8");
  const referencesNew = metadataReferencesImagePath(metadata, newImage);
  const fallsBack =
    metadataImagePathReferences(metadata).length === 0 &&
    metadataSupportsLauncherDirectoryFallback(metadata);
  if (!referencesNew && !fallsBack) {
    return `its meta-inf.ston does not name ${newImage}.image`;
  }
  if (image !== newImage && metadataReferencesImagePath(metadata, image)) {
    return `its meta-inf.ston still names ${image}.image`;
  }
  if (image !== newImage && pathKind(path.join(directory, `${image}.image`)) !== "missing") {
    return `it still holds ${image}.image`;
  }
  return undefined;
}

/**
 * Copy an image from one images directory to another, renamed when asked,
 * such as from the user's own Launcher into a profile. Nothing runs: the
 * files are copied to a temporary directory beside the destination, checked,
 * then moved in place and checked again. An existing image is never replaced.
 * The source is found as every call finds an image: exactly, else ignoring
 * case.
 */
export async function copyImageBetweenProfiles(
  input: CopyBetweenProfilesInput,
): Promise<CopyBetweenProfilesResult> {
  const request = parseCopyRequest(input);
  const sourceScan = scanImages(request.sourceProfile.imagesDir);
  const sourceEntry = findByName(sourceScan.images, request.image);
  const sourceName = sourceEntry?.name ?? request.image;
  const sourceDirectory = path.join(request.sourceProfile.imagesDir, sourceName);
  const destinationDirectory = path.join(request.destinationProfile.imagesDir, request.newImage);
  const base = {
    sourceProfile: request.sourceProfile,
    destinationProfile: request.destinationProfile,
    source: {
      directory: sourceDirectory,
      imagePath: path.join(sourceDirectory, `${sourceName}.image`),
    },
    destination: {
      directory: destinationDirectory,
      imagePath: path.join(destinationDirectory, `${request.newImage}.image`),
    },
  };
  const failed = (
    failure: CopyBetweenProfilesFailure,
    diagnostic: string,
    action?: string,
  ): CopyBetweenProfilesResult => ({
    ...base,
    ok: false,
    failure,
    diagnostic,
    ...(action ? { action } : {}),
  });

  const missing = [
    ...missingProfilePaths(request.sourceProfile, "sourceProfile"),
    ...missingProfilePaths(request.destinationProfile, "destinationProfile"),
  ];
  if (missing.length > 0) {
    return failed(
      { kind: "profile-path-missing", paths: missing },
      missingProfilePathsText(request, missing),
    );
  }

  if (!sourceEntry) {
    const notAnImage = findByName(sourceScan.notImages, request.image);
    return failed(
      { kind: "no-such-image", image: request.image, ...(notAnImage ? { notAnImage } : {}) },
      notAnImage
        ? `${notAnImage.directory} ${whatItLacks(notAnImage)}`
        : `There is no image ${request.image} in ${request.sourceProfile.imagesDir}`,
    );
  }
  if (pathKind(path.join(sourceDirectory, "meta-inf.ston")) !== "file") {
    return failed({ kind: "no-metadata" }, `${sourceDirectory} holds no meta-inf.ston`);
  }
  const taken = findByName(scanImages(request.destinationProfile.imagesDir).images, request.newImage);
  if (taken) {
    return failed(
      { kind: "name-taken", image: taken.name },
      `There is already an image ${taken.name} in ${request.destinationProfile.imagesDir}`,
      "Copy under another newImage, or delete that image first.",
    );
  }
  if (pathKind(destinationDirectory) !== "missing") {
    return failed(
      { kind: "destination-exists" },
      `${destinationDirectory} already exists, and a copy never replaces it`,
      "Copy under another newImage, or remove that directory first.",
    );
  }

  let temporaryDirectory: string | undefined;
  try {
    temporaryDirectory = uniqueTemporaryDirectory(
      request.destinationProfile.imagesDir,
      request.newImage,
    );
    fs.cpSync(sourceDirectory, temporaryDirectory, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
    });
    renameCopiedCompanionFile(temporaryDirectory, sourceName, request.newImage, ".image");
    renameCopiedCompanionFile(temporaryDirectory, sourceName, request.newImage, ".changes");
    repairCopiedImageMetadataInDirectory({
      directory: temporaryDirectory,
      image: sourceName,
      newImage: request.newImage,
    });

    const preflight = copyProblem(temporaryDirectory, sourceName, request.newImage);
    if (preflight !== undefined) {
      removeLeftovers(temporaryDirectory);
      return failed({ kind: "preflight" }, preflight);
    }

    fs.renameSync(temporaryDirectory, destinationDirectory);
    temporaryDirectory = undefined;
    const moved = copyProblem(destinationDirectory, sourceName, request.newImage);
    if (moved !== undefined) {
      return failed({ kind: "post-move" }, moved, `Delete ${destinationDirectory} before copying again.`);
    }

    const copied = readImageDirectory(request.destinationProfile.imagesDir, request.newImage);
    return {
      ...base,
      ok: true,
      ...(copied.kind === "image" ? { data: { image: readLauncherImage(copied.image) } } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (temporaryDirectory !== undefined) {
      removeLeftovers(temporaryDirectory);
    }
    const leftBehind =
      temporaryDirectory !== undefined && fs.existsSync(temporaryDirectory)
        ? temporaryDirectory
        : undefined;
    return failed({ kind: "exception", ...(leftBehind ? { leftBehind } : {}) }, message);
  }
}

/**
 * Removes what a failed copy made, if it can. The copy's own failure is the
 * answer: a cleanup that fails too leaves the directory, which the answer
 * names as left behind.
 */
function removeLeftovers(directory: string): void {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    // Named as leftBehind when it still exists.
  }
}
