import path from "node:path";

export type LauncherScriptName = "pharo-launcher.cmd" | "pharo-launcher.sh";

export interface LauncherPlatformDefaults {
  launcherDir: string;
  launcherVm: string;
  launcherImage: string;
  bundledScriptName: LauncherScriptName;
}

function homeDir(env: NodeJS.ProcessEnv): string | undefined {
  return env.HOME ?? env.USERPROFILE;
}

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
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

  const home = homeDir(env);

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
      return paths.join(launcherDir, "Contents", "MacOS", "Pharo");
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
    return paths.join(
      launcherDir,
      "Contents",
      "Resources",
      "PharoLauncher.image",
    );
  }

  return paths.join(launcherDir, "PharoLauncher.image");
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
