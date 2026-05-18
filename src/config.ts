import fs from "node:fs";
import path from "node:path";
import {
  defaultLauncherImage,
  defaultLauncherVm,
  joinPlatformPath,
  launcherPlatformDefaults,
} from "./platform.js";

export type PharoLauncherInstallationSource =
  | "env"
  | "macos-user-app"
  | "macos-system-app"
  | "platform-default";

export interface PharoLauncherInstallationCandidate {
  source: PharoLauncherInstallationSource;
  launcherDir: string;
  launcherVm: string;
  installationLauncherImage: string;
}

export interface PharoLauncherInstallationDiscovery {
  source: PharoLauncherInstallationSource;
  selected: PharoLauncherInstallationCandidate;
  candidates: PharoLauncherInstallationCandidate[];
}

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
  discovery?: PharoLauncherInstallationDiscovery;
}

export interface MacOSAppBundleCandidate {
  source: "macos-user-app" | "macos-system-app";
  path: string;
}

export interface LoadPharoLauncherConfigOptions {
  macOSAppBundleCandidates?: readonly MacOSAppBundleCandidate[];
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

function launcherInstallationCandidate(
  source: PharoLauncherInstallationSource,
  launcherDir: string,
  platform: NodeJS.Platform,
): PharoLauncherInstallationCandidate {
  return {
    source,
    launcherDir,
    launcherVm: defaultLauncherVm(launcherDir, platform),
    installationLauncherImage: defaultLauncherImage(launcherDir, platform),
  };
}

function defaultMacOSAppBundleCandidates(
  env: NodeJS.ProcessEnv,
): MacOSAppBundleCandidate[] {
  const home = env.HOME ?? env.USERPROFILE;

  return [
    ...(home
      ? [
          {
            source: "macos-user-app" as const,
            path: path.posix.join(home, "Applications", "PharoLauncher.app"),
          },
        ]
      : []),
    {
      source: "macos-system-app",
      path: "/Applications/PharoLauncher.app",
    },
  ];
}

function candidateExists(candidate: PharoLauncherInstallationCandidate): boolean {
  return (
    fs.existsSync(candidate.launcherDir) &&
    fs.existsSync(candidate.launcherVm) &&
    fs.existsSync(candidate.installationLauncherImage)
  );
}

function hasInstallationOverride(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.PHARO_LAUNCHER_DIR ||
      env.PHARO_LAUNCHER_VM ||
      env.PHARO_LAUNCHER_IMAGE,
  );
}

function discoverLauncherInstallation(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  options: LoadPharoLauncherConfigOptions,
): PharoLauncherInstallationDiscovery {
  const defaults = launcherPlatformDefaults(env, platform);
  const platformDefault = {
    source: "platform-default" as const,
    launcherDir: defaults.launcherDir,
    launcherVm: defaults.launcherVm,
    installationLauncherImage: defaults.launcherImage,
  };
  const macOSAppCandidates =
    platform === "darwin"
      ? (options.macOSAppBundleCandidates ??
        defaultMacOSAppBundleCandidates(env)).map((candidate) =>
          launcherInstallationCandidate(candidate.source, candidate.path, platform),
        )
      : [];
  const baseCandidate =
    macOSAppCandidates.find(candidateExists) ?? platformDefault;
  const envCandidate: PharoLauncherInstallationCandidate = {
    source: "env",
    launcherDir: env.PHARO_LAUNCHER_DIR ?? baseCandidate.launcherDir,
    launcherVm:
      env.PHARO_LAUNCHER_VM ??
      defaultLauncherVm(
        env.PHARO_LAUNCHER_DIR ?? baseCandidate.launcherDir,
        platform,
      ),
    installationLauncherImage:
      env.PHARO_LAUNCHER_IMAGE ??
      defaultLauncherImage(
        env.PHARO_LAUNCHER_DIR ?? baseCandidate.launcherDir,
        platform,
      ),
  };
  const candidates = [
    ...(hasInstallationOverride(env) ? [envCandidate] : []),
    ...macOSAppCandidates,
    platformDefault,
  ];
  const selected = hasInstallationOverride(env) ? envCandidate : baseCandidate;

  return {
    source: selected.source,
    selected,
    candidates,
  };
}

export function loadPharoLauncherConfig(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  options: LoadPharoLauncherConfigOptions = {},
): PharoLauncherConfig {
  const discovery = discoverLauncherInstallation(env, platform, options);
  const launcherDir = discovery.selected.launcherDir;
  const launcherVm = discovery.selected.launcherVm;
  const installationLauncherImage =
    discovery.selected.installationLauncherImage;
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
    discovery,
  };
}
