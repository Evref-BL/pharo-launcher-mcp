import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  callLiveTool,
  expectOkTool,
  type IntegrationProfile,
  prepareIntegrationProfile,
  removeIntegrationProfile,
  stringField,
} from "./helpers.js";

const copyTimeoutMs = 240_000;

interface TemplateChoice {
  name: string;
  category?: string;
}

function dataArray(body: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(body.data)
    ? (body.data as Record<string, unknown>[])
    : [];
}

function imagesFromData(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) {
    return data.filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null,
    );
  }

  if (typeof data === "object" && data !== null) {
    return [data as Record<string, unknown>];
  }

  return [];
}

function imageNamed(
  body: Record<string, unknown>,
  imageName: string,
): Record<string, unknown> {
  const image = imagesFromData(body.data).find((item) => item.name === imageName);
  if (!image) {
    throw new Error(
      `Image ${imageName} was not returned: ${JSON.stringify(body, null, 2)}`,
    );
  }

  return image;
}

function firstNamedModel(
  body: Record<string, unknown>,
  modelName: string,
): Record<string, unknown> {
  const model = dataArray(body).find((item) => typeof item.name === "string");
  if (!model) {
    throw new Error(`No ${modelName} with a name was returned`);
  }

  return model;
}

function expectSuccessfulTool(
  label: string,
  toolResult: {
    result: { isError?: boolean };
    body: Record<string, unknown>;
  },
): void {
  if (toolResult.result.isError) {
    throw new Error(`${label} failed: ${JSON.stringify(toolResult.body, null, 2)}`);
  }

  expectOkTool(toolResult.body);
}

async function firstTemplate(profile: IntegrationProfile): Promise<TemplateChoice> {
  const vms = await callLiveTool(
    profile,
    "pharo_launcher_vm_list",
    { format: "ston" },
    { timeoutMs: copyTimeoutMs },
  );
  expect(vms.result.isError).toBeUndefined();
  expectOkTool(vms.body);
  const availableVersions = dataArray(vms.body)
    .map((vm) => (typeof vm.id === "string" ? vm.id.match(/^(\d+)-/)?.[1] : undefined))
    .filter((version): version is string => Boolean(version));

  const templates = await callLiveTool(
    profile,
    "pharo_launcher_template_list",
    { format: "ston" },
    { timeoutMs: copyTimeoutMs },
  );
  expect(templates.result.isError).toBeUndefined();
  expectOkTool(templates.body);

  const template =
    dataArray(templates.body).find((candidate) => {
      const name = typeof candidate.name === "string" ? candidate.name : "";
      const url = typeof candidate.url === "string" ? candidate.url : "";

      return availableVersions.some(
        (version) =>
          name.includes(`Pharo ${Number(version)}.`) ||
          url.includes(`/${version}/`),
      );
    }) ?? firstNamedModel(templates.body, "template");

  return {
    name: stringField(template.name, "template.name"),
    ...(typeof template.category === "string"
      ? { category: template.category }
      : {}),
  };
}

async function deleteImageIfPresent(
  profile: IntegrationProfile,
  imageName: string,
): Promise<void> {
  await callLiveTool(
    profile,
    "pharo_launcher_image_delete",
    { imageName, force: true, confirm: true },
    { timeoutMs: copyTimeoutMs },
  ).catch(() => undefined);
}

describe("PharoLauncher image copy integration", () => {
  let profile: IntegrationProfile;
  let sourceImageName: string;
  let copiedImageName: string;

  beforeAll(() => {
    profile = prepareIntegrationProfile("copy");
    const suffix = `${Date.now()}`;
    sourceImageName = `MCPPLCopySource-${suffix}`;
    copiedImageName = `MCPPLCopyTarget-${suffix}`;
  });

  afterAll(async () => {
    if (profile) {
      await deleteImageIfPresent(profile, copiedImageName);
      await deleteImageIfPresent(profile, sourceImageName);
      removeIntegrationProfile(profile);
    }
  });

  it(
    "returns a copied target image that can be listed and inspected",
    async () => {
      const template = await firstTemplate(profile);

      const created = await callLiveTool(
        profile,
        "pharo_launcher_image_create",
        {
          templateName: template.name,
          ...(template.category ? { templateCategory: template.category } : {}),
          newImageName: sourceImageName,
          noLaunch: true,
        },
        { timeoutMs: copyTimeoutMs },
      );
      expectSuccessfulTool("image create", created);

      const copied = await callLiveTool(
        profile,
        "pharo_launcher_image_copy",
        { imageName: sourceImageName, newImageName: copiedImageName },
        { timeoutMs: copyTimeoutMs },
      );
      expectSuccessfulTool("image copy", copied);
      expect(copied.body).toMatchObject({
        data: {
          targetImageName: copiedImageName,
          listedImage: {
            name: copiedImageName,
          },
          inspectedImage: {
            name: copiedImageName,
          },
        },
        copyVerification: {
          ok: true,
          targetImageName: copiedImageName,
        },
      });

      const listed = await callLiveTool(
        profile,
        "pharo_launcher_image_list",
        { nameFilter: copiedImageName, format: "ston" },
        { timeoutMs: copyTimeoutMs },
      );
      expectSuccessfulTool("image list copied target", listed);
      expect(imageNamed(listed.body, copiedImageName)).toMatchObject({
        name: copiedImageName,
      });

      const inspected = await callLiveTool(
        profile,
        "pharo_launcher_image_info",
        { imageName: copiedImageName, format: "ston" },
        { timeoutMs: copyTimeoutMs },
      );
      expectSuccessfulTool("image info copied target", inspected);
      expect(imageNamed(inspected.body, copiedImageName)).toMatchObject({
        name: copiedImageName,
      });
    },
    copyTimeoutMs,
  );
});
