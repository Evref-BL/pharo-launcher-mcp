import fs from "node:fs";
import { loadPharoLauncherConfig, type PharoLauncherConfig } from "./config.js";
import { runLauncherCli, type LauncherCliResult } from "./launcherCli.js";
import {
  resolveLauncherScriptDetails,
  type ResolvedLauncherScript,
} from "./launcherScript.js";

export interface PathStatus {
  path: string;
  exists: boolean;
}

export interface PharoLauncherProfileReport {
  name: string;
  stateRoot: PathStatus;
  launcherImage: PathStatus;
  imagesDir: PathStatus;
  vmsDir: PathStatus;
  templateSourcesDir: PathStatus;
  initScriptsDir: PathStatus;
  logsDir: PathStatus;
}

export interface PharoLauncherConfigReport {
  launcherDir: PathStatus;
  launcherVm: PathStatus;
  installationLauncherImage: PathStatus;
  launcherImage: PathStatus;
  launcherScript: ResolvedLauncherScript;
  launcherConfiguration?: string;
  profile?: PharoLauncherProfileReport;
}

export interface PharoLauncherHealthReport {
  ok: boolean;
  service: "pharo-launcher-mcp";
  config: PharoLauncherConfigReport;
}

export interface PharoLauncherVersionReport {
  ok: boolean;
  version?: string;
  command: LauncherCliResult;
}

export interface PharoLauncherValidationReport {
  ok: boolean;
  config: PharoLauncherConfigReport;
  harmlessCliCall: {
    args: string[];
    ok: boolean;
    result?: LauncherCliResult;
    error?: string;
  };
}

export type LauncherCliRunner = (
  args: readonly string[],
  options?: { config?: PharoLauncherConfig; timeoutMs?: number },
) => Promise<LauncherCliResult>;

function pathStatus(path: string): PathStatus {
  return {
    path,
    exists: fs.existsSync(path),
  };
}

function getProfileReport(
  config: PharoLauncherConfig,
): PharoLauncherProfileReport | undefined {
  if (!config.profile) {
    return undefined;
  }

  return {
    name: config.profile.name,
    stateRoot: pathStatus(config.profile.stateRoot),
    launcherImage: pathStatus(config.profile.launcherImage),
    imagesDir: pathStatus(config.profile.imagesDir),
    vmsDir: pathStatus(config.profile.vmsDir),
    templateSourcesDir: pathStatus(config.profile.templateSourcesDir),
    initScriptsDir: pathStatus(config.profile.initScriptsDir),
    logsDir: pathStatus(config.profile.logsDir),
  };
}

export function getPharoLauncherConfigReport(
  config: PharoLauncherConfig = loadPharoLauncherConfig(),
): PharoLauncherConfigReport {
  return {
    launcherDir: pathStatus(config.launcherDir),
    launcherVm: pathStatus(config.launcherVm),
    installationLauncherImage: pathStatus(config.installationLauncherImage),
    launcherImage: pathStatus(config.launcherImage),
    launcherScript: resolveLauncherScriptDetails({
      launcherDir: config.launcherDir,
      env: {
        ...process.env,
        ...(config.launcherScript
          ? { PHARO_LAUNCHER_SCRIPT: config.launcherScript }
          : {}),
      },
    }),
    ...(config.launcherConfiguration
      ? { launcherConfiguration: config.launcherConfiguration }
      : {}),
    ...(config.profile ? { profile: getProfileReport(config) } : {}),
  };
}

export function getPharoLauncherHealth(
  config: PharoLauncherConfig = loadPharoLauncherConfig(),
): PharoLauncherHealthReport {
  const report = getPharoLauncherConfigReport(config);

  return {
    ok:
      report.launcherDir.exists &&
      report.launcherVm.exists &&
      report.launcherImage.exists &&
      report.launcherScript.exists,
    service: "pharo-launcher-mcp",
    config: report,
  };
}

function parseVersion(result: LauncherCliResult): string | undefined {
  const output = `${result.stdout}\n${result.stderr}`;
  const firstVersionLikeToken = output.match(/\b\d+(?:\.\d+)+(?:[-+.\w]*)?\b/);

  return firstVersionLikeToken?.[0];
}

export async function getPharoLauncherVersion(
  runner: LauncherCliRunner = runLauncherCli,
  config: PharoLauncherConfig = loadPharoLauncherConfig(),
): Promise<PharoLauncherVersionReport> {
  const command = await runner(["--version"], {
    config,
    timeoutMs: 10_000,
  });

  return {
    ok: command.exitCode === 0 && !command.timedOut,
    version: parseVersion(command),
    command,
  };
}

export async function validatePharoLauncherInstallation(
  runner: LauncherCliRunner = runLauncherCli,
  config: PharoLauncherConfig = loadPharoLauncherConfig(),
): Promise<PharoLauncherValidationReport> {
  const report = getPharoLauncherConfigReport(config);
  const args = ["--version"];

  try {
    const result = await runner(args, {
      config,
      timeoutMs: 10_000,
    });
    const harmlessCliCall = {
      args,
      ok: result.exitCode === 0 && !result.timedOut,
      result,
    };

    return {
      ok:
        report.launcherDir.exists &&
        report.launcherVm.exists &&
        report.launcherImage.exists &&
        report.launcherScript.exists &&
        harmlessCliCall.ok,
      config: report,
      harmlessCliCall,
    };
  } catch (error) {
    return {
      ok: false,
      config: report,
      harmlessCliCall: {
        args,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
