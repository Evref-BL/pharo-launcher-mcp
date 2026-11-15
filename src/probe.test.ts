import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LauncherCliRunner } from "./discovery.js";
import type { LauncherCliResult } from "./launcherCli.js";
import { probeImages } from "./probe.js";
import { cliMetaInf, psRunner, tempProfile, testConfig, writeImage } from "./testing/images.js";

const temporaries: string[] = [];

afterEach(() => {
  for (const directory of temporaries.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function profileHolding(names: readonly string[]) {
  const profile = tempProfile();
  temporaries.push(profile.stateRoot);
  const images = path.resolve(profile.imagesDir);
  for (const name of names) {
    writeImage(images, name, {
      metaInf: cliMetaInf(
        "Pharo 14.0 - 64bit (next stable)",
        "https://files.pharo.org/image/140/latest-64.zip",
      ),
      pharoVersion: "140",
    });
  }
  return { config: testConfig({ profile }), images };
}

function answering(result: Partial<LauncherCliResult>): {
  runner: LauncherCliRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    runner: async (args) => {
      calls.push([...args]);
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false, ...result };
    },
  };
}

const nativeProcess = { platform: "linux" as const, runCommand: psRunner([]) };

describe("--probe-images", () => {
  it("asks the Launcher for its images, then prints what image_list answers", async () => {
    const { config, images } = profileHolding(["base", "pricing"]);
    const { runner, calls } = answering({ stdout: "Name: base\nName: pricing\n" });

    const outcome = await probeImages({ config, runner, nativeProcess });

    expect(calls).toEqual([["image", "list", "--rowMode"]]);
    expect(outcome).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: [
        `2 images in ${images}, none running.`,
        'images (each pharo=14.0 architecture=64 template="Pharo 14.0 - 64bit (next stable)"):',
        "  base",
        "  pricing",
        "",
      ].join("\n"),
    });
  });

  it("exits with the Launcher's status, and shows what it wrote only then", async () => {
    const { config, images } = profileHolding([]);
    const { runner } = answering({
      exitCode: 3,
      stdout: "Reading the configuration\n",
      stderr: "Cannot read pharo-launcher-cli-config.ston",
    });

    const outcome = await probeImages({ config, runner, nativeProcess });

    expect(outcome).toEqual({
      exitCode: 3,
      stderr: "Reading the configuration\nCannot read pharo-launcher-cli-config.ston\n",
      stdout: `No images in ${images}.\n`,
    });
  });

  it("fails when the Launcher did not exit", async () => {
    const { config } = profileHolding([]);
    const { runner } = answering({ exitCode: null, timedOut: true, stderr: "Timed out" });

    const outcome = await probeImages({ config, runner, nativeProcess });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toBe("Timed out\n");
  });
});
