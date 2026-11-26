import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  CopyBetweenProfilesInput,
  CopyBetweenProfilesResult,
  CopyImageInput,
  CreateImageInput,
  CrossProfileCopyFailure,
  ImageDirectory,
  ImageEntry,
  ImageMetadataRepairResult,
  KillProcessInput,
  KillProcessResult,
  LauncherCommandResult,
  LauncherCommandRun,
  LauncherImage,
  LauncherImageInfo,
  LauncherImageList,
  LauncherLaunchReport,
  LauncherProcess,
  LauncherSettings,
  LauncherTemplate,
  ListTemplatesInput,
  MadeImageFailure,
  MadeImageResult,
  MissingProfilePath,
  NotAnImage,
  OpenPharoLauncherOptions,
  PharoLauncher,
  PharoLauncherConfigReport,
  ProfileLocation,
  StartImageInput,
  StartImageResult,
  TemplateCategoriesResult,
  TemplateListResult,
  TemplateSources,
  TemplateUpdateResult,
} from "./library.js";
import * as library from "./library.js";

interface PackageManifest {
  bin: Record<string, string>;
  main: string;
  types: string;
  exports: Record<string, string>;
}

// fileURLToPath, not URL.pathname: on Windows the latter is "/C:/..." and
// every path built from it is wrong.
const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  fs.readFileSync(path.join(packageRoot, "..", "package.json"), "utf8"),
) as PackageManifest;

/** `./dist/config.js` is built from `src/config.ts`, which is what exists here. */
function sourceFor(distPath: string): string {
  return path.join(
    packageRoot,
    "..",
    distPath.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts"),
  );
}

/**
 * What the package promises a caller can name.
 *
 * A function is only half usable when its answer has no name: the caller
 * copies the shape into its own type and the two drift. These are type-only,
 * so nothing at runtime can check them; this list is the check, and the
 * typecheck fails if `library.ts` stops exporting one.
 */
type LibraryTypes = [
  CopyBetweenProfilesInput,
  CopyBetweenProfilesResult,
  CopyImageInput,
  CreateImageInput,
  CrossProfileCopyFailure,
  ImageDirectory,
  ImageEntry,
  ImageMetadataRepairResult,
  KillProcessInput,
  KillProcessResult,
  LauncherCommandResult,
  LauncherCommandRun,
  LauncherImage,
  LauncherImageInfo,
  LauncherImageList,
  LauncherLaunchReport,
  LauncherProcess,
  LauncherSettings,
  LauncherTemplate,
  ListTemplatesInput,
  MadeImageFailure,
  MadeImageResult,
  MissingProfilePath,
  NotAnImage,
  OpenPharoLauncherOptions,
  PharoLauncher,
  PharoLauncherConfigReport,
  ProfileLocation,
  StartImageInput,
  StartImageResult,
  TemplateCategoriesResult,
  TemplateListResult,
  TemplateSources,
  TemplateUpdateResult,
];

describe("package exports", () => {
  it("exports these values, and no other", () => {
    // Each is a promise after 1.0: a new one is added here on purpose.
    expect(Object.keys(library).sort()).toEqual([
      "ProfileTooDeepError",
      "ToolInputError",
      "openPharoLauncher",
      "readImageDirectory",
      "readLauncherImage",
      "repairCopiedImageMetadataInDirectory",
    ]);
  });

  it("has one entry point, the library", () => {
    expect(manifest.exports).toEqual({
      ".": "./dist/library.js",
      "./package.json": "./package.json",
    });
    expect(manifest.main).toBe("./dist/library.js");
    expect(manifest.types).toBe("./dist/library.d.ts");
  });

  it("exports a subpath for every file a consumer may import", () => {
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      if (subpath === "./package.json") {
        continue;
      }

      expect(
        fs.existsSync(sourceFor(target)),
        `${subpath} points at ${target}, which no source file builds`,
      ).toBe(true);
    }
  });

  it("does not make the executable the package entry point", () => {
    // dist/index.js starts an MCP server on stdio when it is loaded, so
    // importing the package must not reach it. It is the bin, nothing else.
    expect(manifest.bin["pharo-launcher-mcp"]).toBe("dist/index.js");
    expect(Object.values(manifest.exports)).not.toContain("./dist/index.js");
    expect(manifest.main).not.toContain("index.js");
    expect(manifest.types).not.toContain("index.d.ts");
  });
});
