import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  callLiveTool,
  expectOkTool,
  type IntegrationProfile,
  prepareIntegrationProfile,
  removeIntegrationProfile,
  stringField,
} from "./helpers.js";

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

describe("PharoLauncher live integration", () => {
  let profile: IntegrationProfile;

  beforeAll(() => {
    profile = prepareIntegrationProfile();
  });

  afterAll(() => {
    removeIntegrationProfile(profile);
  });

  it("reports resolved configuration for the isolated launcher profile", async () => {
    const { result, body } = await callLiveTool(profile, "pharo_launcher_config");

    expect(result.isError).toBeUndefined();
    expect(body).toHaveProperty("profile");
    expect(body).toHaveProperty("launcherImage");
    expect(body).toHaveProperty("launcherScript");
  });

  it("lists template categories and templates", async () => {
    const update = await callLiveTool(
      profile,
      "pharo_launcher_template_update",
    );
    expect(update.result.isError).toBeUndefined();
    expectOkTool(update.body);

    const categories = await callLiveTool(
      profile,
      "pharo_launcher_template_category_list",
      { format: "ston" },
    );
    expect(categories.result.isError).toBeUndefined();
    expect(categories.body).toMatchObject({
      ok: true,
      parser: {
        status: "parsed",
        format: "ston",
      },
    });

    const templates = await callLiveTool(
      profile,
      "pharo_launcher_template_list",
      { format: "ston" },
    );
    expect(templates.result.isError).toBeUndefined();
    expect(templates.body).toMatchObject({
      ok: true,
      parser: {
        status: "parsed",
        format: "ston",
      },
    });
  });

  it("updates template metadata through the typed tool", async () => {
    const { result, body } = await callLiveTool(
      profile,
      "pharo_launcher_template_update",
    );

    expect(result.isError).toBeUndefined();
    expect(body).toMatchObject({
      ok: true,
      parser: {
        status: "unsupported",
      },
      command: {
        args: ["template", "update"],
        exitCode: 0,
        timedOut: false,
      },
    });
  });

  it("lists images through the typed tool and normalized result envelope", async () => {
    const { result, body } = await callLiveTool(
      profile,
      "pharo_launcher_image_list",
      { format: "ston" },
    );

    expect(result.isError).toBeUndefined();
    expect(body).toMatchObject({
      ok: true,
      parser: {
        status: "parsed",
        format: "ston",
      },
      command: {
        args: ["image", "list", "--ston"],
        exitCode: 0,
        timedOut: false,
      },
    });
  });

  it("lists processes without requiring destructive permissions", async () => {
    const { result, body } = await callLiveTool(
      profile,
      "pharo_launcher_process_list",
    );

    expect(result.isError).toBeUndefined();
    expect(body).toMatchObject({
      ok: true,
      parser: {
        status: "parsed",
        format: "text",
      },
      command: {
        args: ["process", "list"],
        exitCode: 0,
        timedOut: false,
      },
    });
  });
});
