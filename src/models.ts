/**
 * How the command a call ran ended: the Launcher's, or for the process calls
 * the host's process list.
 */
export interface LauncherCommandRun {
  durationMs: number;
  /** Absent with a signal, and while a command that outlived the call runs on. */
  exitCode: number | null;
  /** The signal that ended the command, which then has no exit code. */
  signal?: NodeJS.Signals;
  /**
   * Whether it ran past the call's time. A Launcher command goes on and the
   * call answers without it; a VM a profile's waited start runs is stopped.
   */
  timedOut: boolean;
  timeoutReason?: string;
}

/**
 * What a call that runs a Launcher command answers: whether it did what it was
 * asked, what it found, and, when it did not, why and what to do about it.
 */
export interface LauncherCommandResult<T = undefined> {
  ok: boolean;
  data?: T;
  /**
   * Why the call failed, in the Launcher's words or this package's; there
   * whenever `ok` is false, and only then.
   */
  diagnostic?: string;
  /** What to do about it, when something can be done. */
  action?: string;
  /** How the Launcher command ended; absent when the call refused before running one. */
  command?: LauncherCommandRun;
}

/**
 * An image a call names that the images directory does not hold, in a
 * profile, where this package wrote that directory itself. Outside a profile
 * the directory comes from settings that can be wrong, so the Launcher is
 * asked instead, and its answer is the answer.
 */
export interface NoSuchImage {
  kind: "no-such-image";
  image: string;
  /** What its directory lacks, when there is one. */
  notAnImage?: NotAnImage;
}

/** A new name an image already has, in a profile, in any case: `image` is that image's name. */
export interface NameTaken {
  kind: "name-taken";
  image: string;
}

/**
 * A profile that has no template sources yet: its first template update
 * downloads them.
 */
export interface NoTemplates {
  kind: "no-templates";
}

/** A start: what it ran, once it ran something. */
export interface StartImageResult extends LauncherCommandResult {
  /** Why it ran nothing. */
  failure?: NoSuchImage;
  launch?: LauncherLaunchReport;
}

/**
 * Why a delete deleted nothing: the image does not exist (in a profile), a VM
 * runs it (`pids`), or the process list failed, so whether one does is not
 * known.
 */
export type DeleteImageFailure =
  | NoSuchImage
  | { kind: "image-running"; pids: number[] }
  | { kind: "process-list-failed"; diagnostic: string };

/** A delete; it never deletes an image a VM runs. */
export interface DeleteImageResult extends LauncherCommandResult {
  failure?: DeleteImageFailure;
}

/**
 * Why a kill killed nothing: no VM of this Launcher's images has the pid or
 * runs the image, or the process list failed.
 */
export type KillProcessFailure =
  | { kind: "no-such-process" }
  | { kind: "process-list-failed"; diagnostic: string };

/** A kill: the pids it killed, and those it could not, each with why. */
export type KillProcessResult = LauncherCommandResult<{
  killed: number[];
  failures: Array<{ pid: number; diagnostic: string }>;
}> & {
  failure?: KillProcessFailure;
};

/** The processes running one of this Launcher's images. */
export type ProcessListResult = LauncherCommandResult<{ processes: LauncherProcess[] }>;

/**
 * A template listing; `failure` says when the category does not exist, or
 * when a profile has no templates yet.
 */
export type TemplateListResult = LauncherCommandResult<{ templates: LauncherTemplate[] }> & {
  failure?: { kind: "unknown-category" } | NoTemplates;
};

/**
 * What a template update did to a profile's sources.list: downloaded it where
 * there was none (`created`), replaced it with a newer one (`updated`), found
 * it current (`unchanged`), kept it when the download failed (`kept`), or
 * failed with none to keep (`failed`).
 */
export interface TemplateSources {
  kind: "created" | "updated" | "unchanged" | "kept" | "failed";
  path: string;
  url: string;
  /** Why the download failed, for `kept` and `failed`. */
  diagnostic?: string;
}

/**
 * A template update. In a profile it downloads the profile's sources.list,
 * which `sources` reports, and asks the Launcher to read it; outside one the
 * Launcher updates its own.
 */
export interface TemplateUpdateResult extends LauncherCommandResult {
  sources?: TemplateSources;
}

/**
 * What an image start ran. In profile mode this server runs the VM itself
 * (`by: "vm"`), and `output` is what that VM wrote, when the start waited for
 * it. Outside a profile it runs the Launcher's `image launch`
 * (`by: "launcher"`), and a detached start's pid is the Launcher's, not the
 * VM's. A detached start writes its output to the files `logs` names.
 */
