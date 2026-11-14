export type LauncherOutputFormat = "ston" | "text";

export interface LauncherCommandResult<T = unknown> {
  ok: boolean;
  data?: T;
  diagnostic?: string;
  action?: string;
  parser: {
    status: "parsed" | "unsupported" | "failed" | "skipped";
    format: LauncherOutputFormat;
    message?: string;
  };
  raw?: {
    stdout: string;
    stderr: string;
    format: LauncherOutputFormat;
  };
  command: {
    args: string[];
    durationMs: number;
    exitCode: number | null;
    timedOut: boolean;
    timeoutReason?: string;
  };
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
  /** meta-inf.ston's `#pharoVersion`, else `D/pharo.version`, as written. */
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
}

export interface LauncherProcess {
  pid: number;
  commandLine: string;
  executablePath?: string;
  imagePath?: string;
  imageName?: string;
}
