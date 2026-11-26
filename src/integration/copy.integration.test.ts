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
  let image: string;
  let copiedImageName: string;

  beforeAll(() => {
    profile = prepareIntegrationProfile("copy");
    const suffix = `${Date.now()}`;
    image = `MCPPLCopySource-${suffix}`;
    // Holds the source's name, as pricing-2025 holds pricing.
    longerName = `${image}-2025`;
    copiedImageName = `MCPPLCopyTarget-${suffix}`;
  });

  afterAll(async () => {
    if (profile) {
      const launcher = liveLauncher(profile, { timeoutMs: copyTimeoutMs });
      for (const imageName of [copiedImageName, image, longerName]) {
        await launcher.deleteImage({ image: imageName }).catch(() => undefined);
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
      const createInput = (image: string) => ({
        template: template.name,
        ...(template.category ? { category: template.category } : {}),
        image,
      });

      expectOk("image create of the longer name", await launcher.createImage(createInput(longerName)));

      // Listed and opened on the first look: no poll for the 30 s.
      const startedAt = Date.now();
      const created = expectOk("image create", await launcher.createImage(createInput(image)));
      expect(Date.now() - startedAt).toBeLessThan(created.command!.durationMs + verificationTimeoutMs);
      expect(created.command!.timedOut).toBe(false);
      expect(created.data).toMatchObject({
        image: {
          name: image,
          imagePath: path.join(images, image, `${image}.image`),
        },
      });

      const copiedText = expectAnswered(
        "image copy",
        await callLiveTool(
          profile,
          "image_copy",
          { image: image, newImage: copiedImageName },
          { timeoutMs: copyTimeoutMs },
        ),
      );
      expect(copiedText.split("\n")).toEqual([
        `Copied image ${image} to ${copiedImageName}.`,
        `path: ${path.join(images, copiedImageName, `${copiedImageName}.image`)}`,
      ]);

      // Every image named, with its version and template.
      const list = await launcher.listImages();
      expect(list.notImages).toEqual([]);
      expect(list.images.map((image) => image.name)).toEqual(
        [copiedImageName, image, longerName].sort(),
      );
      for (const image of list.images) {
        expect(image).toMatchObject({
          pharoVersion: expect.stringMatching(/^\d+\.\d+$/),
          architecture: "64",
          template: { name: template.name },
        });
      }

      const filtered = await launcher.listImages({ nameFilter: image });
      expect(filtered.images.map((image) => image.name)).toEqual([image, longerName]);

      const info = await launcher.imageInfo({ image: copiedImageName });
      expect(info).toMatchObject({ kind: "image", image: { name: copiedImageName } });
    },
    900_000,
  );
});
