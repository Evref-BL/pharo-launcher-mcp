import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundledLauncherScriptName } from "./platform.js";

export interface ResolveLauncherScriptOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  launcherDir: string;
}

export type LauncherScriptSource = "env" | "bundled" | "none";

export interface LauncherScriptCandidate {
  path: string;
  source: Exclude<LauncherScriptSource, "none">;
  exists: boolean;
}

export interface ResolvedLauncherScript {
  path?: string;
  source: LauncherScriptSource;
  exists: boolean;
  candidates: LauncherScriptCandidate[];
}

export function bundledLauncherScriptPath(
  platform: NodeJS.Platform = process.platform,
): string {
  const scriptName = bundledLauncherScriptName(platform);
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));

  return path.resolve(moduleDir, "..", "bin", scriptName);
}

export function candidateLauncherScriptPaths(
  options: ResolveLauncherScriptOptions,
): string[] {
  return candidateLauncherScripts(options).map((candidate) => candidate.path);
}

export function candidateLauncherScripts(
  options: ResolveLauncherScriptOptions,
): LauncherScriptCandidate[] {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const candidates: Array<{
    path: string;
    source: Exclude<LauncherScriptSource, "none">;
  }> = [
    ...(env.PHARO_LAUNCHER_SCRIPT
      ? [{ path: env.PHARO_LAUNCHER_SCRIPT, source: "env" as const }]
      : []),
    { path: bundledLauncherScriptPath(platform), source: "bundled" },
  ];

  return candidates.map((candidate) => ({
    ...candidate,
    exists: fs.existsSync(candidate.path),
  }));
}

export function resolveLauncherScriptDetails(
  options: ResolveLauncherScriptOptions,
): ResolvedLauncherScript {
  const candidates = candidateLauncherScripts(options);
  const selected = candidates.find((candidate) => candidate.exists);

  if (!selected) {
    return {
      source: "none",
      exists: false,
      candidates,
    };
  }

  return {
    path: selected.path,
    source: selected.source,
    exists: true,
    candidates,
  };
}

export function resolveLauncherScript(
  options: ResolveLauncherScriptOptions,
): string | undefined {
  return resolveLauncherScriptDetails(options).path;
}
