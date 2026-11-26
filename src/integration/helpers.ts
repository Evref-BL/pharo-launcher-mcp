import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadPharoLauncherConfig,
  type PharoLauncherConfig,
} from "../config.js";
import {
  openLauncher as openPharoLauncher,
  type CallToolOptions,
  type PharoLauncher,
  type PharoLauncherOptions,
} from "../launcher.js";
import type { LauncherTemplate } from "../models.js";
import { callTool } from "../server.js";

export interface IntegrationProfile {
  config: PharoLauncherConfig;
  stateRoot: string;
}

/** What a tool answered: the text a model reads. */
export interface LiveAnswer {
  text: string;
  isError: boolean;
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

/** The images directory of the profile, as the server resolves it. */
export function imagesDirOf(profile: IntegrationProfile): string {
  return path.resolve(profile.stateRoot, "images");
}

/** The library on the profile, as a caller opens it: where the data is checked. */
export function liveLauncher(
  profile: IntegrationProfile,
  options: Omit<PharoLauncherOptions, "config"> = {},
): PharoLauncher {
  return openPharoLauncher({ ...options, config: profile.config });
}

/** A tool called on the profile, as a model calls it. */
export async function callLiveTool(
  profile: IntegrationProfile,
  toolName: string,
  input: Record<string, unknown> = {},
  options: Omit<CallToolOptions, "config"> = {},
): Promise<LiveAnswer> {
  const result = await callTool(toolName, input, {
    ...options,
    config: profile.config,
  });

  return {
    text: result.content.map((part) => part.text).join("\n"),
    isError: result.isError === true,
  };
}

/** A tool's answer that must not be a failure; a failure is thrown as it reads. */
export function expectAnswered(label: string, answer: LiveAnswer): string {
  if (answer.isError) {
    throw new Error(`${label} failed:\n${answer.text}`);
  }

  return answer.text;
}

/** A library result that must be ok; a failure is thrown with its own diagnostic. */
export function expectOk<T extends { ok: boolean; diagnostic?: string }>(
  label: string,
  result: T,
): T {
  if (!result.ok) {
    throw new Error(`${label} failed: ${result.diagnostic ?? JSON.stringify(result, null, 2)}`);
  }

  return result;
}

/**
 * The Pharo versions this host already has a VM for.
 *
 * `vm_list` used to answer this, and a test picking a template
 * it can create without a download is the only thing that ever asked. The VMs
 * are directories named `<version>-<architecture>` under the profile's VM
 * directory, so the answer is a directory listing, not a tool.
 */
export function localPharoVersions(profile: IntegrationProfile): string[] {
  const vmsDir = profile.config.profile?.vmsDir;
  if (!vmsDir || !fs.existsSync(vmsDir)) {
    return [];
  }

  return fs
    .readdirSync(vmsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => /^(\d+)-/.exec(entry.name)?.[1])
    .filter((version): version is string => Boolean(version));
}

/**
 * A template of the default category to create from, after refreshing the
 * list: one this host has a VM for when there is one, else the first.
 */
export async function firstTemplate(
  profile: IntegrationProfile,
  timeoutMs: number,
): Promise<LauncherTemplate & { name: string }> {
  const launcher = liveLauncher(profile, { timeoutMs });
  const availableVersions = localPharoVersions(profile);
  expectOk("template update", await launcher.updateTemplates());

  const templates = expectOk("template list", await launcher.listTemplates()).data?.templates ?? [];
  const named = templates.filter(
    (template): template is LauncherTemplate & { name: string } =>
      typeof template.name === "string" && template.name.length > 0,
  );
  const template =
    named.find((candidate) =>
      availableVersions.some(
        (version) =>
          candidate.name.includes(`Pharo ${Number(version)}.`) ||
          (candidate.url ?? "").includes(`/${version}/`),
      ),
    ) ?? named[0];
  if (!template) {
    throw new Error(`No template with a name was listed: ${JSON.stringify(templates)}`);
  }

  return template;
}
