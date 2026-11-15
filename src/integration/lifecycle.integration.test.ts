import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LauncherProcess } from "../models.js";
import {
  callLiveTool,
  expectAnswered,
  expectOk,
  firstTemplate,
  imagesDirOf,
  type IntegrationProfile,
  liveLauncher,
  prepareIntegrationProfile,
  removeIntegrationProfile,
} from "./helpers.js";

const lifecycleTimeoutMs = 240_000;

async function waitForProcess(
  profile: IntegrationProfile,
  imageName: string,
): Promise<LauncherProcess> {
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    const listed = await liveLauncher(profile).listProcesses();
    const process = listed.data?.find((item) => item.imageName === imageName);
    if (process) {
      return process;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`Process for ${imageName} did not appear`);
}

describe("PharoLauncher image lifecycle integration", () => {
  let profile: IntegrationProfile;
  let sourceImageName: string;
  let copiedImageName: string;

  beforeAll(() => {
    profile = prepareIntegrationProfile("lifecycle");
    const suffix = `${Date.now()}`;
    sourceImageName = `MCPPLLifecycleSource-${suffix}`;
    copiedImageName = `MCPPLLifecycleCopy-${suffix}`;
  });

  afterAll(async () => {
    if (profile) {
      const launcher = liveLauncher(profile, { timeoutMs: lifecycleTimeoutMs });
      for (const imageName of [copiedImageName, sourceImageName]) {
        await launcher.killProcess({ imageName }).catch(() => undefined);
        await launcher.deleteImage({ imageName }).catch(() => undefined);
      }
      removeIntegrationProfile(profile);
    }
  });

  it(
    "creates, copies, inspects, starts, refuses to delete while running, kills and deletes an image",
    async () => {
      const launcher = liveLauncher(profile, { timeoutMs: lifecycleTimeoutMs });
      const options = { timeoutMs: lifecycleTimeoutMs };
      const images = imagesDirOf(profile);
      const template = await firstTemplate(profile, lifecycleTimeoutMs);

      const createdText = expectAnswered(
        "image create",
        await callLiveTool(
          profile,
          "pharo_launcher_image_create",
          {
            templateName: template.name,
            ...(template.category ? { templateCategory: template.category } : {}),
            newImageName: sourceImageName,
          },
          options,
        ),
      );
      const created = await launcher.imageInfo({ imageName: sourceImageName });
      if (!created.found) {
        throw new Error(`${sourceImageName} is not in ${images} after: ${createdText}`);
      }
      expect(created.image).toMatchObject({
        name: sourceImageName,
        imagePath: path.join(images, sourceImageName, `${sourceImageName}.image`),
        pharoVersion: expect.any(String),
        architecture: "64",
        template: { name: template.name },
      });
      expect(created.image.pids ?? []).toEqual([]);
      expect(createdText.split("\n")).toEqual([
        `Created image ${sourceImageName} from template ${template.name}.`,
        `path: ${created.image.imagePath}`,
        `pharoVersion: ${created.image.pharoVersion}`,
        "architecture: 64",
      ]);

      // What a model reads of the image it just made.
      const listText = expectAnswered(
        "image list",
        await callLiveTool(profile, "pharo_launcher_image_list", {}, options),
      );
      expect(listText.split("\n")).toEqual([
        `1 image in ${images}, not running.`,
        "images:",
        `  ${sourceImageName} pharoVersion=${created.image.pharoVersion} architecture=64 template="${template.name}"`,
      ]);
      const infoText = expectAnswered(
        "image info",
        await callLiveTool(profile, "pharo_launcher_image_info", { imageName: sourceImageName }, options),
      );
      expect(infoText.split("\n")[0]).toBe(`Image ${sourceImageName} is not running.`);
      expect(infoText).toContain(`\ntemplate: ${template.name}\n`);

      const copiedText = expectAnswered(
        "image copy",
        await callLiveTool(
          profile,
          "pharo_launcher_image_copy",
          { imageName: sourceImageName, newImageName: copiedImageName },
          options,
        ),
      );
      const copyPath = path.join(images, copiedImageName, `${copiedImageName}.image`);
      expect(copiedText.split("\n")).toEqual([
        `Copied image ${sourceImageName} to ${copiedImageName}.`,
        `path: ${copyPath}`,
      ]);
      expect((await launcher.imageInfo({ imageName: copiedImageName })).found).toBe(true);

      const launchScript = path.join(
        profile.stateRoot,
        "init-scripts",
        "hold-for-process-kill.st",
      );
      fs.writeFileSync(
        launchScript,
        [
          "(Delay forSeconds: 300) wait.",
          "Smalltalk snapshot: false andQuit: true.",
          "",
        ].join("\n"),
        "utf8",
      );

      const startedText = expectAnswered(
        "image start",
        await callLiveTool(
          profile,
          "pharo_launcher_image_start",
          { imageName: copiedImageName, detached: true, script: launchScript },
          options,
        ),
      );
      const started = /^Started (\S+) headless, detached, as pid (\d+)\.$/.exec(
        startedText.split("\n")[0] ?? "",
      );
      expect(started?.[1], startedText).toBe(copiedImageName);
      expect(startedText).toMatch(/\nlogs: .+-launch\.out\.log and .+-launch\.err\.log$/);

      const running = await waitForProcess(profile, copiedImageName);
      expect(running.pid).toBe(Number(started?.[2]));
      expect(running.imagePath).toBe(copyPath);

      const refused = await callLiveTool(
        profile,
        "pharo_launcher_image_delete",
        { imageName: copiedImageName },
        options,
      );
      expect(refused).toEqual({
        isError: true,
        text: `Image ${copiedImageName} runs as pid ${running.pid}: stop it with pharo_launcher_process_kill, then delete it.`,
      });
      expect(fs.existsSync(copyPath)).toBe(true);

      expect(
        expectAnswered(
          "process kill",
          await callLiveTool(profile, "pharo_launcher_process_kill", { imageName: copiedImageName }, options),
        ),
      ).toBe(`Killed ${copiedImageName} (pid ${running.pid}).`);

      // Right after the kill: the kill waited for the VM to exit.
      expect(
        expectAnswered(
          "image delete copy",
          await callLiveTool(profile, "pharo_launcher_image_delete", { imageName: copiedImageName }, options),
        ),
      ).toBe(`Deleted image ${copiedImageName}.`);
      expect((await launcher.imageInfo({ imageName: copiedImageName })).found).toBe(false);

      expectOk("image delete source", await launcher.deleteImage({ imageName: sourceImageName }));
      expect((await launcher.listImages()).images).toEqual([]);
    },
    900_000,
  );
});
