import path from "node:path";
import {
  defaultLauncherVm,
  joinPlatformPath,
  launcherPlatformDefaults,
} from "./platform.js";

export interface PharoLauncherProfileConfig {
  name: string;
  stateRoot: string;
  launcherImage: string;
  imagesDir: string;
  vmsDir: string;
  templateSourcesDir: string;
  initScriptsDir: string;
  logsDir: string;
}

export interface PharoLauncherConfig {
  launcherDir: string;
  launcherVm: string;
  installationLauncherImage: string;
  launcherImage: string;
  launcherScript?: string;
  launcherConfiguration?: string;
  profile?: PharoLauncherProfileConfig;
}

function isAbsolutePlatformPath(
  value: string,
  platform: NodeJS.Platform,
): boolean {
  return platform === "win32"
    ? path.win32.isAbsolute(value)
    : path.posix.isAbsolute(value);
}

function shouldUseProfile(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.PHARO_LAUNCHER_MCP_PROFILE ||
      env.PHARO_LAUNCHER_MCP_STATE_ROOT ||
      env.PHARO_LAUNCHER_MCP_LAUNCHER_IMAGE ||
      env.PHARO_LAUNCHER_MCP_IMAGES_DIR ||
      env.PHARO_LAUNCHER_MCP_VMS_DIR ||
      env.PHARO_LAUNCHER_MCP_TEMPLATE_SOURCES_DIR ||
      env.PHARO_LAUNCHER_MCP_INIT_SCRIPTS_DIR ||
      env.PHARO_LAUNCHER_MCP_LOGS_DIR,
  );
}

function profileLauncherConfigurationPath(
  profile: PharoLauncherProfileConfig,
  platform: NodeJS.Platform,
): string {
  return joinPlatformPath(
    platform,
    profile.stateRoot,
    "launcher",
    "pharo-launcher-cli-config.ston",
  );
}

function launcherConfigurationPath(
  env: NodeJS.ProcessEnv,
  profile: PharoLauncherProfileConfig | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  const configured = env.PHARO_LAUNCHER_MCP_LAUNCHER_CONFIGURATION;
  if (!configured) {
    return profile
      ? profileLauncherConfigurationPath(profile, platform)
      : undefined;
  }

  if (profile && !isAbsolutePlatformPath(configured, platform)) {
    return joinPlatformPath(platform, profile.stateRoot, "launcher", configured);
  }

  return configured;
}

function loadProfileConfig(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): PharoLauncherProfileConfig | undefined {
  if (!shouldUseProfile(env)) {
    return undefined;
  }

  const name = env.PHARO_LAUNCHER_MCP_PROFILE ?? "default";
  const stateRoot =
    env.PHARO_LAUNCHER_MCP_STATE_ROOT ??
    path.join(process.cwd(), ".pharo-launcher-mcp", name);

  return {
    name,
    stateRoot,
    launcherImage:
      env.PHARO_LAUNCHER_MCP_LAUNCHER_IMAGE ??
      joinPlatformPath(platform, stateRoot, "launcher", "PharoLauncher.image"),
    imagesDir:
      env.PHARO_LAUNCHER_MCP_IMAGES_DIR ??
      joinPlatformPath(platform, stateRoot, "images"),
    vmsDir:
      env.PHARO_LAUNCHER_MCP_VMS_DIR ??
      joinPlatformPath(platform, stateRoot, "vms"),
    templateSourcesDir:
      env.PHARO_LAUNCHER_MCP_TEMPLATE_SOURCES_DIR ??
      joinPlatformPath(platform, stateRoot, "templates"),
    initScriptsDir:
      env.PHARO_LAUNCHER_MCP_INIT_SCRIPTS_DIR ??
      joinPlatformPath(platform, stateRoot, "init-scripts"),
    logsDir:
      env.PHARO_LAUNCHER_MCP_LOGS_DIR ??
      joinPlatformPath(platform, stateRoot, "logs"),
  };
}

export function loadPharoLauncherConfig(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): PharoLauncherConfig {
  const defaults = launcherPlatformDefaults(env, platform);
  const launcherDir = env.PHARO_LAUNCHER_DIR ?? defaults.launcherDir;
  const launcherVm =
    env.PHARO_LAUNCHER_VM ?? defaultLauncherVm(launcherDir, platform);
  const installationLauncherImage =
    env.PHARO_LAUNCHER_IMAGE ??
    joinPlatformPath(platform, launcherDir, "PharoLauncher.image");
  const profile = loadProfileConfig(env, platform);
  const launcherConfiguration = launcherConfigurationPath(
    env,
    profile,
    platform,
  );

  return {
    launcherDir,
    launcherVm,
    installationLauncherImage,
    launcherImage: profile?.launcherImage ?? installationLauncherImage,
    ...(env.PHARO_LAUNCHER_SCRIPT
      ? { launcherScript: env.PHARO_LAUNCHER_SCRIPT }
      : {}),
    ...(launcherConfiguration ? { launcherConfiguration } : {}),
    ...(profile ? { profile } : {}),
  };
}
