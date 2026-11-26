/** How a Launcher command ended. */
export interface LauncherCommandRun {
  durationMs: number;
  exitCode: number | null;
  /** The signal that ended the command, which then has no exit code. */
  signal?: NodeJS.Signals;
  /** Whether it ran past the call's time, and was stopped. */
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
  /** Why the call failed, in the Launcher's words or this package's. */
  diagnostic?: string;
  /** What to do about it, when something can be done. */
  action?: string;
  command: LauncherCommandRun;
}

/** A start: what it ran, once it ran something. */
export interface StartImageResult extends LauncherCommandResult {
  launch?: LauncherLaunchReport;
}

/** A kill: the pids it killed, and those it could not. */
export type KillProcessResult = LauncherCommandResult<{
  killed: number[];
  failures: Array<{ pid: number; message: string }>;
}>;

/** A template listing; `failure` says when the category does not exist. */
export type TemplateListResult = LauncherCommandResult<LauncherTemplate[]> & {
  failure?: { kind: "unknown-category" };
};

/**
 * What a template update did to a profile's sources.list: downloaded it where
 * there was none (`created`), replaced it with a newer one (`updated`), found
 * it current (`unchanged`), kept it when the download failed (`kept`), or
 * failed with none to keep (`failed`).
 */
export interface TemplateSources {
  outcome: "created" | "updated" | "unchanged" | "kept" | "failed";
  path: string;
  url: string;
  /** Why the download failed, for `kept` and `failed`. */
  error?: string;
}

/**
 * A template update. In a profile it downloads the profile's sources.list,
 * which `sources` reports; outside one the Launcher keeps its own.
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
 * Why a create or copy made no image. The Launcher knew no such template
 * (`unknown-template`) or category (`unknown-category`). Or its command exited
 * 0, and by the time the check gave up the images directory never held the
 * image under its name, in profile mode (`not-listed`), or in any mode the
 * Launcher's `image info` could not open it (`not-opened`), `message` being
 * what it said.
 */
export type MadeImageFailure =
  | { kind: "unknown-template" }
  | { kind: "unknown-category" }
  | {
      kind: "not-listed";
      /** `<images>/<name>`. */
      directory: string;
      /** What the directory lacks, when it exists. */
      notAnImage?: NotAnImage;
      /** How long the check waited. */
      seconds: number;
    }
  | { kind: "not-opened"; message: string };

/**
 * A create or copy. Its `data` is `{ image?: LauncherImage }`, the image when
 * the images directory holds it; `failure` says why it made none, when that is
 * known, beside `diagnostic`, so a caller writes its own sentence.
 */
export type MadeImageResult = LauncherCommandResult<{ image?: LauncherImage }> & {
  failure?: MadeImageFailure;
};

/** A category listing, with the category the Launcher marks as its default. */
export interface TemplateCategoriesResult extends LauncherCommandResult<string[]> {
  defaultCategory?: string;
}

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
  /** The VMs running it; left out when the process list failed. */
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
  processListFailure?: string;
}

export type LauncherImageInfo =
  | {
      found: true;
      imagesDir: string;
      image: LauncherImage;
      processListFailure?: string;
    }
  | { found: false; imagesDir: string; notAnImage?: NotAnImage };

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

export interface LauncherProcess {
  pid: number;
  commandLine: string;
  executablePath?: string;
  imagePath?: string;
  imageName?: string;
}
