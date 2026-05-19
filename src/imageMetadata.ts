import fs from "node:fs";
import path from "node:path";
import type { PharoLauncherConfig } from "./config.js";

export interface ImageMetadataRepairResult {
  status: "skipped" | "unchanged" | "repaired";
  metaInfPath?: string;
  reason?: string;
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
      status: "skipped",
      reason: "No pharo-launcher-mcp profile is active.",
    };
  }

  return repairCopiedImageMetadataInDirectory(
    path.join(config.profile.imagesDir, targetImageName),
    sourceImageName,
    targetImageName,
  );
}

export function repairCopiedImageMetadataInDirectory(
  targetDirectory: string,
  sourceImageName: string,
  targetImageName: string,
): ImageMetadataRepairResult {
  const metaInfPath = path.join(targetDirectory, "meta-inf.ston");
  const targetImagePath = path.join(
    targetDirectory,
    `${targetImageName}.image`,
  );
  if (!fs.existsSync(metaInfPath)) {
    return {
      status: "skipped",
      metaInfPath,
      reason: "Copied image metadata file does not exist.",
    };
  }
  if (!fs.existsSync(targetImagePath)) {
    return {
      status: "skipped",
      metaInfPath,
      reason: "Copied image file does not use the requested target name.",
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
    return { status: "unchanged", metaInfPath };
  }

  fs.writeFileSync(metaInfPath, after, "utf8");
  return { status: "repaired", metaInfPath };
}
