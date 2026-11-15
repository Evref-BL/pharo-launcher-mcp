import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

const copyTimeoutMs = 240_000;
// The create and copy post-condition polls for this long before it gives up.
const verificationTimeoutMs = 30_000;

describe("PharoLauncher image copy integration", () => {
  let profile: IntegrationProfile;
  let longerName: string;
  let sourceImageName: string;
  let copiedImageName: string;

  beforeAll(() => {
    profile = prepareIntegrationProfile("copy");
    const suffix = `${Date.now()}`;
    sourceImageName = `MCPPLCopySource-${suffix}`;
    // Holds the source's name, as pricing-2025 holds pricing.
    longerName = `${sourceImageName}-2025`;
    copiedImageName = `MCPPLCopyTarget-${suffix}`;
  });

  afterAll(async () => {
    if (profile) {
      const launcher = liveLauncher(profile, { timeoutMs: copyTimeoutMs });
      for (const imageName of [copiedImageName, sourceImageName, longerName]) {
        await launcher.deleteImage({ imageName }).catch(() => undefined);
      }
      removeIntegrationProfile(profile);
    }
  });

  it(
    "creates an image beside one whose name holds its own, and copies it",
    async () => {
      const launcher = liveLauncher(profile, { timeoutMs: copyTimeoutMs });
      const images = imagesDirOf(profile);
      const template = await firstTemplate(profile, copyTimeoutMs);
      const createInput = (newImageName: string) => ({
        templateName: template.name,
        ...(template.category ? { templateCategory: template.category } : {}),
        newImageName,
      });

      expectOk("image create of the longer name", await launcher.createImage(createInput(longerName)));

      // Listed and opened on the first look: no poll for the 30 s.
      const startedAt = Date.now();
      const created = expectOk("image create", await launcher.createImage(createInput(sourceImageName)));
      expect(Date.now() - startedAt).toBeLessThan(created.command.durationMs + verificationTimeoutMs);
      expect(created.command.timedOut).toBe(false);
      expect(created.data).toMatchObject({
        image: {
          name: sourceImageName,
          imagePath: path.join(images, sourceImageName, `${sourceImageName}.image`),
        },
      });

      const copiedText = expectAnswered(
        "image copy",
        await callLiveTool(
          profile,
          "pharo_launcher_image_copy",
          { imageName: sourceImageName, newImageName: copiedImageName },
          { timeoutMs: copyTimeoutMs },
        ),
      );
      expect(copiedText.split("\n")).toEqual([
        `Copied image ${sourceImageName} to ${copiedImageName}.`,
        `path: ${path.join(images, copiedImageName, `${copiedImageName}.image`)}`,
      ]);

      // Every image named, with its version and template.
      const list = await launcher.listImages();
      expect(list.notImages).toEqual([]);
      expect(list.images.map((image) => image.name)).toEqual(
        [copiedImageName, sourceImageName, longerName].sort(),
      );
      for (const image of list.images) {
        expect(image).toMatchObject({
          pharoVersion: expect.stringMatching(/^\d+$/),
          architecture: "64",
          template: { name: template.name },
        });
      }

      const filtered = await launcher.listImages({ nameFilter: sourceImageName });
      expect(filtered.images.map((image) => image.name)).toEqual([sourceImageName, longerName]);

      const info = await launcher.imageInfo({ imageName: copiedImageName });
      expect(info).toMatchObject({ found: true, image: { name: copiedImageName } });
    },
    900_000,
  );
});
