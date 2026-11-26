/**
 * The package's entry point: what a Node program calls to drive Pharo
 * Launcher, in its own process.
 *
 * Everything here is the semver promise. The MCP server is the
 * `pharo-launcher-mcp` command, not part of it.
 */
import { configForSettings, type LauncherSettings } from "./config.js";
import { openLauncher, type PharoLauncher } from "./launcher.js";

export type {
  CopyImageInput,
  CreateImageInput,
  KillProcessInput,
  ListTemplatesInput,
  PharoLauncher,
  StartImageInput,
} from "./launcher.js";
export type {
  KillProcessResult,
  LauncherCommandResult,
  LauncherCommandRun,
  LauncherImage,
  LauncherImageInfo,
  LauncherImageList,
  LauncherLaunchReport,
  LauncherProcess,
  LauncherTemplate,
  MadeImageFailure,
  MadeImageResult,
  NotAnImage,
  StartImageResult,
  TemplateCategoriesResult,
  TemplateListResult,
  TemplateSources,
  TemplateUpdateResult,
} from "./models.js";
export type {
  CopyBetweenProfilesInput,
  CopyBetweenProfilesResult,
  CrossProfileCopyFailure,
  MissingProfilePath,
  ProfileLocation,
} from "./crossProfileCopy.js";
export type { PharoLauncherConfigReport } from "./discovery.js";
export type { LauncherSettings } from "./config.js";
export { ProfileTooDeepError, ToolInputError } from "./commandCatalog.js";
export {
  readImageDirectory,
  readLauncherImage,
  type ImageDirectory,
  type ImageEntry,
} from "./imageStore.js";
export {
  repairCopiedImageMetadataInDirectory,
  type ImageMetadataRepairResult,
} from "./imageMetadata.js";

export interface OpenPharoLauncherOptions extends LauncherSettings {
  /** How long a Launcher command may take before it is stopped; 30 s. */
  timeoutMs?: number;
}

/**
 * Pharo Launcher, as functions: on a profile of the caller's, or on the
 * user's own Launcher and its images when none is given.
 */
export function openPharoLauncher(options: OpenPharoLauncherOptions = {}): PharoLauncher {
  const { timeoutMs, ...settings } = options;
  return openLauncher({
    config: configForSettings(settings),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}
