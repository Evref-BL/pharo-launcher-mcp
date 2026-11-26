import path from "node:path";

export type LauncherScriptName = "pharo-launcher.cmd" | "pharo-launcher.sh";

export interface LauncherPlatformDefaults {
  launcherDir: string;
  launcherVm: string;
  launcherImage: string;
  bundledScriptName: LauncherScriptName;
}

/**
 * The user's home: on Windows `USERPROFILE`, as Pharo's own `FileLocator home`
 * reads it, `HOME` being set there only by some shells; elsewhere `HOME`.
 */
function homeDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  return platform === "win32" ? (env.USERPROFILE ?? env.HOME) : (env.HOME ?? env.USERPROFILE);
}

/**
 * Where this package writes the logs of detached starts outside a profile: the
 * platform's place for a user's application logs, never the working
 * directory, which a client may set to `/`.
 */
export function userLogsDirectory(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const paths = pathApi(platform);
  if (platform === "win32" && env.LOCALAPPDATA) {
    return paths.join(env.LOCALAPPDATA, "pharo-launcher-mcp", "logs");
  }
  if (platform !== "win32" && platform !== "darwin" && env.XDG_STATE_HOME) {
    return paths.join(env.XDG_STATE_HOME, "pharo-launcher-mcp", "logs");
  }
  const home = homeDir(env, platform);
  if (!home) {
    return undefined;
  }
  if (platform === "darwin") {
    return paths.join(home, "Library", "Logs", "pharo-launcher-mcp");
  }
  return platform === "win32"
    ? paths.join(home, "AppData", "Local", "pharo-launcher-mcp", "logs")
    : paths.join(home, ".local", "state", "pharo-launcher-mcp", "logs");
}

/**
 * A path a caller gave, as every read of it takes it: a relative one from the
 * working directory, once and for all, and an absolute one without the
 * trailing separators that would hide a `.app` at its end.
 */
export function normalizedPath(value: string, platform: NodeJS.Platform = process.platform): string {
  // The platform's rules: on POSIX a backslash is a character of a name.
  const paths = pathApi(platform);
  if (!paths.isAbsolute(value)) {
    return path.resolve(value);
  }
  const normalized = paths.normalize(value);
  const root = paths.parse(normalized).root;
  return normalized.length > root.length ? normalized.replace(/[\\/]+$/, "") : normalized;
}

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

function pathApiForPathLike(
  platform: NodeJS.Platform,
  value: string,
): path.PlatformPath {
  if (platform === "win32") {
    return path.win32;
  }

  return /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith("\\\\") ||
    value.includes("\\")
    ? path.win32
    : path.posix;
}

export function joinPlatformPath(
  platform: NodeJS.Platform,
  ...segments: string[]
): string {
  return pathApi(platform).join(...segments);
}

export function defaultLauncherDir(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  const paths = pathApi(platform);

  if (platform === "win32") {
    if (env.LOCALAPPDATA) {
      return paths.join(env.LOCALAPPDATA, "Pharo Launcher");
    }

    if (env.USERPROFILE) {
      return paths.join(env.USERPROFILE, "AppData", "Local", "Pharo Launcher");
    }
  }

  const home = homeDir(env, platform);

  if (platform === "darwin" && home) {
    return paths.join(home, "Library", "Application Support", "Pharo Launcher");
  }

  if (home) {
    return paths.join(home, ".local", "share", "Pharo Launcher");
  }

  return "Pharo Launcher";
}

export function defaultLauncherVm(
  launcherDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const paths = pathApi(platform);

  if (platform === "win32") {
    return paths.join(launcherDir, "PharoConsole.exe");
  }

  if (platform === "darwin") {
    if (launcherDir.endsWith(".app")) {
      return pathApiForPathLike(platform, launcherDir).join(
        launcherDir,
        "Contents",
        "MacOS",
        "Pharo",
      );
    }

    return paths.join(
      launcherDir,
      "pharo-vm",
      "Pharo.app",
      "Contents",
      "MacOS",
      "Pharo",
    );
  }

  return paths.join(launcherDir, "pharo-vm", "pharo");
}

export function defaultLauncherImage(
  launcherDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const paths = pathApi(platform);

  if (platform === "darwin" && launcherDir.endsWith(".app")) {
    return pathApiForPathLike(platform, launcherDir).join(
      launcherDir,
      "Contents",
      "Resources",
      "PharoLauncher.image",
    );
  }

  return paths.join(launcherDir, "PharoLauncher.image");
}

