import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  launchLogPaths,
  pruneLaunchLogs,
  removeLaunchLogs,
  startsKept,
  sweepLaunchLogs,
  type LaunchLogPaths,
} from "./launchLogs.js";
import { tempDirectory } from "./testing/images.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function profileDirectories(): { logsDir: string; imagesDir: string } {
  const root = tempDirectory("pharo-launcher-mcp-launch-logs-");
  directories.push(root);
  const logsDir = path.join(root, "logs");
  const imagesDir = path.join(root, "images");
  fs.mkdirSync(logsDir);
  fs.mkdirSync(imagesDir);
  return { logsDir, imagesDir };
}

const minute = 60_000;
const firstStart = Date.parse("2026-11-03T10:49:12.354Z");

/** The pair a start writes, as a detached launch leaves it. */
function writeStart(logsDir: string, imageName: string, startTime: number): LaunchLogPaths {
  const paths = launchLogPaths(logsDir, imageName, startTime);
  fs.writeFileSync(paths.stdoutPath, "out");
  fs.writeFileSync(paths.stderrPath, "");
  return paths;
}

function logs(logsDir: string): string[] {
  return fs.readdirSync(logsDir).sort();
}

describe("launchLogPaths", () => {
  it("names a start's pair after its time and its image", () => {
    expect(launchLogPaths("/logs", "proj-task", firstStart)).toEqual({
      stdoutPath: path.join("/logs", "2026-11-03T10-49-12-354Z-proj-task-launch.out.log"),
      stderrPath: path.join("/logs", "2026-11-03T10-49-12-354Z-proj-task-launch.err.log"),
    });
  });

  it("makes what a file name cannot hold a dash", () => {
    expect(path.basename(launchLogPaths("/logs", "Pharo 13: a/b", firstStart).stdoutPath)).toBe(
      "2026-11-03T10-49-12-354Z-Pharo-13-a-b-launch.out.log",
    );
  });
});

describe("pruneLaunchLogs", () => {
  it("keeps the logs of an image's last three starts", () => {
    const { logsDir } = profileDirectories();
    const starts = [0, 1, 2, 3, 4].map((n) => writeStart(logsDir, "task", firstStart + n * minute));

    pruneLaunchLogs(logsDir, "task", starts[4]!);

    expect(startsKept).toBe(3);
    expect(logs(logsDir)).toEqual(
      starts
        .slice(2)
        .flatMap((start) => [start.stderrPath, start.stdoutPath].map((file) => path.basename(file)))
        .sort(),
    );
  });

  it("keeps the current start's logs when the clock went back", () => {
    const { logsDir } = profileDirectories();
    [1, 2, 3].forEach((n) => writeStart(logsDir, "task", firstStart + n * minute));
    const current = writeStart(logsDir, "task", firstStart);

    pruneLaunchLogs(logsDir, "task", current);

    expect(fs.existsSync(current.stdoutPath)).toBe(true);
    expect(fs.existsSync(current.stderrPath)).toBe(true);
  });

  it("leaves other images' logs, and files that are not a start's", () => {
    const { logsDir } = profileDirectories();
    const other = writeStart(logsDir, "task-2", firstStart);
    const named = writeStart(logsDir, "task-launch", firstStart);
    fs.writeFileSync(path.join(logsDir, "notes.txt"), "");
    const starts = [1, 2, 3, 4].map((n) => writeStart(logsDir, "task", firstStart + n * minute));

    pruneLaunchLogs(logsDir, "task", starts[3]!);

    expect(fs.existsSync(other.stdoutPath)).toBe(true);
    expect(fs.existsSync(named.stdoutPath)).toBe(true);
    expect(fs.existsSync(path.join(logsDir, "notes.txt"))).toBe(true);
    expect(fs.existsSync(starts[0]!.stdoutPath)).toBe(false);
  });

  it("counts the starts of a name written in another case as the same image's", () => {
    const { logsDir } = profileDirectories();
    const oldest = writeStart(logsDir, "Task", firstStart);
    [1, 2].forEach((n) => writeStart(logsDir, "TASK", firstStart + n * minute));
    const current = writeStart(logsDir, "task", firstStart + 3 * minute);

    pruneLaunchLogs(logsDir, "task", current);

    expect(fs.existsSync(oldest.stdoutPath)).toBe(false);
    expect(logs(logsDir)).toHaveLength(2 * startsKept);
  });

  it("does nothing where there is no logs directory", () => {
    const { logsDir } = profileDirectories();
    const missing = path.join(logsDir, "missing");

    expect(() =>
      pruneLaunchLogs(missing, "task", launchLogPaths(missing, "task", firstStart)),
    ).not.toThrow();
  });
});

describe("sweepLaunchLogs", () => {
  it("removes the logs of images the images directory no longer holds", () => {
    const { logsDir, imagesDir } = profileDirectories();
    fs.mkdirSync(path.join(imagesDir, "kept"));
    const kept = writeStart(logsDir, "kept", firstStart);
    const gone = writeStart(logsDir, "gone", firstStart);
    fs.writeFileSync(path.join(logsDir, "notes.txt"), "");

    sweepLaunchLogs(logsDir, imagesDir);

    expect(fs.existsSync(kept.stdoutPath)).toBe(true);
    expect(fs.existsSync(kept.stderrPath)).toBe(true);
    expect(fs.existsSync(gone.stdoutPath)).toBe(false);
    expect(fs.existsSync(gone.stderrPath)).toBe(false);
    expect(fs.existsSync(path.join(logsDir, "notes.txt"))).toBe(true);
  });

  it("keeps the logs of a directory that is not an image yet, and matches names ignoring case", () => {
    const { logsDir, imagesDir } = profileDirectories();
    fs.mkdirSync(path.join(imagesDir, "Being-Made"));
    fs.mkdirSync(path.join(imagesDir, "with space"));
    const beingMade = writeStart(logsDir, "being-made", firstStart);
    const spaced = writeStart(logsDir, "with space", firstStart);

    sweepLaunchLogs(logsDir, imagesDir);

    expect(fs.existsSync(beingMade.stdoutPath)).toBe(true);
    expect(fs.existsSync(spaced.stdoutPath)).toBe(true);
  });

  it("removes nothing when the images directory cannot be read", () => {
    const { logsDir, imagesDir } = profileDirectories();
    const log = writeStart(logsDir, "task", firstStart);

    sweepLaunchLogs(logsDir, path.join(imagesDir, "missing"));

    expect(fs.existsSync(log.stdoutPath)).toBe(true);
  });
});

describe("removeLaunchLogs", () => {
  it("removes every log of an image that is gone, and no other's", () => {
    const { logsDir, imagesDir } = profileDirectories();
    const starts = [0, 1].map((n) => writeStart(logsDir, "task", firstStart + n * minute));
    const other = writeStart(logsDir, "task-2", firstStart);

    removeLaunchLogs(logsDir, imagesDir, "TASK");

    for (const start of starts) {
      expect(fs.existsSync(start.stdoutPath)).toBe(false);
      expect(fs.existsSync(start.stderrPath)).toBe(false);
    }
    expect(fs.existsSync(other.stdoutPath)).toBe(true);
  });

  it("keeps the logs an image still in the images directory writes under the same name", () => {
    const { logsDir, imagesDir } = profileDirectories();
    fs.mkdirSync(path.join(imagesDir, "my-image"));
    const shared = writeStart(logsDir, "my image", firstStart);

    removeLaunchLogs(logsDir, imagesDir, "my image");

    expect(fs.existsSync(shared.stdoutPath)).toBe(true);
  });
});
