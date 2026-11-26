import fs from "node:fs";
import path from "node:path";
import type { PharoLauncherConfig } from "./config.js";

/**
 * What a repair did to a copied image's meta-inf.ston: rewrote the paths that
 * named the source image (`repaired`), found none (`unchanged`), or left it
 * alone, `diagnostic` saying why (`skipped`).
 */
export interface ImageMetadataRepairResult {
  kind: "skipped" | "unchanged" | "repaired";
  metaInfPath?: string;
  diagnostic?: string;
}

/** A copied image's directory, the image it was copied from, and its own name. */
export interface ImageMetadataRepairInput {
  /** The copy's directory, holding `<newImage>.image` and meta-inf.ston. */
  directory: string;
  /** The image it was copied from. */
  image: string;
  /** The copy's name. */
  newImage: string;
}

function stonString(value: string): string {
  return value.replaceAll("'", "''");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function imagePathPattern(imageName: string): RegExp {
  const escaped = escapeRegExp(stonString(imageName));
  return new RegExp(
    `RelativePath\\s*\\[\\s*'${escaped}'\\s*,\\s*'${escaped}\\.image'\\s*\\]`,
    "g",
  );
}

function imagePathSton(imageName: string): string {
  const escaped = stonString(imageName);
  return `RelativePath [ '${escaped}', '${escaped}.image' ]`;
}

function stonStringParts(source: string): string[] {
  return [...source.matchAll(/'((?:''|[^'])*)'/g)].map((match) =>
    (match[1] ?? "").replaceAll("''", "'"),
  );
}

function imageRelativePathPattern(): RegExp {
  return new RegExp(
    `RelativePath\\s*\\[\\s*((?:'(?:''|[^'])*'\\s*,?\\s*)+)\\]`,
    "g",
  );
}

function referencesSourceImagePath(pathParts: string[], imageName: string): boolean {
  return (
    pathParts.length >= 2 &&
    pathParts.at(-2) === imageName &&
    pathParts.at(-1) === `${imageName}.image`
  );
}

function normalizeLauncherImagesOrigin(source: string): string {
  return source.replace(
    /#origin\s*:\s*#[A-Za-z][A-Za-z0-9_]*/g,
    "#origin : #launcherImagesLocation",
  );
}

function repairSourceImageFileLocator(
  source: string,
  sourceImageName: string,
  targetImageName: string,
): string {
  const targetPath = imagePathSton(targetImageName);

  return source.replace(/FileLocator\s*\{[\s\S]*?\}/g, (fileLocator) => {
    let repairedPath = false;
    const repairedLocator = fileLocator.replace(
      imageRelativePathPattern(),
      (match, pathSource: string) => {
        const pathParts = stonStringParts(pathSource);
        if (!referencesSourceImagePath(pathParts, sourceImageName)) {
          return match;
        }

        repairedPath = true;
        return targetPath;
      },
    );

    return repairedPath
      ? normalizeLauncherImagesOrigin(repairedLocator)
      : repairedLocator;
  });
}

export function repairCopiedImageMetadata(
  config: PharoLauncherConfig,
  sourceImageName: string,
  targetImageName: string,
): ImageMetadataRepairResult {
  if (!config.profile) {
    return {
      kind: "skipped",
      diagnostic: "No pharo-launcher-mcp profile is active.",
    };
  }

  return repairCopiedImageMetadataInDirectory({
    directory: path.join(config.profile.imagesDir, targetImageName),
    image: sourceImageName,
    newImage: targetImageName,
  });
}

/**
 * Rewrite a copied image's meta-inf.ston so that its paths name the copy, not
 * the image it was copied from, as the Launcher's own copy does: for a caller
 * that copied an image directory itself.
 */
export function repairCopiedImageMetadataInDirectory(
  input: ImageMetadataRepairInput,
): ImageMetadataRepairResult {
  const { directory: targetDirectory, image: sourceImageName, newImage: targetImageName } = input;
  const metaInfPath = path.join(targetDirectory, "meta-inf.ston");
  const targetImagePath = path.join(
    targetDirectory,
    `${targetImageName}.image`,
  );
  if (!fs.existsSync(metaInfPath)) {
    return {
      kind: "skipped",
      metaInfPath,
      diagnostic: "Copied image metadata file does not exist.",
    };
  }
  if (!fs.existsSync(targetImagePath)) {
    return {
      kind: "skipped",
      metaInfPath,
      diagnostic: "Copied image file does not use the requested target name.",
    };
  }

  const before = fs.readFileSync(metaInfPath, "utf8");
  const after = repairSourceImageFileLocator(
    before,
    sourceImageName,
    targetImageName,
  ).replace(
    imagePathPattern(sourceImageName),
    imagePathSton(targetImageName),
  );
  if (after === before) {
    return { kind: "unchanged", metaInfPath };
  }

  fs.writeFileSync(metaInfPath, after, "utf8");
  return { kind: "repaired", metaInfPath };
}
