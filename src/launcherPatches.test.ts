import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureLauncherPatches,
  launcherPatchesName,
  launcherPatchesRecord,
  launcherPatchesScript,
  type PatchRunner,
} from "./launcherPatches.js";

const roots: string[] = [];

function launcherImage(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-launcher-mcp-patches-"));
  roots.push(root);
  const image = path.join(root, "PharoLauncher.image");
  fs.writeFileSync(image, "image", "utf8");
  fs.writeFileSync(path.join(root, "PharoLauncher.changes"), "changes", "utf8");
  return image;
}

/** A VM that saves the image it was given as patched, and its changes. */
function savingRunner(calls: string[][]): PatchRunner {
  return (_vm, args) => {
    calls.push(args);
    const image = args[1];
    fs.writeFileSync(image, "patched image", "utf8");
    fs.writeFileSync(image.replace(/\.image$/, ".changes"), "patched changes", "utf8");
    return { status: 0 };
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("ensureLauncherPatches", () => {
  it("patches a copy, which replaces the image, and records it", () => {
    const image = launcherImage();
    const calls: string[][] = [];

    ensureLauncherPatches("/vm/pharo", image, savingRunner(calls));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 1)).toEqual(["--headless"]);
    expect(calls[0]?.[1]).not.toBe(image);
    expect(calls[0]?.slice(2, 4)).toEqual(["--no-default-preferences", "st"]);
    expect(fs.readFileSync(image, "utf8")).toBe("patched image");
    expect(fs.readFileSync(image.replace(/\.image$/, ".changes"), "utf8")).toBe("patched changes");
    expect(fs.readFileSync(launcherPatchesRecord(image), "utf8").trim()).toBe(launcherPatchesName);
    expect(fs.readdirSync(path.dirname(image)).sort()).toEqual(
      ["PharoLauncher.changes", "PharoLauncher.image", "pharo-launcher-mcp-patches"].sort(),
    );
  });

  it("leaves an image its record names as it is", () => {
    const image = launcherImage();
    const calls: string[][] = [];
    ensureLauncherPatches("/vm/pharo", image, savingRunner(calls));

    ensureLauncherPatches("/vm/pharo", image, savingRunner(calls));

    expect(calls).toHaveLength(1);
  });

  it("patches again an image recorded with an earlier set", () => {
    const image = launcherImage();
    fs.writeFileSync(launcherPatchesRecord(image), "github-downloads-0\n", "utf8");
    const calls: string[][] = [];

    ensureLauncherPatches("/vm/pharo", image, savingRunner(calls));

    expect(calls).toHaveLength(1);
  });

  it("keeps the image and records nothing when the VM fails, saying why", () => {
    const image = launcherImage();

    expect(() =>
      ensureLauncherPatches("/vm/pharo", image, () => ({ status: 1, stderr: "Error: boom" })),
    ).toThrow(/Could not prepare[\s\S]*exit: 1[\s\S]*Error: boom/);

    expect(fs.readFileSync(image, "utf8")).toBe("image");
    expect(fs.existsSync(launcherPatchesRecord(image))).toBe(false);
    expect(fs.readdirSync(path.dirname(image)).sort()).toEqual(
      ["PharoLauncher.changes", "PharoLauncher.image"].sort(),
    );
  });

  it("changes only what it finds, and saves", () => {
    expect(launcherPatchesScript).toContain("at: #ZnConstants ifAbsent: [ nil ]");
    expect(launcherPatchesScript).toContain("maximumLineLength < 65536");
    expect(launcherPatchesScript).toContain("at: #PhLDownloadManager ifAbsent: [ nil ]");
    expect(launcherPatchesScript).toContain("includesSelector: #download:toFile:");
    expect(launcherPatchesScript).toContain("error pass");
    expect(launcherPatchesScript).toContain("at: #PhLCliTemplateSourcesChecker ifAbsent: [ nil ]");
    expect(launcherPatchesScript).toContain("includesSelector: #checkForUpdates");
    expect(launcherPatchesScript.trim().endsWith("Smalltalk snapshot: true andQuit: true")).toBe(true);
  });
});
