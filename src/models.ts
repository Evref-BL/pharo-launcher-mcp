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

export interface LauncherImage {
  name?: string;
  architecture?: string;
  pharoVersion?: string;
  formatNumber?: number;
  imagePath?: string;
  originTemplate?: {
    name?: string;
    url?: string;
  };
  vmId?: string;
}

export interface LauncherTemplate {
  name?: string;
  category?: string;
  url?: string;
}

export interface LauncherVm {
  id?: string;
  name?: string;
  architecture?: string;
  executablePath?: string;
  status?: string;
  blessing?: string;
}

export interface LauncherProcess {
  pid: number;
  commandLine: string;
  executablePath?: string;
  imagePath?: string;
  imageName?: string;
}
