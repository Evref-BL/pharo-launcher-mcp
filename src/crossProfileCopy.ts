import fs from "node:fs";
import path from "node:path";
import { ToolInputError } from "./commandCatalog.js";
import {
  repairCopiedImageMetadataInDirectory,
  type ImageMetadataRepairResult,
} from "./imageMetadata.js";

const profilePathKeys = [
  "stateRoot",
  "launcherConfiguration",
  "imagesDir",
  "vmsDir",
  "templateSourcesDir",
  "initScriptsDir",
  "logsDir",
] as const;

const completeExplicitProfileKeys = [
  "launcherConfiguration",
  "imagesDir",
  "vmsDir",
  "templateSourcesDir",
  "initScriptsDir",
  "logsDir",
] as const;

type ProfilePathKey = (typeof profilePathKeys)[number];

export interface ScopedProfileInput {
  stateRoot?: string;
  launcherConfiguration?: string;
  imagesDir?: string;
  vmsDir?: string;
  templateSourcesDir?: string;
  initScriptsDir?: string;
  logsDir?: string;
  profileName?: string;
}

export interface ResolvedScopedProfile {
  profileName: string;
  stateRoot?: string;
  launcherConfiguration?: string;
  imagesDir: string;
  vmsDir?: string;
  templateSourcesDir?: string;
  initScriptsDir?: string;
  logsDir?: string;
  explicitFields: string[];
  environment: Record<string, string>;
}

interface ImagePathMetadata {
  imageName: string;
  directory: string;
  imageFile: PathMetadata;
  metadataFile: PathMetadata;
}

interface PathMetadata {
  path: string;
  exists: boolean;
  kind: "missing" | "file" | "directory" | "other";
  bytes?: number;
}

interface TouchedPaths {
  createdDirectories: string[];
  copiedDirectories: Array<{ from: string; to: string }>;
  renamedFiles: Array<{ from: string; to: string }>;
  repairedFiles: string[];
  removedTemporaryPaths: string[];
}

interface CopyVerification {
  ok: boolean;
  destinationDirectoryExists: boolean;
  destinationImageFileExists: boolean;
  destinationMetadataFileExists: boolean;
  destinationMetadataReferencesDestination: boolean;
  sourceMetadataReferenceAbsent: boolean;
  sourceBasenameImageFileAbsent: boolean;
  diagnostic?: string;
}

interface CleanupGuidance {
  onSuccess: string;
  onFailure: string;
  destinationImageDirectory: string;
  temporaryDirectory?: string;
}

export interface CrossProfileImageCopyResult {
  ok: boolean;
  operation: "copy_between_profiles";
  sourceImageName: string;
  destinationImageName: string;
  sourceProfile: ResolvedScopedProfile;
  destinationProfile: ResolvedScopedProfile;
  sourceImage: ImagePathMetadata;
  destinationImage: ImagePathMetadata;
  touchedPaths: TouchedPaths;
  cleanup: CleanupGuidance;
  metadataRepair?: ImageMetadataRepairResult;
  verification?: CopyVerification;
  diagnostic?: string;
  action?: string;
  error?: string;
}

interface CopyRequest {
  sourceProfile: ResolvedScopedProfile;
  destinationProfile: ResolvedScopedProfile;
  sourceImageName: string;
  destinationImageName: string;
}

function inputObject(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ToolInputError(`${label} must be an object`);
  }

  return input as Record<string, unknown>;
}

function optionalString(
  input: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new ToolInputError(`${label}.${key} must be a non-empty string`);
  }

  return value;
}

