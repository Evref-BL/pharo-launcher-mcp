import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  callLiveTool,
  expectOkTool,
  type IntegrationProfile,
  prepareIntegrationProfile,
  removeIntegrationProfile,
  stringField,
} from "./helpers.js";

const lifecycleTimeoutMs = 240_000;

interface TemplateChoice {
  name: string;
  category?: string;
}

function dataArray(body: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(body.data)
    ? (body.data as Record<string, unknown>[])
    : [];
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
    { timeoutMs: lifecycleTimeoutMs },
  );
  expect(vms.result.isError).toBeUndefined();
  expectOkTool(vms.body);
  const availableVersions = dataArray(vms.body)
    .map((vm) => (typeof vm.id === "string" ? vm.id.match(/^(\d+)-/)?.[1] : undefined))
    .filter((version): version is string => Boolean(version));

  const update = await callLiveTool(
    profile,
    "pharo_launcher_template_update",
    {},
    { timeoutMs: lifecycleTimeoutMs },
  );
  expectSuccessfulTool("template update", update);

  const { result, body } = await callLiveTool(
    profile,
    "pharo_launcher_template_list",
    { format: "ston" },
    { timeoutMs: lifecycleTimeoutMs },
  );

  expect(result.isError).toBeUndefined();
  expectOkTool(body);

  const templates = dataArray(body);
  const template =
    templates.find((candidate) => {
      const name = typeof candidate.name === "string" ? candidate.name : "";
      const url = typeof candidate.url === "string" ? candidate.url : "";

      return availableVersions.some(
        (version) =>
          name.includes(`Pharo ${Number(version)}.`) ||
          url.includes(`/${version}/`),
      );
    }) ?? firstNamedModel(body, "template");

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
    { timeoutMs: lifecycleTimeoutMs },
  ).catch(() => undefined);
}

async function killProcessIfPresent(
  profile: IntegrationProfile,
  imageName: string,
): Promise<void> {
  await callLiveTool(
    profile,
    "pharo_launcher_process_kill",
    { imageName, confirm: true },
    { timeoutMs: lifecycleTimeoutMs },
  ).catch(() => undefined);
}

async function waitForProcess(
  profile: IntegrationProfile,
  imageName: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    const { body } = await callLiveTool(
      profile,
      "pharo_launcher_process_list",
      {},
      { timeoutMs: lifecycleTimeoutMs },
    );
    const process = dataArray(body).find(
      (item) =>
        item.imageName === imageName ||
        (typeof item.commandLine === "string" &&
          item.commandLine.includes(imageName)),
    );

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
      await killProcessIfPresent(profile, copiedImageName);
      await killProcessIfPresent(profile, sourceImageName);
      await deleteImageIfPresent(profile, copiedImageName);
      await deleteImageIfPresent(profile, sourceImageName);
      removeIntegrationProfile(profile);
    }
  });

  it(
    "creates, copies, inspects, packages, launches, stops, recreates, and deletes an image",
    async () => {
      const template = await firstTemplate(profile);

      const createInput = {
        templateName: template.name,
        ...(template.category ? { templateCategory: template.category } : {}),
        newImageName: sourceImageName,
        noLaunch: true,
      };
      const created = await callLiveTool(
        profile,
        "pharo_launcher_image_create",
        createInput,
        { timeoutMs: lifecycleTimeoutMs },
      );
      expectSuccessfulTool("image create", created);

      const info = await callLiveTool(
        profile,
        "pharo_launcher_image_info",
        { imageName: sourceImageName, format: "ston" },
        { timeoutMs: lifecycleTimeoutMs },
      );
      expect(info.result.isError).toBeUndefined();
      expect(info.body).toMatchObject({
        ok: true,
        parser: {
          status: "parsed",
          format: "ston",
        },
      });

      const copied = await callLiveTool(
        profile,
        "pharo_launcher_image_copy",
        { imageName: sourceImageName, newImageName: copiedImageName },
        { timeoutMs: lifecycleTimeoutMs },
      );
      expectSuccessfulTool("image copy", copied);

      const packageDirectory = path.join(profile.stateRoot, "packages");
      const packaged = await callLiveTool(
        profile,
        "pharo_launcher_image_package",
        { imageName: copiedImageName, location: packageDirectory },
        { timeoutMs: lifecycleTimeoutMs },
      );
      expectSuccessfulTool("image package", packaged);
      expect(fs.existsSync(packageDirectory)).toBe(true);

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

      const launched = await callLiveTool(
        profile,
        "pharo_launcher_image_launch",
        {
          imageName: copiedImageName,
          detached: true,
          script: launchScript,
        },
        { timeoutMs: lifecycleTimeoutMs },
      );
      expectSuccessfulTool("image launch", launched);

      const runningProcess = await waitForProcess(profile, copiedImageName);
      expect(runningProcess).toMatchObject({
        pid: expect.any(Number),
      });

      const killed = await callLiveTool(
        profile,
        "pharo_launcher_process_kill",
        { imageName: copiedImageName, confirm: true },
        { timeoutMs: lifecycleTimeoutMs },
      );
      expectSuccessfulTool("process kill", killed);

      const recreated = await callLiveTool(
        profile,
        "pharo_launcher_image_recreate",
        { imageName: copiedImageName, confirm: true },
        { timeoutMs: lifecycleTimeoutMs },
      );
      expectSuccessfulTool("image recreate", recreated);

      const deletedCopy = await callLiveTool(
        profile,
        "pharo_launcher_image_delete",
        { imageName: copiedImageName, force: true, confirm: true },
        { timeoutMs: lifecycleTimeoutMs },
      );
      expectSuccessfulTool("image delete copy", deletedCopy);

      const deletedSource = await callLiveTool(
        profile,
        "pharo_launcher_image_delete",
        { imageName: sourceImageName, force: true, confirm: true },
        { timeoutMs: lifecycleTimeoutMs },
      );
      expectSuccessfulTool("image delete source", deletedSource);
    },
    lifecycleTimeoutMs,
  );
});
