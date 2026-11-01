import fs from "node:fs";
import path from "node:path";
import {
  loadPharoLauncherConfig,
  type PharoLauncherConfig,
  type PharoLauncherInstallationCandidate,
  type PharoLauncherInstallationSource,
} from "./config.js";
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

export interface PharoLauncherInstallationCandidateReport {
  source: PharoLauncherInstallationSource;
  launcherDir: PathStatus;
  launcherVm: PathStatus;
  installationLauncherImage: PathStatus;
  usable: boolean;
}

export interface PharoLauncherInstallationDiscoveryReport {
  source: PharoLauncherInstallationSource;
  selected: PharoLauncherInstallationCandidateReport;
  candidates: PharoLauncherInstallationCandidateReport[];
}

export interface PharoLauncherConfigReport {
  discovery: PharoLauncherInstallationDiscoveryReport;
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

function installationCandidateReport(
  candidate: PharoLauncherInstallationCandidate,
): PharoLauncherInstallationCandidateReport {
  const launcherDir = pathStatus(candidate.launcherDir);
  const launcherVm = pathStatus(candidate.launcherVm);
  const installationLauncherImage = pathStatus(
    candidate.installationLauncherImage,
  );

  return {
    source: candidate.source,
    launcherDir,
    launcherVm,
    installationLauncherImage,
    usable:
      launcherDir.exists &&
      launcherVm.exists &&
      installationLauncherImage.exists,
  };
}

function installationDiscoveryReport(
  config: PharoLauncherConfig,
): PharoLauncherInstallationDiscoveryReport {
  const fallbackCandidate: PharoLauncherInstallationCandidate = {
    source: "env",
    launcherDir: config.launcherDir,
    launcherVm: config.launcherVm,
    installationLauncherImage: config.installationLauncherImage,
  };
  const discovery = config.discovery ?? {
    source: fallbackCandidate.source,
    selected: fallbackCandidate,
    candidates: [fallbackCandidate],
  };

  return {
    source: discovery.source,
    selected: installationCandidateReport(discovery.selected),
    candidates: discovery.candidates.map(installationCandidateReport),
  };
}

export function getPharoLauncherConfigReport(
  config: PharoLauncherConfig = loadPharoLauncherConfig(),
): PharoLauncherConfigReport {
  return {
    discovery: installationDiscoveryReport(config),
    launcherDir: pathStatus(config.launcherDir),
    launcherVm: pathStatus(config.launcherVm),
    installationLauncherImage: pathStatus(config.installationLauncherImage),
    launcherImage: pathStatus(config.launcherImage),
    launcherScript: resolveLauncherScriptDetails({
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

function isVersionTokenCharacter(char: string): boolean {
  return (
    (char >= "0" && char <= "9") ||
    (char >= "A" && char <= "Z") ||
    (char >= "a" && char <= "z") ||
    char === "." ||
    char === "-" ||
    char === "+" ||
    char === "_"
  );
}

function isVersionLikeToken(token: string): boolean {
  let digitCount = 0;
  let dotCount = 0;

  for (const char of token) {
    if (char >= "0" && char <= "9") {
      digitCount += 1;
    } else if (char === ".") {
      dotCount += 1;
    }
  }

  return digitCount > 0 && dotCount > 0 && token[0] !== "." && token.at(-1) !== ".";
}

function firstVersionLikeToken(output: string): string | undefined {
  let tokenStart: number | undefined;

  for (let index = 0; index <= output.length; index += 1) {
    const char = output[index];
    if (char !== undefined && isVersionTokenCharacter(char)) {
      tokenStart ??= index;
      continue;
    }

    if (tokenStart === undefined) {
      continue;
    }

    const token = output.slice(tokenStart, index);
    if (isVersionLikeToken(token)) {
      return token;
    }
    tokenStart = undefined;
  }

  return undefined;
}

function parseVersion(result: LauncherCliResult): string | undefined {
  const output = `${result.stdout}\n${result.stderr}`;
  return firstVersionLikeToken(output);
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
