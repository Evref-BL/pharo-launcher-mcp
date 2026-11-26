/**
 * The package's entry point: what a Node program calls to drive Pharo
 * Launcher, in its own process. Everything it exports is under semantic
 * versioning; the README says what else is.
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
  DeleteImageFailure,
  DeleteImageResult,
  KillProcessFailure,
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
  NameTaken,
  NoSuchImage,
  NoTemplates,
  NotAnImage,
  ProcessListResult,
  StartImageResult,
  TemplateCategoriesResult,
  TemplateListResult,
  TemplateSources,
  TemplateUpdateResult,
} from "./models.js";
export {
  copyImageBetweenProfiles,
  type CopyBetweenProfilesFailure,
  type CopyBetweenProfilesInput,
  type CopyBetweenProfilesResult,
  type ImageLocation,
  type MissingProfilePath,
  type ProfileLocation,
  type ResolvedProfile,
} from "./crossProfileCopy.js";
export type { LauncherSettings } from "./config.js";
export { InvalidInputError, ProfileTooDeepError } from "./commandCatalog.js";
export {
  readImageDirectory,
  readLauncherImage,
  type ImageDirectory,
  type ImageEntry,
} from "./imageStore.js";
export {
  repairCopiedImageMetadataInDirectory,
  type ImageMetadataRepairInput,
  type ImageMetadataRepairResult,
} from "./imageMetadata.js";

export interface OpenPharoLauncherOptions extends LauncherSettings {
  /**
   * How long a call waits for a Launcher command; 30 s. A command still
   * running then goes on, and the call answers `command.timedOut`. Only a VM
   * a profile's waited `startImage` runs itself is stopped.
   */
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
