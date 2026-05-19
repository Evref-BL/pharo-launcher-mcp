import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import {
  loadPharoLauncherConfig,
  type PharoLauncherConfig,
} from "../config.js";
import { callTool, type CallToolOptions } from "../server.js";

export interface IntegrationProfile {
  config: PharoLauncherConfig;
  stateRoot: string;
}

export interface ParsedToolResult {
  result: Awaited<ReturnType<typeof callTool>>;
  body: Record<string, unknown>;
}

function copyIfExists(source: string, destination: string): void {
  if (fs.existsSync(source)) {
    fs.copyFileSync(source, destination);
  }
}

export function prepareIntegrationProfile(
  profileName = "integration",
): IntegrationProfile {
  const installationConfig = loadPharoLauncherConfig(process.env);
  const launcherDir = process.env.PHARO_LAUNCHER_DIR ?? installationConfig.launcherDir;
  const sourceImage =
    process.env.PHARO_LAUNCHER_IMAGE ??
    installationConfig.installationLauncherImage;

  if (!fs.existsSync(sourceImage)) {
    throw new Error(`PharoLauncher image not found: ${sourceImage}`);
  }

  const stateRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pharo-launcher-mcp-integration-"),
  );
  const launcherProfileDir = path.join(stateRoot, "launcher");
  const profileImage = path.join(launcherProfileDir, "PharoLauncher.image");
  const sourceChanges = sourceImage.replace(/\.image$/i, ".changes");
  const profileChanges = profileImage.replace(/\.image$/i, ".changes");

  for (const directory of [
    launcherProfileDir,
    path.join(stateRoot, "images"),
    path.join(stateRoot, "vms"),
    path.join(stateRoot, "templates"),
    path.join(stateRoot, "init-scripts"),
    path.join(stateRoot, "logs"),
    path.join(stateRoot, "packages"),
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  fs.copyFileSync(sourceImage, profileImage);
  copyIfExists(sourceChanges, profileChanges);

  return {
    stateRoot,
    config: loadPharoLauncherConfig({
      ...process.env,
      PHARO_LAUNCHER_MCP_PROFILE: profileName,
      PHARO_LAUNCHER_MCP_STATE_ROOT: stateRoot,
      PHARO_LAUNCHER_MCP_LAUNCHER_IMAGE: profileImage,
      PHARO_LAUNCHER_MCP_IMAGES_DIR: path.join(stateRoot, "images"),
      PHARO_LAUNCHER_MCP_VMS_DIR: path.join(stateRoot, "vms"),
      PHARO_LAUNCHER_MCP_TEMPLATE_SOURCES_DIR: path.join(stateRoot, "templates"),
      PHARO_LAUNCHER_MCP_INIT_SCRIPTS_DIR: path.join(stateRoot, "init-scripts"),
      PHARO_LAUNCHER_MCP_LOGS_DIR: path.join(stateRoot, "logs"),
    }),
  };
}

export function removeIntegrationProfile(profile: IntegrationProfile | undefined): void {
  if (profile?.stateRoot) {
    fs.rmSync(profile.stateRoot, { recursive: true, force: true });
  }
}

export function parseJsonResult(result: Awaited<ReturnType<typeof callTool>>) {
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

export async function callLiveTool(
  profile: IntegrationProfile,
  toolName: string,
  input: Record<string, unknown> = {},
  options: Omit<CallToolOptions, "config"> = {},
): Promise<ParsedToolResult> {
  const result = await callTool(toolName, input, {
    ...options,
    config: profile.config,
  });

  return {
    result,
    body: parseJsonResult(result),
  };
}

export function expectOkTool(body: Record<string, unknown>): void {
  expect(body).toMatchObject({
    ok: true,
    command: {
      exitCode: 0,
      timedOut: false,
    },
  });
}

export function stringField(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${fieldName} is not a non-empty string`);
  }

  return value;
}
