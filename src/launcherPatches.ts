import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * What the profile's copy of the launcher image is changed with, once, so that
 * its command line can create images from templates hosted on GitHub.
 *
 * - github.com answers a release asset with a header line longer than the
 *   4096 characters Zinc reads, so the download fails.
 * - A failed download opens a retry dialog, which nobody can answer in a
 *   headless command: the command never ends. It now fails, saying why.
 *
 * Each change is skipped when what it changes is missing, so a launcher that
 * fixed or renamed it loads as it is.
 */
export const launcherPatchesScript = `| zinc downloads |
zinc := Smalltalk globals at: #ZnConstants ifAbsent: [ nil ].
(zinc notNil and: [ (zinc respondsTo: #maximumLineLength) and: [ zinc maximumLineLength < 65536 ] ]) ifTrue: [
	zinc class
		compile: 'maximumLineLength
	"github.com sends header lines longer than 4096 characters."

	^ 65536'
		classified: 'constants' ].
downloads := Smalltalk globals at: #PhLDownloadManager ifAbsent: [ nil ].
(downloads notNil and: [ (downloads includesSelector: #download:toFile:) and: [ downloads includesSelector: #basicDownload:toFile: ] ]) ifTrue: [
	downloads
		compile: 'download: url toFile: file
	"A headless launcher cannot answer a retry dialog, so a failed download fails the command, saying why."

	[ self basicDownload: url toFile: file ]
		on: PhLDownloadError
		do: [ :error |
			Stdio stderr nextPutAll: error longDescription; lf; flush.
			error pass ]'
		classified: 'downloading' ].
Smalltalk snapshot: true andQuit: true
`;

/** Names this set of changes; a profile recorded with another is changed again. */
export const launcherPatchesName = "github-downloads-1";

const recordFileName = "pharo-launcher-mcp-patches";
const patchTimeoutMs = 120_000;

export interface PatchRun {
  status: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}

/** Runs the launcher VM on an image with a script; tests give their own. */
export type PatchRunner = (vm: string, args: string[], cwd: string) => PatchRun;

function runVm(vm: string, args: string[], cwd: string): PatchRun {
  const result = spawnSync(vm, args, {
    cwd,
    encoding: "utf8",
    timeout: patchTimeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.error ? { error: result.error } : {}),
  };
}

function changesOf(imagePath: string): string {
  return imagePath.replace(/\.image$/i, ".changes");
}

export function launcherPatchesRecord(launcherImage: string): string {
  return path.join(path.dirname(launcherImage), recordFileName);
}

function recorded(launcherImage: string): boolean {
  try {
    return fs.readFileSync(launcherPatchesRecord(launcherImage), "utf8").trim() === launcherPatchesName;
  } catch {
    return false;
  }
}

/**
 * Changes the profile's launcher image unless its record names these changes.
 * The image is changed as a copy beside it, which then replaces it, so a
 * command reading the image meanwhile reads it whole, before or after.
 */
export function ensureLauncherPatches(
  launcherVm: string,
  launcherImage: string,
  run: PatchRunner = runVm,
): void {
  if (recorded(launcherImage)) {
    return;
  }

  const directory = path.dirname(launcherImage);
  const stem = `${recordFileName}-${process.pid}`;
  const copy = path.join(directory, `${stem}.image`);
  const script = path.join(directory, `${stem}.st`);
  const changes = changesOf(launcherImage);
  try {
    fs.copyFileSync(launcherImage, copy);
    if (fs.existsSync(changes)) {
      fs.copyFileSync(changes, changesOf(copy));
    }
    fs.writeFileSync(script, launcherPatchesScript, "utf8");

    const result = run(
      launcherVm,
      ["--headless", copy, "--no-default-preferences", "st", script],
      directory,
    );
    if (result.error || result.status !== 0) {
      throw new Error(
        [
          "Could not prepare the profile's launcher image for downloads from GitHub.",
          `image: ${launcherImage}`,
          result.error
            ? `error: ${result.error.message}`
            : `exit: ${result.status ?? result.signal}`,
          ...(result.stderr?.trim() ? [`stderr: ${result.stderr.trim()}`] : []),
        ].join("\n"),
      );
    }

    if (fs.existsSync(changesOf(copy))) {
      fs.renameSync(changesOf(copy), changes);
    }
    fs.renameSync(copy, launcherImage);
    fs.writeFileSync(launcherPatchesRecord(launcherImage), `${launcherPatchesName}\n`, "utf8");
  } finally {
    for (const leftover of [copy, changesOf(copy), script]) {
      fs.rmSync(leftover, { force: true });
    }
  }
}