/**
 * Where Pharo Launcher keeps the user's files: its settings, and by default its
 * images. `PlatformResolver>>launcherUserFilesLocation` answers the documents
 * folder's `Pharo` on macOS and Windows, and `UnixResolver`'s answers `~/Pharo`.
 */
export function launcherUserFilesLocation(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const home = homeDir(env, platform);
  if (!home) {
    return undefined;
  }

  return platform === "darwin" || platform === "win32"
    ? pathApi(platform).join(home, "Documents", "Pharo")
    : pathApi(platform).join(home, "Pharo");
}

export function bundledLauncherScriptName(
  platform: NodeJS.Platform = process.platform,
): LauncherScriptName {
  return platform === "win32" ? "pharo-launcher.cmd" : "pharo-launcher.sh";
}

export function launcherPlatformDefaults(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): LauncherPlatformDefaults {
  const launcherDir = defaultLauncherDir(env, platform);

  return {
    launcherDir,
    launcherVm: defaultLauncherVm(launcherDir, platform),
    launcherImage: defaultLauncherImage(launcherDir, platform),
    bundledScriptName: bundledLauncherScriptName(platform),
  };
}

export function isWindowsCommandScript(scriptPath: string): boolean {
  const extension =
    path.win32.extname(scriptPath).toLowerCase() ||
    path.posix.extname(scriptPath).toLowerCase();

  return extension === ".cmd" || extension === ".bat";
}

export function isShellScript(scriptPath: string): boolean {
  const extension =
    path.win32.extname(scriptPath).toLowerCase() ||
    path.posix.extname(scriptPath).toLowerCase();

  return extension === ".sh";
}

export function shouldRunScriptThroughCommandShell(
  scriptPath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" && isWindowsCommandScript(scriptPath);
}

export function shouldRunScriptThroughBash(
  scriptPath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== "win32" && isShellScript(scriptPath);
}

/**
 * How long a module path the VM can load.
 *
 * Pharo's FFI asks the VM to load a module by absolute path, and the VM copies
 * that path through a 256-byte buffer. A module at 256 characters or more is
 * never opened, and the failure surfaces as a missing *symbol* rather than a
 * missing file:
 *
 *     SymbolNotFoundError: Could not find symbol named: #git_libgit2_init
 *       searching in module: '…/Plugins/libgit2-1.9.1.9.0.dylib'
 *
 * Measured rather than assumed: the same profile, the same VM bytes and the
 * same script pass at 255 characters and fail at 256.
 */
export const launcherModulePathLimit = 255;

/**
 * The longest path under a VM directory, which is what has to fit.
 *
 * `/140-x64/Pharo.app/Contents/MacOS/Plugins/libgit2-1.9.1.9.0.dylib` is the
 * longest tail seen so far, and libgit2 is the module that fails first because
 * Iceberg initialises it during startup. A directory that does not exist yet
 * is measured against that tail, since it is what a download will put there.
 */
export const longestKnownVmModuleTail =
  "/140-x64/Pharo.app/Contents/MacOS/Plugins/libgit2-1.9.1.9.0.dylib".length;

export interface LauncherModulePathBudget {
  ok: boolean;
  vmsDirectory: string;
  /** The longest module path this directory holds, or would hold. */
  longestModulePath: number;
  limit: number;
  /** Characters to cut from the directory before a VM fits. */
  over: number;
  measured: boolean;
}

export function launcherModulePathBudget(
  vmsDirectory: string,
  readLongestDescendant?: (directory: string) => number | undefined,
): LauncherModulePathBudget {
  // Both, because neither alone is the worst case: a VM that is not downloaded
  // yet measures nothing, and one that is may hold a longer name than the
  // tail below.
  const measuredLongest = readLongestDescendant?.(vmsDirectory);
  const longestModulePath = Math.max(
    vmsDirectory.length + longestKnownVmModuleTail,
    measuredLongest ?? 0,
  );

  return {
    ok: longestModulePath <= launcherModulePathLimit,
    vmsDirectory,
    longestModulePath,
    limit: launcherModulePathLimit,
    over: Math.max(0, longestModulePath - launcherModulePathLimit),
    measured: measuredLongest !== undefined,
  };
}

export function launcherModulePathBudgetMessage(
  budget: LauncherModulePathBudget,
): string {
  return [
    `The VM directory is too deep for Pharo to load its modules: ${budget.vmsDirectory}`,
    `A module path may be at most ${budget.limit} characters and ${
      budget.measured ? "one there is" : "a downloaded VM would reach"
    } ${budget.longestModulePath}.`,
    `Shorten the path to that directory by at least ${budget.over} characters.`,
    "Loading one anyway fails as a missing symbol, not a missing file, which is why this is checked here.",
  ].join("\n");
}
