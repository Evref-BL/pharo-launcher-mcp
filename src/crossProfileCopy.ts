import fs from "node:fs";
import path from "node:path";
import { ToolInputError } from "./commandCatalog.js";
import { repairCopiedImageMetadataInDirectory } from "./imageMetadata.js";

/**
 * An images directory: the one a profile keeps under its `stateRoot`, or one
 * given as it is, such as the user's own Launcher's.
 */
export type ProfileLocation = { stateRoot: string } | { imagesDir: string };

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

/** Why a copy between profiles failed, so a caller need not read its text. */
export type CrossProfileCopyFailure =
  /** A profile path does not exist; `missingProfilePaths` names each. */
  | "profile-path-missing"
  /** The source image's directory does not exist. */
  | "source-missing"
  /** It holds no `<image>.image`. */
  | "source-image-missing"
  /** It holds no meta-inf.ston. */
  | "source-metadata-missing"
  /** The copy's directory exists already, and is never replaced. */
  | "destination-exists"
  /** The temporary copy did not check out, and was removed. */
  | "preflight"
  /** The copy, moved in place, did not check out, and was left there. */
  | "post-move"
  /** Copying threw. */
  | "exception";

/** A profile as the copy read it. */
export interface ResolvedProfile {
  stateRoot?: string;
  imagesDir: string;
}

export interface CopyBetweenProfilesResult {
  ok: boolean;
  failure?: CrossProfileCopyFailure;
  image: string;
  newImage: string;
  sourceProfile: ResolvedProfile;
  destinationProfile: ResolvedProfile;
  /** The source image's directory. */
  source: string;
  /** The copy's directory, and its image file. */
  destination: { directory: string; imagePath: string };
  missingProfilePaths?: MissingProfilePath[];
  /** Why it failed. */
  diagnostic?: string;
  /** What to do about it. */
  action?: string;
  /** A temporary directory a failed copy could not remove. */
  leftBehind?: string;
}

function inputObject(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ToolInputError(`${label} must be an object`);
  }

  return input as Record<string, unknown>;
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolInputError(`${key} is required`);
  }

  return value;
}

function validateImageName(value: string, key: string): void {
  if (value === "." || value === ".." || /[\\/]/.test(value)) {
    throw new ToolInputError(`${key} must be a launcher image name, not a path`);
  }
}

function absolutePath(value: unknown, key: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolInputError(`${key} must be a non-empty string`);
  }
  if (!path.isAbsolute(value)) {
    throw new ToolInputError(`${key} must be an absolute path`);
  }

  return path.resolve(value);
}

/** A profile given by its stateRoot or its imagesDir, one of the two. */
export function resolveProfileLocation(
  input: unknown,
  label: "sourceProfile" | "destinationProfile",
): ResolvedProfile {
  const object = inputObject(input, label);
  const unknown = Object.keys(object).filter((key) => key !== "stateRoot" && key !== "imagesDir");
  if (unknown.length > 0) {
    throw new ToolInputError(`${label} takes stateRoot or imagesDir, not ${unknown.join(", ")}`);
  }
  if ((object.stateRoot === undefined) === (object.imagesDir === undefined)) {
    throw new ToolInputError(`${label} takes stateRoot or imagesDir, one of the two`);
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
  const image = requiredString(object, "image");
  const newImage = requiredString(object, "newImage");
  validateImageName(image, "image");
  validateImageName(newImage, "newImage");

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
 * Copy an image from one images directory to another, renamed when asked: to
 * a temporary directory beside the destination, checked, then moved in place
 * and checked again. An existing image is never replaced.
 */
export async function copyImageBetweenProfiles(input: unknown): Promise<CopyBetweenProfilesResult> {
  const request = parseCopyRequest(input);
  const source = path.join(request.sourceProfile.imagesDir, request.image);
  const destinationDirectory = path.join(request.destinationProfile.imagesDir, request.newImage);
  const base = {
    image: request.image,
    newImage: request.newImage,
    sourceProfile: request.sourceProfile,
    destinationProfile: request.destinationProfile,
    source,
    destination: {
      directory: destinationDirectory,
      imagePath: path.join(destinationDirectory, `${request.newImage}.image`),
    },
  };
  const failed = (
    failure: CrossProfileCopyFailure,
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
    return {
      ...failed("profile-path-missing", missingProfilePathsText(request, missing)),
      missingProfilePaths: missing,
    };
  }

  if (pathKind(source) !== "directory") {
    return failed("source-missing", `${source} does not exist`);
  }
  if (pathKind(path.join(source, `${request.image}.image`)) !== "file") {
    return failed("source-image-missing", `${source} holds no ${request.image}.image`);
  }
  if (pathKind(path.join(source, "meta-inf.ston")) !== "file") {
    return failed("source-metadata-missing", `${source} holds no meta-inf.ston`);
  }
  if (pathKind(destinationDirectory) !== "missing") {
    return failed(
      "destination-exists",
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
    fs.cpSync(source, temporaryDirectory, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
    });
    renameCopiedCompanionFile(temporaryDirectory, request.image, request.newImage, ".image");
    renameCopiedCompanionFile(temporaryDirectory, request.image, request.newImage, ".changes");
    repairCopiedImageMetadataInDirectory(temporaryDirectory, request.image, request.newImage);

    const preflight = copyProblem(temporaryDirectory, request.image, request.newImage);
    if (preflight !== undefined) {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      return failed("preflight", preflight);
    }

    fs.renameSync(temporaryDirectory, destinationDirectory);
    temporaryDirectory = undefined;
    const moved = copyProblem(destinationDirectory, request.image, request.newImage);
    if (moved !== undefined) {
      return failed("post-move", moved, `Delete ${destinationDirectory} before copying again.`);
    }

    return { ...base, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (temporaryDirectory !== undefined) {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
    return {
      ...failed("exception", message),
      ...(temporaryDirectory !== undefined && fs.existsSync(temporaryDirectory)
        ? { leftBehind: temporaryDirectory }
        : {}),
    };
  }
}
