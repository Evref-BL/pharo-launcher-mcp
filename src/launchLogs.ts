/**
 * The files a detached start writes its VM's output to: one pair per start,
 * `<start time>-<image>-launch.out.log` and `.err.log`, in the logs
 * directory.
 *
 * They exist to say why a start failed, so they are kept as long as that can
 * matter: an image keeps the logs of its last `startsKept` starts, and its
 * logs go with it. A start never removes its own.
 *
 * The start time is fixed width, so names sort by time. The image part is the
 * image's name with what a file name cannot hold made `-`, so two names can
 * share it; it is matched ignoring case, as the Launcher finds images.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PharoLauncherConfig } from "./config.js";

/**
 * How many of an image's starts keep their logs: the latest, which a running
 * VM writes or a failed start's answer names, and two before it, so that the
 * logs of a failed start outlive two retries.
 */
export const startsKept = 3;

export interface LaunchLogPaths {
  stdoutPath: string;
  stderrPath: string;
}

const logFileName =
  /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-(.+)-launch\.(?:out|err)\.log$/;

/**
 * Where detached starts write: the profile's logs directory, else the user's
 * logs directory for this package, else one under the system's temporary
 * directory. Never the working directory, which a client may set to `/`.
 */
export function launchLogsDirectory(config: PharoLauncherConfig): string {
  return (
    config.profile?.logsDir ??
    config.userLogsDir ??
    path.join(os.tmpdir(), "pharo-launcher-mcp", "logs")
  );
}

function fileSegment(imageName: string): string {
  const cleaned = imageName.replaceAll(/[^A-Za-z0-9._-]+/g, "-");
  return cleaned.length > 0 ? cleaned : "image";
}

/** What an image's name and its logs' names are compared by. */
function matchKey(imageName: string): string {
  return fileSegment(imageName).toLowerCase();
}

function startStamp(startTime: number): string {
  return new Date(startTime).toISOString().replaceAll(/[:.]/g, "-");
}

/** The two files a start of this image at this time writes. */
export function launchLogPaths(
  logsDir: string,
  imageName: string,
  startTime: number,
): LaunchLogPaths {
  const baseName = `${startStamp(startTime)}-${fileSegment(imageName)}-launch`;
  return {
    stdoutPath: path.join(logsDir, `${baseName}.out.log`),
    stderrPath: path.join(logsDir, `${baseName}.err.log`),
  };
}

interface LaunchLog {
  file: string;
  start: string;
  key: string;
}

function readLaunchLogs(logsDir: string): LaunchLog[] {
  let names: string[];
  try {
    names = fs.readdirSync(logsDir);
  } catch {
    return [];
  }

  return names.flatMap((name) => {
    const match = logFileName.exec(name);
    return match
      ? [{ file: path.join(logsDir, name), start: match[1], key: match[2].toLowerCase() }]
      : [];
  });
}

/**
 * The keys of every entry of the images directory, image or not: a directory
 * a create is still filling keeps its logs. Nothing when it cannot be read,
 * since then nothing is known to be gone.
 */
function imagesDirectoryKeys(imagesDir: string): Set<string> | undefined {
  try {
    return new Set(fs.readdirSync(imagesDir).map(matchKey));
  } catch {
    return undefined;
  }
}

// A file that cannot go now (Windows keeps open files) goes at a later start.
function removeLogs(logs: readonly LaunchLog[]): void {
  for (const log of logs) {
    try {
      fs.rmSync(log.file, { force: true });
    } catch {
      // Left for the next start.
    }
  }
}

/**
 * Remove the logs of this image's starts but the last `startsKept`, and never
 * those of the start that wrote `current`, whatever the clock said.
 */
export function pruneLaunchLogs(
  logsDir: string,
  imageName: string,
  current: LaunchLogPaths,
): void {
  const key = matchKey(imageName);
  const currentStart = logFileName.exec(path.basename(current.stdoutPath))?.[1];
  const ours = readLaunchLogs(logsDir).filter((log) => log.key === key);
  const starts = [...new Set(ours.map((log) => log.start))].sort().reverse();
  const kept = new Set([
    ...starts.slice(0, startsKept),
    ...(currentStart ? [currentStart] : []),
  ]);
  removeLogs(ours.filter((log) => !kept.has(log.start)));
}

/**
 * Remove the logs of images the images directory no longer holds. The logs
 * are read first: one written after that is a start's, whose image was there.
 */
export function sweepLaunchLogs(logsDir: string, imagesDir: string): void {
  const logs = readLaunchLogs(logsDir);
  if (logs.length === 0) {
    return;
  }

  const present = imagesDirectoryKeys(imagesDir);
  if (present) {
    removeLogs(logs.filter((log) => !present.has(log.key)));
  }
}

/**
 * Remove the logs of an image that is gone. They are left when the images
 * directory still holds an image whose logs have the same name, which are
 * then that image's too.
 */
export function removeLaunchLogs(
  logsDir: string,
  imagesDir: string,
  imageName: string,
): void {
  const key = matchKey(imageName);
  if (imagesDirectoryKeys(imagesDir)?.has(key)) {
    return;
  }

  removeLogs(readLaunchLogs(logsDir).filter((log) => log.key === key));
}
