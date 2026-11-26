import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeImages } from "../probe.js";
import {
  callLiveTool,
  expectAnswered,
  expectOk,
  imagesDirOf,
  type IntegrationProfile,
  liveLauncher,
  prepareIntegrationProfile,
  removeIntegrationProfile,
} from "./helpers.js";

const liveTimeoutMs = 240_000;

describe("PharoLauncher live integration", () => {
  let profile: IntegrationProfile;

  beforeAll(() => {
    profile = prepareIntegrationProfile();
  });

  afterAll(() => {
    removeIntegrationProfile(profile);
  });

  it("says which Launcher it runs and where the profile's images are", async () => {
    expect((await liveLauncher(profile).listImages()).imagesDir).toBe(imagesDirOf(profile));

    const text = expectAnswered("config", await callLiveTool(profile, "config"));
    expect(text.split("\n")).toEqual([
      expect.stringMatching(/^Pharo Launcher .+, profile integration\.$/),
      `stateRoot: ${profile.stateRoot}`,
      `images: ${imagesDirOf(profile)}`,
    ]);
  });

  it("lists template categories and templates", async () => {
    const launcher = liveLauncher(profile, { timeoutMs: liveTimeoutMs });
    expectOk("template update", await launcher.updateTemplates());

    const categories = expectOk("template categories", await launcher.listTemplateCategories());
    const categoryNames = categories.data?.categories ?? [];
    expect(categoryNames.length).toBeGreaterThan(0);
    if (categories.data?.defaultCategory !== undefined) {
      expect(categoryNames).toContain(categories.data.defaultCategory);
    }
    const categoriesText = expectAnswered(
      "template category list",
      await callLiveTool(profile, "template_category_list", {}, { timeoutMs: liveTimeoutMs }),
    );
    expect(categoriesText.split("\n").slice(1)).toEqual([
      "categories:",
      ...categoryNames.map((name) => `  ${name}`),
    ]);

    const templates = expectOk("template list", await launcher.listTemplates({ includeLocal: true }));
    const templateNames = (templates.data?.templates ?? []).map((template) => template.name);
    expect(templateNames.length).toBeGreaterThan(0);
    expect(templateNames.every((name) => typeof name === "string" && name.length > 0)).toBe(true);
    const templatesText = expectAnswered(
      "template list",
      await callLiveTool(profile, "template_list", {}, { timeoutMs: liveTimeoutMs }),
    );
    expect(templatesText.split("\n")).toEqual([
      `${templateNames.length} template${templateNames.length === 1 ? "" : "s"} in the default category.`,
      "templates:",
      ...templateNames.map((name) => `  ${name}`),
    ]);
  });

  it("refreshes the template list", async () => {
    const text = expectAnswered(
      "template update",
      await callLiveTool(profile, "template_update", {}, { timeoutMs: liveTimeoutMs }),
    );
    expect(text).toMatch(/this profile's sources\.list/i);
  });

  it("lists the profile's images, read from its images directory", async () => {
    const list = await liveLauncher(profile).listImages();
    expect(list).toMatchObject({ imagesDir: imagesDirOf(profile), images: [], notImages: [] });
    expect(list.processListFailure).toBeUndefined();

    const text = expectAnswered("image list", await callLiveTool(profile, "image_list"));
    expect(text).toBe(`No images in ${imagesDirOf(profile)}.`);
  });

  it("probes the Launcher's own image listing, then prints image_list's answer", async () => {
    const outcome = await probeImages({ config: profile.config, timeoutMs: liveTimeoutMs });

    expect(outcome).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: `No images in ${imagesDirOf(profile)}.\n`,
    });
  });

  it("lists no process, for a profile that runs no image", async () => {
    const processes = expectOk("process list", await liveLauncher(profile).listProcesses());
    expect(processes.data).toEqual({ processes: [] });

    const text = expectAnswered("process list", await callLiveTool(profile, "process_list"));
    expect(text).toBe(`No process runs an image in ${imagesDirOf(profile)}.`);
  });
});