export type LauncherLaunchReport =
  | {
      by: "vm";
      imagePath: string;
      displayMode: "headless" | "interactive";
      vmPath: string;
      vmId: string;
      /** The VM's slot: its directory among the profile's VMs, which holds `vmPath`. */
      vmDirectory: string;
      /** Whether this start downloaded the VM first. */
      vmUpdated: boolean;
      pid?: number;
      logs?: { stdout: string; stderr: string };
      output?: { stdout: string; stderr: string };
    }
  | {
      by: "launcher";
      pid?: number;
      logs?: { stdout: string; stderr: string };
      /** What the Launcher wrote, when the start waited for it. */
      output?: { stdout: string; stderr: string };
    };

/**
 * Why a create or copy made no image. Refused before any Launcher call, in a
 * profile: the new name is taken (`name-taken`), or a copy's source does not
 * exist (`no-such-image`). Refused by the Launcher: it knew no such template
 * (`unknown-template`) or category (`unknown-category`), which in a profile
 * with no template sources yet is `no-templates`. Or its command exited 0, and by the time the
 * check gave up the images directory never held the image under its name, in
 * profile mode (`not-listed`), or in any mode the Launcher's `image info`
 * could not open it (`not-opened`).
 */
export type MadeImageFailure =
  | NameTaken
  | NoSuchImage
  | NoTemplates
  | { kind: "unknown-template" }
  | { kind: "unknown-category" }
  | {
      kind: "not-listed";
      /** `<images>/<name>`. */
      directory: string;
      /** What the directory lacks, when it exists. */
      notAnImage?: NotAnImage;
      /** How long the check waited. */
      waitedMs: number;
    }
  | { kind: "not-opened"; diagnostic: string };

/**
 * A create or copy. Its `data` is `{ image?: LauncherImage }`, the image when
 * the images directory holds it; `failure` says why it made none, when that is
 * known, beside `diagnostic`, so a caller writes its own sentence.
 */
export type MadeImageResult = LauncherCommandResult<{ image?: LauncherImage }> & {
  failure?: MadeImageFailure;
};

/** A category listing, with the category the Launcher marks as its default. */
export type TemplateCategoriesResult = LauncherCommandResult<{
  categories: string[];
  defaultCategory?: string;
}>;

/**
 * An image of the Launcher: a directory `D` of its images directory holding
 * `D.image` and `D.changes`, named `D`, the rule of
 * `PhLDirectoryBasedImageRepository>>withImagesFilesCollect:`.
 */
export interface LauncherImage {
  name: string;
  /** `<images>/D/D.image`, as the images directory is spelled, not real. */
  imagePath: string;
  /**
   * The Pharo version as Pharo says it, `13.0`: read from meta-inf.ston's
   * `#pharoVersion`, else `D/pharo.version`, which write `130`.
   */
  pharoVersion?: string;
  /** meta-inf.ston's `#architecture`, else the image header's format. */
  architecture?: "64" | "32";
  /** meta-inf.ston's `#originTemplate`. */
  template?: { name: string; url?: string };
  /** The VM of meta-inf.ston's first launch configuration. */
  vmId?: string;
  /** When `D.image` was last written: ISO 8601, UTC, whole seconds. */
  modified: string;
  /**
   * The VMs running it, as `listImages` and `imageInfo` find them; left out
   * when the process list failed, and by a call that lists no process, such
   * as a create or a copy.
   */
  pids?: number[];
}

/** A directory of the images directory that is not an image. */
export interface NotAnImage {
  name: string;
  directory: string;
  /** Whether it holds `<name>.image`. */
  hasImage: boolean;
  /** Whether it holds `<name>.changes`. */
  hasChanges: boolean;
}

export interface LauncherImageList {
  imagesDir: string;
  images: LauncherImage[];
  notImages: NotAnImage[];
  /** Why the images' `pids` are left out. */
  processListFailure?: string;
}

/**
 * One image, found as every call finds it: the image (`image`), a directory of
 * that name that is not one (`not-an-image`), or nothing (`missing`).
 */
export type LauncherImageInfo =
  | {
      kind: "image";
      imagesDir: string;
      image: LauncherImage;
      /** Why `image.pids` is left out. */
      processListFailure?: string;
    }
  | { kind: "not-an-image"; imagesDir: string; notAnImage: NotAnImage }
  | { kind: "missing"; imagesDir: string };

export interface LauncherTemplate {
  name?: string;
  category?: string;
  url?: string;
  /**
   * A template the Launcher keeps on disk (`PhLLocalTemplate`): one the user
   * made from an image, or a copy of a remote template it downloaded, kept in
   * its template cache under the remote one's name. Both are in the same
   * category, and nothing in the listing tells them apart.
   */
  local?: true;
}

/** A VM running one of this Launcher's images. */
export interface LauncherProcess {
  pid: number;
  commandLine: string;
  executablePath?: string;
  /** `<images>/D/D.image`, as the command line names it. */
  imagePath: string;
  /** `D`, as the images directory spells it. */
  imageName: string;
}