function requiredString(
  input: Record<string, unknown>,
  key: string,
): string {
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

function requireAbsolutePath(value: string, key: string): string {
  const resolved = path.resolve(value);
  if (!path.isAbsolute(value)) {
    throw new ToolInputError(`${key} must be an absolute path`);
  }

  return resolved;
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function stonString(value: string): string {
  return value.replaceAll("'", "''");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function metadataImagePathPattern(imageName: string): RegExp {
  const escaped = escapeRegExp(stonString(imageName));
  return new RegExp(
    `RelativePath\\s*\\[\\s*'${escaped}'\\s*,\\s*'${escaped}\\.image'\\s*\\]`,
  );
}

function pathMetadata(filePath: string): PathMetadata {
  try {
    const stat = fs.statSync(filePath);
    return {
      path: filePath,
      exists: true,
      kind: stat.isFile()
        ? "file"
        : stat.isDirectory()
          ? "directory"
          : "other",
      ...(stat.isFile() ? { bytes: stat.size } : {}),
    };
  } catch {
    return {
      path: filePath,
      exists: false,
      kind: "missing",
    };
  }
}

function imageMetadata(
  profile: ResolvedScopedProfile,
  imageName: string,
): ImagePathMetadata {
  const directory = path.join(profile.imagesDir, imageName);

  return {
    imageName,
    directory,
    imageFile: pathMetadata(path.join(directory, `${imageName}.image`)),
    metadataFile: pathMetadata(path.join(directory, "meta-inf.ston")),
  };
}

function environmentForProfile(
  profile: Omit<ResolvedScopedProfile, "environment">,
): Record<string, string> {
  return {
    PHARO_LAUNCHER_MCP_PROFILE: profile.profileName,
    ...(profile.stateRoot
      ? { PHARO_LAUNCHER_MCP_STATE_ROOT: profile.stateRoot }
      : {}),
    PHARO_LAUNCHER_MCP_IMAGES_DIR: profile.imagesDir,
    ...(profile.vmsDir ? { PHARO_LAUNCHER_MCP_VMS_DIR: profile.vmsDir } : {}),
    ...(profile.templateSourcesDir
      ? {
          PHARO_LAUNCHER_MCP_TEMPLATE_SOURCES_DIR:
            profile.templateSourcesDir,
        }
      : {}),
    ...(profile.initScriptsDir
      ? { PHARO_LAUNCHER_MCP_INIT_SCRIPTS_DIR: profile.initScriptsDir }
      : {}),
    ...(profile.logsDir
      ? { PHARO_LAUNCHER_MCP_LOGS_DIR: profile.logsDir }
      : {}),
    ...(profile.launcherConfiguration
      ? {
          PHARO_LAUNCHER_MCP_LAUNCHER_CONFIGURATION:
            profile.launcherConfiguration,
        }
      : {}),
  };
}

export function resolveScopedProfileInput(
  input: unknown,
  label: "sourceProfile" | "destinationProfile",
): ResolvedScopedProfile {
  const object = inputObject(input, label);
  const supplied = new Map<ProfilePathKey, string>();
  for (const key of profilePathKeys) {
    const value = optionalString(object, key, label);
    if (value !== undefined) {
      supplied.set(key, requireAbsolutePath(value, `${label}.${key}`));
    }
  }

  const profileName = optionalString(object, "profileName", label) ?? "explicit";
  const stateRoot = supplied.get("stateRoot");
  const explicitFields = [
    ...[...supplied.keys()],
    ...(object.profileName !== undefined ? ["profileName"] : []),
  ];

  if (!stateRoot) {
    const missing = completeExplicitProfileKeys.filter(
      (key) => !supplied.has(key),
    );
    if (missing.length > 0) {
      throw new ToolInputError(
        `${label} must include stateRoot or explicit ${completeExplicitProfileKeys.join(", ")}`,
      );
    }
  }

  const profileWithoutEnvironment = {
    profileName,
    ...(stateRoot ? { stateRoot } : {}),
    launcherConfiguration:
      supplied.get("launcherConfiguration") ??
      path.join(stateRoot ?? "", "launcher", "pharo-launcher-cli-config.ston"),
    imagesDir: supplied.get("imagesDir") ?? path.join(stateRoot ?? "", "images"),
    ...(supplied.get("vmsDir") ?? stateRoot
      ? { vmsDir: supplied.get("vmsDir") ?? path.join(stateRoot ?? "", "vms") }
      : {}),
    ...(supplied.get("templateSourcesDir") ?? stateRoot
      ? {
          templateSourcesDir:
            supplied.get("templateSourcesDir") ??
            path.join(stateRoot ?? "", "templates"),
        }
      : {}),
    ...(supplied.get("initScriptsDir") ?? stateRoot
      ? {
          initScriptsDir:
            supplied.get("initScriptsDir") ??
            path.join(stateRoot ?? "", "init-scripts"),
        }
      : {}),
    ...(supplied.get("logsDir") ?? stateRoot
      ? {
          logsDir:
            supplied.get("logsDir") ?? path.join(stateRoot ?? "", "logs"),
        }
      : {}),
    explicitFields,
  };
  if (
    stateRoot &&
    !isPathInside(stateRoot, profileWithoutEnvironment.launcherConfiguration)
  ) {
    throw new ToolInputError(
      `${label}.launcherConfiguration must be inside ${label}.stateRoot`,
    );
  }

  return {
    ...profileWithoutEnvironment,
    environment: environmentForProfile(profileWithoutEnvironment),
  };
}

function parseCopyRequest(input: unknown): CopyRequest {
  const object = inputObject(input, "arguments");
  const sourceImageName = requiredString(object, "sourceImageName");
  const destinationImageName = requiredString(object, "destinationImageName");
  validateImageName(sourceImageName, "sourceImageName");
  validateImageName(destinationImageName, "destinationImageName");

  return {
    sourceProfile: resolveScopedProfileInput(
      object.sourceProfile,
      "sourceProfile",
    ),
    destinationProfile: resolveScopedProfileInput(
      object.destinationProfile,
      "destinationProfile",
    ),
    sourceImageName,
    destinationImageName,
  };
}

function emptyTouchedPaths(): TouchedPaths {
  return {
    createdDirectories: [],
    copiedDirectories: [],
    renamedFiles: [],
    repairedFiles: [],
    removedTemporaryPaths: [],
  };
}

function cleanupGuidance(
  destinationImageDirectory: string,
  temporaryDirectory?: string,
): CleanupGuidance {
  return {
    onSuccess:
      "If the copied image is no longer needed, delete the destination image with the destination profile active.",
    onFailure:
      "Remove any listed temporary path first. If the destination image directory exists after a failed copy, delete only that destination image directory after confirming it is caller-owned.",
    destinationImageDirectory,
    ...(temporaryDirectory ? { temporaryDirectory } : {}),
  };
}

function resultBase(
  request: CopyRequest,
  touchedPaths: TouchedPaths,
  temporaryDirectory?: string,
): Omit<
  CrossProfileImageCopyResult,
  "ok" | "metadataRepair" | "verification" | "diagnostic" | "action" | "error"
> {
  const destinationImage = imageMetadata(
    request.destinationProfile,
    request.destinationImageName,
  );

  return {
    operation: "copy_between_profiles",
    sourceImageName: request.sourceImageName,
    destinationImageName: request.destinationImageName,
    sourceProfile: request.sourceProfile,
    destinationProfile: request.destinationProfile,
    sourceImage: imageMetadata(request.sourceProfile, request.sourceImageName),
    destinationImage,
    touchedPaths,
    cleanup: cleanupGuidance(destinationImage.directory, temporaryDirectory),
  };
}

function failureResult(
  request: CopyRequest,
  touchedPaths: TouchedPaths,
  diagnostic: string,
  action: string,
  temporaryDirectory?: string,
  error?: string,
): CrossProfileImageCopyResult {
  return {
    ...resultBase(request, touchedPaths, temporaryDirectory),
    ok: false,
    diagnostic,
    action,
    ...(error ? { error } : {}),
  };
}

function removeTemporaryDirectory(
  temporaryDirectory: string | undefined,
  touchedPaths: TouchedPaths,
): void {
  if (!temporaryDirectory || !fs.existsSync(temporaryDirectory)) {
    return;
  }

  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  touchedPaths.removedTemporaryPaths.push(temporaryDirectory);
}

function uniqueTemporaryDirectory(parent: string, destinationImageName: string): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = `${process.pid}-${Date.now()}-${attempt}`;
    const candidate = path.join(parent, `.${destinationImageName}.copy-${suffix}.tmp`);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error("Could not allocate a temporary destination image directory");
}

function renameCopiedCompanionFile(
  temporaryDirectory: string,
  sourceImageName: string,
  destinationImageName: string,
  extension: ".image" | ".changes",
  touchedPaths: TouchedPaths,
): void {
  if (sourceImageName === destinationImageName) {
    return;
  }

  const sourcePath = path.join(temporaryDirectory, `${sourceImageName}${extension}`);
  const destinationPath = path.join(
    temporaryDirectory,
    `${destinationImageName}${extension}`,
  );
  if (!fs.existsSync(sourcePath)) {
    return;
  }
  if (fs.existsSync(destinationPath)) {
    throw new Error(
      `Copied image directory contains both ${sourceImageName}${extension} and ${destinationImageName}${extension}`,
    );
  }

  fs.renameSync(sourcePath, destinationPath);
  touchedPaths.renamedFiles.push({ from: sourcePath, to: destinationPath });
}

function verifyDestinationImage(
  destinationDirectory: string,
  sourceImageName: string,
  destinationImageName: string,
): CopyVerification {
  const destinationImageFile = path.join(
    destinationDirectory,
    `${destinationImageName}.image`,
  );
  const sourceBasenameImageFile = path.join(
    destinationDirectory,
    `${sourceImageName}.image`,
  );
  const metadataFile = path.join(destinationDirectory, "meta-inf.ston");
  const destinationDirectoryExists =
    pathMetadata(destinationDirectory).kind === "directory";
  const destinationImageFileExists = pathMetadata(destinationImageFile).kind === "file";
  const destinationMetadataFileExists = pathMetadata(metadataFile).kind === "file";
  const sourceBasenameImageFileAbsent =
    sourceImageName === destinationImageName ||
    pathMetadata(sourceBasenameImageFile).kind === "missing";
  const metadataContent = destinationMetadataFileExists
    ? fs.readFileSync(metadataFile, "utf8")
    : "";
  const destinationMetadataReferencesDestination =
    destinationMetadataFileExists &&
    metadataImagePathPattern(destinationImageName).test(metadataContent);
  const sourceMetadataReferenceAbsent =
    sourceImageName === destinationImageName ||
    !metadataImagePathPattern(sourceImageName).test(metadataContent);

  if (!destinationDirectoryExists) {
    return {
      ok: false,
      destinationDirectoryExists,
      destinationImageFileExists,
      destinationMetadataFileExists,
      destinationMetadataReferencesDestination,
      sourceMetadataReferenceAbsent,
      sourceBasenameImageFileAbsent,
      diagnostic: "Destination image directory does not exist after copy.",
    };
  }
  if (!destinationImageFileExists) {
    return {
      ok: false,
      destinationDirectoryExists,
      destinationImageFileExists,
      destinationMetadataFileExists,
      destinationMetadataReferencesDestination,
      sourceMetadataReferenceAbsent,
      sourceBasenameImageFileAbsent,
      diagnostic: "Destination image file does not use the requested image name.",
    };
  }
  if (!destinationMetadataFileExists) {
    return {
      ok: false,
      destinationDirectoryExists,
      destinationImageFileExists,
      destinationMetadataFileExists,
      destinationMetadataReferencesDestination,
      sourceMetadataReferenceAbsent,
      sourceBasenameImageFileAbsent,
      diagnostic: "Destination image metadata file is missing.",
    };
  }
  if (!destinationMetadataReferencesDestination) {
    return {
      ok: false,
      destinationDirectoryExists,
      destinationImageFileExists,
      destinationMetadataFileExists,
      destinationMetadataReferencesDestination,
      sourceMetadataReferenceAbsent,
      sourceBasenameImageFileAbsent,
      diagnostic:
        "Destination image metadata does not reference the requested image file.",
    };
  }
  if (!sourceMetadataReferenceAbsent) {
    return {
      ok: false,
      destinationDirectoryExists,
      destinationImageFileExists,
      destinationMetadataFileExists,
      destinationMetadataReferencesDestination,
      sourceMetadataReferenceAbsent,
      sourceBasenameImageFileAbsent,
      diagnostic:
        "Destination image metadata still references the source image file.",
    };
  }
  if (!sourceBasenameImageFileAbsent) {
    return {
      ok: false,
      destinationDirectoryExists,
      destinationImageFileExists,
      destinationMetadataFileExists,
      destinationMetadataReferencesDestination,
      sourceMetadataReferenceAbsent,
      sourceBasenameImageFileAbsent,
      diagnostic:
        "Copied image directory still contains an image file named after the source image.",
    };
  }

  return {
    ok: true,
    destinationDirectoryExists,
    destinationImageFileExists,
    destinationMetadataFileExists,
    destinationMetadataReferencesDestination,
    sourceMetadataReferenceAbsent,
    sourceBasenameImageFileAbsent,
  };
}

export function copyImageBetweenProfiles(
  input: unknown,
): CrossProfileImageCopyResult {
  const request = parseCopyRequest(input);
  const touchedPaths = emptyTouchedPaths();
  const sourceImage = imageMetadata(request.sourceProfile, request.sourceImageName);
  const destinationImage = imageMetadata(
    request.destinationProfile,
    request.destinationImageName,
  );
  let temporaryDirectory: string | undefined;

  if (pathMetadata(sourceImage.directory).kind !== "directory") {
    return failureResult(
      request,
      touchedPaths,
      "Source image directory is missing.",
      "Verify sourceProfile.imagesDir and sourceImageName before copying.",
    );
  }
  if (sourceImage.imageFile.kind !== "file") {
    return failureResult(
      request,
      touchedPaths,
      "Source image file is missing.",
      "Verify the source image directory contains an image file named after sourceImageName.",
    );
  }
  if (sourceImage.metadataFile.kind !== "file") {
    return failureResult(
      request,
      touchedPaths,
      "Source image metadata file is missing.",
      "Repair or recreate the source image before copying it between explicit profiles.",
    );
  }
  if (pathMetadata(destinationImage.directory).kind !== "missing") {
    return failureResult(
      request,
      touchedPaths,
      "Destination image already exists.",
      "Choose a different destinationImageName or delete the existing destination image with the destination profile active.",
    );
  }

  try {
    const destinationImagesDirExists = fs.existsSync(
      request.destinationProfile.imagesDir,
    );
    fs.mkdirSync(request.destinationProfile.imagesDir, { recursive: true });
    if (!destinationImagesDirExists) {
      touchedPaths.createdDirectories.push(request.destinationProfile.imagesDir);
    }

    temporaryDirectory = uniqueTemporaryDirectory(
      request.destinationProfile.imagesDir,
      request.destinationImageName,
    );
    fs.cpSync(sourceImage.directory, temporaryDirectory, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
    });
    touchedPaths.copiedDirectories.push({
      from: sourceImage.directory,
      to: temporaryDirectory,
    });

    renameCopiedCompanionFile(
      temporaryDirectory,
      request.sourceImageName,
      request.destinationImageName,
      ".image",
      touchedPaths,
    );
    renameCopiedCompanionFile(
      temporaryDirectory,
      request.sourceImageName,
      request.destinationImageName,
      ".changes",
      touchedPaths,
    );

    const metadataRepair = repairCopiedImageMetadataInDirectory(
      temporaryDirectory,
      request.sourceImageName,
      request.destinationImageName,
    );
    if (metadataRepair.status === "repaired" && metadataRepair.metaInfPath) {
      touchedPaths.repairedFiles.push(metadataRepair.metaInfPath);
    }

    const preflightVerification = verifyDestinationImage(
      temporaryDirectory,
      request.sourceImageName,
      request.destinationImageName,
    );
    if (!preflightVerification.ok) {
      removeTemporaryDirectory(temporaryDirectory, touchedPaths);
      return {
        ...failureResult(
          request,
          touchedPaths,
          `Copied image verification failed: ${preflightVerification.diagnostic}`,
          "Inspect the source image layout and metadata before retrying the copy.",
          temporaryDirectory,
        ),
        metadataRepair,
        verification: preflightVerification,
      };
    }

    fs.renameSync(temporaryDirectory, destinationImage.directory);
    temporaryDirectory = undefined;
    const verification = verifyDestinationImage(
      destinationImage.directory,
      request.sourceImageName,
      request.destinationImageName,
    );
    const finalResult = {
      ...resultBase(request, touchedPaths),
      ok: verification.ok,
      metadataRepair,
      verification,
      ...(!verification.ok
        ? {
            diagnostic: `Destination image verification failed: ${verification.diagnostic}`,
            action:
              "Delete the destination image directory if it is caller-owned, then retry from a valid source image.",
          }
        : {}),
    };

    return finalResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    removeTemporaryDirectory(temporaryDirectory, touchedPaths);
    return failureResult(
      request,
      touchedPaths,
      "Cross-profile image copy failed.",
      "Inspect touchedPaths and retry after removing any listed temporary path.",
      temporaryDirectory,
      message,
    );
  }
}
