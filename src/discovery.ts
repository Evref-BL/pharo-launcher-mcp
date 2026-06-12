import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import {
  loadPharoLauncherConfig,
  type PharoLauncherConfig,
  type PharoLauncherInstallationCandidate,
  type PharoLauncherInstallationSource,
} from "./config.js";
import { runLauncherCli, type LauncherCliResult } from "./launcherCli.js";
import {
  resolveLauncherScriptDetails,
  type ResolvedLauncherScript,
} from "./launcherScript.js";
import type {
  LauncherCommandResult,
  LauncherImage,
  LauncherTemplate,
} from "./models.js";
import { compactTokenText } from "./textTokens.js";
import { parseLauncherTemplatesFromSton } from "./parser.js";
import { normalizeLauncherResult } from "./resultNormalizer.js";

export interface PathStatus {
  path: string;
  exists: boolean;
}

export interface PharoLauncherProfileReport {
  name: string;
  stateRoot: PathStatus;
  launcherImage: PathStatus;
  imagesDir: PathStatus;
  vmsDir: PathStatus;
  templateSourcesDir: PathStatus;
  initScriptsDir: PathStatus;
  logsDir: PathStatus;
}

export interface PharoLauncherInstallationCandidateReport {
  source: PharoLauncherInstallationSource;
  launcherDir: PathStatus;
  launcherVm: PathStatus;
  installationLauncherImage: PathStatus;
  usable: boolean;
}

export interface PharoLauncherInstallationDiscoveryReport {
  source: PharoLauncherInstallationSource;
  selected: PharoLauncherInstallationCandidateReport;
  candidates: PharoLauncherInstallationCandidateReport[];
}

export interface PharoLauncherConfigReport {
  discovery: PharoLauncherInstallationDiscoveryReport;
  launcherDir: PathStatus;
  launcherVm: PathStatus;
  installationLauncherImage: PathStatus;
  launcherImage: PathStatus;
  launcherScript: ResolvedLauncherScript;
  launcherConfiguration?: string;
  profile?: PharoLauncherProfileReport;
}

export interface PharoLauncherHealthReport {
  ok: boolean;
  service: "pharo-launcher-mcp";
  config: PharoLauncherConfigReport;
}

export interface PharoLauncherVersionReport {
  ok: boolean;
  version?: string;
  command: LauncherCliResult;
}

export interface PharoLauncherValidationReport {
  ok: boolean;
  config: PharoLauncherConfigReport;
  harmlessCliCall: {
    args: string[];
    ok: boolean;
    result?: LauncherCliResult;
    error?: string;
  };
}

export type LauncherCliRunner = (
  args: readonly string[],
  options?: { config?: PharoLauncherConfig; timeoutMs?: number },
) => Promise<LauncherCliResult>;

export interface PharoLauncherDeclaredImage {
  imageId: string;
  imageName?: string;
  projectId?: string;
  workspaceId?: string;
  targetId?: string;
  active?: boolean;
  status?: string;
}

export interface PharoLauncherInventoryDiagnostic {
  severity: "error" | "warning";
  code: string;
  message: string;
  action: string;
  path?: string;
}

export interface PharoLauncherInventoryProfile {
  id: string;
  active: boolean;
  name: string;
  stateRoot: PathStatus;
  launcherImage: PathStatus;
  imagesRoot: PathStatus;
  vmRoot: PathStatus;
  templateSourceRoot: PathStatus;
  initScriptRoot: PathStatus;
  logRoot: PathStatus;
}

export interface PharoTemplateInventoryEntry {
  id: string;
  source: "installed" | "downloadable";
  name: string;
  category?: string;
  url?: string;
  architecture?: string;
  pharoVersion?: string;
  sourcePath?: string;
  sourceFile?: {
    path: string;
    sizeBytes: number;
    mtimeMs: number;
    sha256: string;
  };
  identity: {
    source: "installed" | "downloadable";
    category: string;
    name: string;
    url?: string;
    pharoVersion?: string;
    architecture?: string;
    sourceFileSha256?: string;
  };
  createRequest: {
    templateName: string;
    templateCategory?: string;
  };
}

export interface PharoImageInventoryEntry {
  id: string;
  imageName: string;
  architecture?: string;
  pharoVersion?: string;
  formatNumber?: number;
  imagePath?: string;
  originTemplate?: LauncherImage["originTemplate"];
  vmId?: string;
  identity: {
    imageName: string;
    architecture?: string;
    pharoVersion?: string;
    formatNumber?: number;
    imagePath?: string;
    originTemplateName?: string;
    originTemplateUrl?: string;
    vmId?: string;
  };
  copyRequest: {
    imageName: string;
  };
}

export interface PharoVersionInventoryEntry {
  id: string;
  pharoVersion: string;
  templateIds: string[];
  installedTemplateIds: string[];
  downloadableTemplateIds: string[];
  imageIds: string[];
}

export interface PharoLauncherInventoryProbe {
  ok: boolean;
  args: string[];
  parserStatus: LauncherCommandResult["parser"]["status"];
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  diagnostic?: string;
}

export interface PharoLauncherTemplateCreateRequest {
  templateName: string;
  templateCategory?: string;
}

export type PharoLauncherOfflineReadinessStatus =
  | "ready"
  | "missing"
  | "unknown";

export interface PharoLauncherOfflineReadinessInput {
  name: "templateSource" | "baseImage" | "vm";
  status: PharoLauncherOfflineReadinessStatus;
  diagnostic: string;
  path?: string;
  templateId?: string;
  imageId?: string;
}

export interface PharoLauncherTemplateCreateReadinessReport {
  status: PharoLauncherOfflineReadinessStatus;
  request: PharoLauncherTemplateCreateRequest;
  inputs: PharoLauncherOfflineReadinessInput[];
  template?: PharoTemplateInventoryEntry;
  baseImage?: PharoImageInventoryEntry;
  diagnostics: string[];
}

export interface PharoLauncherInventoryReport {
  ok: boolean;
  service: "pharo-launcher-mcp";
  config: PharoLauncherConfigReport;
  profiles: {
    active?: PharoLauncherInventoryProfile;
    available: PharoLauncherInventoryProfile[];
  };
  templates: {
    installed: PharoTemplateInventoryEntry[];
    downloadable: PharoTemplateInventoryEntry[];
    downloadableKnown: boolean;
  };
  versions: PharoVersionInventoryEntry[];
  images: {
    existing: PharoImageInventoryEntry[];
    existingKnown: boolean;
    declared: PharoLauncherDeclaredImage[];
  };
  probes: {
    templateList?: PharoLauncherInventoryProbe;
    imageList?: PharoLauncherInventoryProbe;
  };
  templateCreateReadiness?: PharoLauncherTemplateCreateReadinessReport;
  diagnostics: PharoLauncherInventoryDiagnostic[];
}

export interface PharoLauncherInventoryOptions {
  declaredImages?: readonly PharoLauncherDeclaredImage[];
  templateCreateRequest?: PharoLauncherTemplateCreateRequest;
  timeoutMs?: number;
}

function pathStatus(path: string): PathStatus {
  return {
    path,
    exists: fs.existsSync(path),
  };
}

function safeIdentifierSegment(value: string): string {
  return encodeURIComponent(value).replaceAll("%20", "+");
}

function profileId(name: string): string {
  return `profile:${safeIdentifierSegment(name)}`;
}

function templateId(
  source: PharoTemplateInventoryEntry["source"],
  template: LauncherTemplate,
): string {
  const category = safeIdentifierSegment(template.category ?? "uncategorized");
  const name = safeIdentifierSegment(template.name ?? template.url ?? "unnamed");
  const url = template.url ? `:${safeIdentifierSegment(template.url)}` : "";
  return `${source}:template:${category}:${name}${url}`;
}

function imageId(imageName: string): string {
  return `image:${safeIdentifierSegment(imageName)}`;
}

function versionId(pharoVersion: string): string {
  return `pharo:${safeIdentifierSegment(pharoVersion)}`;
}

function pathKind(value: string): "missing" | "file" | "directory" | "other" {
  try {
    const stat = fs.statSync(value);
    if (stat.isDirectory()) {
      return "directory";
    }
    if (stat.isFile()) {
      return "file";
    }
    return "other";
  } catch {
    return "missing";
  }
}

function isReadable(value: string): boolean {
  try {
    fs.accessSync(value, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function addPathDiagnostic(
  diagnostics: PharoLauncherInventoryDiagnostic[],
  input: {
    code: string;
    label: string;
    path: string;
    expected: "file" | "directory";
    action: string;
  },
): void {
  const kind = pathKind(input.path);
  if (kind === "missing") {
    diagnostics.push({
      severity: "error",
      code: `${input.code}_missing`,
      message: `${input.label} is missing: ${input.path}`,
      action: input.action,
      path: input.path,
    });
    return;
  }

  if (kind !== input.expected) {
    diagnostics.push({
      severity: "error",
      code: `${input.code}_not_${input.expected}`,
      message: `${input.label} must be an accessible ${input.expected}: ${input.path}`,
      action: input.action,
      path: input.path,
    });
    return;
  }

  if (!isReadable(input.path)) {
    diagnostics.push({
      severity: "error",
      code: `${input.code}_not_readable`,
      message: `${input.label} is not readable: ${input.path}`,
      action: input.action,
      path: input.path,
    });
  }
}

function getProfileReport(
  config: PharoLauncherConfig,
): PharoLauncherProfileReport | undefined {
  if (!config.profile) {
    return undefined;
  }

  return {
    name: config.profile.name,
    stateRoot: pathStatus(config.profile.stateRoot),
    launcherImage: pathStatus(config.profile.launcherImage),
    imagesDir: pathStatus(config.profile.imagesDir),
    vmsDir: pathStatus(config.profile.vmsDir),
    templateSourcesDir: pathStatus(config.profile.templateSourcesDir),
    initScriptsDir: pathStatus(config.profile.initScriptsDir),
    logsDir: pathStatus(config.profile.logsDir),
  };
}

function installationCandidateReport(
  candidate: PharoLauncherInstallationCandidate,
): PharoLauncherInstallationCandidateReport {
  const launcherDir = pathStatus(candidate.launcherDir);
  const launcherVm = pathStatus(candidate.launcherVm);
  const installationLauncherImage = pathStatus(
    candidate.installationLauncherImage,
  );

  return {
    source: candidate.source,
    launcherDir,
    launcherVm,
    installationLauncherImage,
    usable:
      launcherDir.exists &&
      launcherVm.exists &&
      installationLauncherImage.exists,
  };
}

function installationDiscoveryReport(
  config: PharoLauncherConfig,
): PharoLauncherInstallationDiscoveryReport {
  const fallbackCandidate: PharoLauncherInstallationCandidate = {
    source: "env",
    launcherDir: config.launcherDir,
    launcherVm: config.launcherVm,
    installationLauncherImage: config.installationLauncherImage,
  };
  const discovery = config.discovery ?? {
    source: fallbackCandidate.source,
    selected: fallbackCandidate,
    candidates: [fallbackCandidate],
  };

  return {
    source: discovery.source,
    selected: installationCandidateReport(discovery.selected),
    candidates: discovery.candidates.map(installationCandidateReport),
  };
}

function getInventoryProfile(
  config: PharoLauncherConfig,
): PharoLauncherInventoryProfile | undefined {
  if (!config.profile) {
    return undefined;
  }

  return {
    id: profileId(config.profile.name),
    active: true,
    name: config.profile.name,
    stateRoot: pathStatus(config.profile.stateRoot),
    launcherImage: pathStatus(config.profile.launcherImage),
    imagesRoot: pathStatus(config.profile.imagesDir),
    vmRoot: pathStatus(config.profile.vmsDir),
    templateSourceRoot: pathStatus(config.profile.templateSourcesDir),
    initScriptRoot: pathStatus(config.profile.initScriptsDir),
    logRoot: pathStatus(config.profile.logsDir),
  };
}

function addConfigurationDiagnostics(
  config: PharoLauncherConfig,
  diagnostics: PharoLauncherInventoryDiagnostic[],
): void {
  addPathDiagnostic(diagnostics, {
    code: "launcher_dir",
    label: "Pharo Launcher directory",
    path: config.launcherDir,
    expected: "directory",
    action:
      "Install Pharo Launcher or set PHARO_LAUNCHER_DIR to the launcher installation directory.",
  });
  addPathDiagnostic(diagnostics, {
    code: "launcher_vm",
    label: "Pharo Launcher VM",
    path: config.launcherVm,
    expected: "file",
    action:
      "Install Pharo Launcher or set PHARO_LAUNCHER_VM to the launcher VM executable.",
  });
  addPathDiagnostic(diagnostics, {
    code: "launcher_image",
    label: "Active Pharo Launcher control image",
    path: config.launcherImage,
    expected: "file",
    action:
      "Copy or restore the active Pharo Launcher control image, or set PHARO_LAUNCHER_MCP_LAUNCHER_IMAGE/PHARO_LAUNCHER_IMAGE to an existing image.",
  });

  if (config.launcherConfiguration) {
    addPathDiagnostic(diagnostics, {
      code: "launcher_configuration",
      label: "Pharo Launcher CLI configuration",
      path: config.launcherConfiguration,
      expected: "file",
      action:
        "Create the launcher CLI configuration or set PHARO_LAUNCHER_MCP_LAUNCHER_CONFIGURATION to an existing configuration file.",
    });
  }
}

function addProfileDiagnostics(
  config: PharoLauncherConfig,
  diagnostics: PharoLauncherInventoryDiagnostic[],
): void {
  if (!config.profile) {
    return;
  }

  addPathDiagnostic(diagnostics, {
    code: "profile_state_root",
    label: "Active launcher profile state root",
    path: config.profile.stateRoot,
    expected: "directory",
    action:
      "Create PHARO_LAUNCHER_MCP_STATE_ROOT or point it at an accessible profile state directory.",
  });

  for (const [code, label, directory, envName] of [
    [
      "profile_images_root",
      "Active launcher profile images root",
      config.profile.imagesDir,
      "PHARO_LAUNCHER_MCP_IMAGES_DIR",
    ],
    [
      "profile_vm_root",
      "Active launcher profile VM root",
      config.profile.vmsDir,
      "PHARO_LAUNCHER_MCP_VMS_DIR",
    ],
    [
      "profile_template_source_root",
      "Active launcher profile template source root",
      config.profile.templateSourcesDir,
      "PHARO_LAUNCHER_MCP_TEMPLATE_SOURCES_DIR",
    ],
    [
      "profile_init_script_root",
      "Active launcher profile init-script root",
      config.profile.initScriptsDir,
      "PHARO_LAUNCHER_MCP_INIT_SCRIPTS_DIR",
    ],
    [
      "profile_log_root",
      "Active launcher profile log root",
      config.profile.logsDir,
      "PHARO_LAUNCHER_MCP_LOGS_DIR",
    ],
  ] as const) {
    addPathDiagnostic(diagnostics, {
      code,
      label,
      path: directory,
      expected: "directory",
      action: `Create ${directory} or set ${envName} to an accessible directory.`,
    });
  }
}

export function getPharoLauncherConfigReport(
  config: PharoLauncherConfig = loadPharoLauncherConfig(),
): PharoLauncherConfigReport {
  return {
    discovery: installationDiscoveryReport(config),
    launcherDir: pathStatus(config.launcherDir),
    launcherVm: pathStatus(config.launcherVm),
    installationLauncherImage: pathStatus(config.installationLauncherImage),
    launcherImage: pathStatus(config.launcherImage),
    launcherScript: resolveLauncherScriptDetails({
      launcherDir: config.launcherDir,
      env: {
        ...process.env,
        ...(config.launcherScript
          ? { PHARO_LAUNCHER_SCRIPT: config.launcherScript }
          : {}),
      },
    }),
    ...(config.launcherConfiguration
      ? { launcherConfiguration: config.launcherConfiguration }
      : {}),
    ...(config.profile ? { profile: getProfileReport(config) } : {}),
  };
}

export function getPharoLauncherHealth(
  config: PharoLauncherConfig = loadPharoLauncherConfig(),
): PharoLauncherHealthReport {
  const report = getPharoLauncherConfigReport(config);

  return {
    ok:
      report.launcherDir.exists &&
      report.launcherVm.exists &&
      report.launcherImage.exists &&
      report.launcherScript.exists,
    service: "pharo-launcher-mcp",
    config: report,
  };
}

function templatesFromData(data: unknown): LauncherTemplate[] {
  if (Array.isArray(data)) {
    return data.filter(
      (item): item is LauncherTemplate =>
        typeof item === "object" && item !== null,
    );
  }

  if (typeof data === "object" && data !== null) {
    return [data as LauncherTemplate];
  }

  return [];
}

function imagesFromData(data: unknown): LauncherImage[] {
  if (Array.isArray(data)) {
    return data.filter(
      (item): item is LauncherImage =>
        typeof item === "object" && item !== null,
    );
  }

  if (typeof data === "object" && data !== null) {
    return [data as LauncherImage];
  }

  return [];
}

function normalizePharoVersion(value: string): string {
  const trimmed = value.trim();
  const numeric = trimmed.match(/^(\d{2,3})(?:\.(\d+))?$/);
  if (!numeric) {
    return trimmed;
  }

  const major = numeric[1];
  const minor = numeric[2] ?? (major.length === 2 ? "0" : "");
  return `${major}${minor}`;
}

function pharoVersionFromTemplate(template: LauncherTemplate): string | undefined {
  const urlVersion = template.url?.match(/(?:^|[/-])(\d{2,3})(?:[./-]|$)/)?.[1];
  if (urlVersion) {
    return normalizePharoVersion(urlVersion);
  }

  const nameVersion = template.name?.match(
    /\b(?:Pharo|Moose)\D*(\d{2,3}(?:\.\d+)?)/i,
  )?.[1];
  return nameVersion ? normalizePharoVersion(nameVersion) : undefined;
}

function architectureFromTemplate(
  template: LauncherTemplate,
): string | undefined {
  const source = `${template.name ?? ""} ${template.url ?? ""}`;
  const lower = source.toLowerCase();
  const compact = compactTokenText(source);
  if (lower.includes("aarch64") || lower.includes("arm64")) {
    return "arm64";
  }
  if (lower.includes("x64") || compact.includes("64bit")) {
    return "64";
  }
  if (lower.includes("x86") || compact.includes("32bit")) {
    return "32";
  }

  return undefined;
}

function templateSourceFile(
  filePath: string,
):
  | {
      path: string;
      sizeBytes: number;
      mtimeMs: number;
      sha256: string;
    }
  | undefined {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return undefined;
    }

    return {
      path: filePath,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: crypto
        .createHash("sha256")
        .update(fs.readFileSync(filePath))
        .digest("hex"),
    };
  } catch {
    return undefined;
  }
}

function inventoryTemplate(
  source: PharoTemplateInventoryEntry["source"],
  template: LauncherTemplate,
  sourcePath?: string,
): PharoTemplateInventoryEntry | undefined {
  if (!template.name) {
    return undefined;
  }

  const pharoVersion = pharoVersionFromTemplate(template);
  const architecture = architectureFromTemplate(template);
  const sourceFile = sourcePath ? templateSourceFile(sourcePath) : undefined;
  const category = template.category ?? "uncategorized";

  return {
    id: templateId(source, template),
    source,
    name: template.name,
    ...(template.category ? { category: template.category } : {}),
    ...(template.url ? { url: template.url } : {}),
    ...(architecture ? { architecture } : {}),
    ...(pharoVersion ? { pharoVersion } : {}),
    ...(sourcePath ? { sourcePath } : {}),
    ...(sourceFile ? { sourceFile } : {}),
    identity: {
      source,
      category,
      name: template.name,
      ...(template.url ? { url: template.url } : {}),
      ...(pharoVersion ? { pharoVersion } : {}),
      ...(architecture ? { architecture } : {}),
      ...(sourceFile ? { sourceFileSha256: sourceFile.sha256 } : {}),
    },
    createRequest: {
      templateName: template.name,
      ...(template.category ? { templateCategory: template.category } : {}),
    },
  };
}

function inventoryImage(image: LauncherImage): PharoImageInventoryEntry | undefined {
  if (!image.name) {
    return undefined;
  }

  return {
    id: imageId(image.name),
    imageName: image.name,
    ...(image.architecture ? { architecture: image.architecture } : {}),
    ...(image.pharoVersion ? { pharoVersion: image.pharoVersion } : {}),
    ...(image.formatNumber ? { formatNumber: image.formatNumber } : {}),
    ...(image.imagePath ? { imagePath: image.imagePath } : {}),
    ...(image.originTemplate ? { originTemplate: image.originTemplate } : {}),
    ...(image.vmId ? { vmId: image.vmId } : {}),
    identity: {
      imageName: image.name,
      ...(image.architecture ? { architecture: image.architecture } : {}),
      ...(image.pharoVersion ? { pharoVersion: image.pharoVersion } : {}),
      ...(image.formatNumber ? { formatNumber: image.formatNumber } : {}),
      ...(image.imagePath ? { imagePath: image.imagePath } : {}),
      ...(image.originTemplate?.name
        ? { originTemplateName: image.originTemplate.name }
        : {}),
      ...(image.originTemplate?.url
        ? { originTemplateUrl: image.originTemplate.url }
        : {}),
      ...(image.vmId ? { vmId: image.vmId } : {}),
    },
    copyRequest: {
      imageName: image.name,
    },
  };
}

function readInstalledTemplatesFromFile(
  filePath: string,
  diagnostics: PharoLauncherInventoryDiagnostic[],
): PharoTemplateInventoryEntry[] {
  try {
    return parseLauncherTemplatesFromSton(fs.readFileSync(filePath, "utf8"))
      .map((template) => inventoryTemplate("installed", template, filePath))
      .filter(
        (template): template is PharoTemplateInventoryEntry =>
          template !== undefined,
      );
  } catch (error) {
    diagnostics.push({
      severity: "warning",
      code: "installed_template_source_unreadable",
      message: `Installed template source could not be read: ${filePath}`,
      action:
        "Check file permissions or remove the unreadable template source from the active profile.",
      path: filePath,
    });
    return [];
  }
}

function readInstalledTemplates(
  config: PharoLauncherConfig,
  diagnostics: PharoLauncherInventoryDiagnostic[],
): PharoTemplateInventoryEntry[] {
  if (!config.profile) {
    diagnostics.push({
      severity: "warning",
      code: "installed_templates_unknown_without_profile",
      message:
        "Installed template sources are only scoped when a pharo-launcher-mcp profile is active.",
      action:
        "Set PHARO_LAUNCHER_MCP_PROFILE and PHARO_LAUNCHER_MCP_STATE_ROOT to expose scoped installed template sources.",
    });
    return [];
  }

  const root = config.profile.templateSourcesDir;
  const kind = pathKind(root);
  if (kind === "file") {
    return readInstalledTemplatesFromFile(root, diagnostics);
  }
  if (kind !== "directory" || !isReadable(root)) {
    return [];
  }

  const sourcesFilePath = path.join(root, "sources.list");
  const sourcesFileKind = pathKind(sourcesFilePath);
  if (sourcesFileKind === "missing") {
    diagnostics.push({
      severity: "warning",
      code: "profile_template_sources_bootstrap_missing",
      message:
        "The active profile template source bootstrap file is missing, so template update/list may not populate scoped template inventory.",
      action:
        "Run pharo_launcher_template_update to fetch or seed the active profile sources.list before planning image creation.",
      path: sourcesFilePath,
    });
  } else if (
    sourcesFileKind === "file" &&
    fs.statSync(sourcesFilePath).size === 0
  ) {
    diagnostics.push({
      severity: "warning",
      code: "profile_template_sources_bootstrap_empty",
      message:
        "The active profile template source bootstrap file is empty, so template update/list may not populate scoped template inventory.",
      action:
        "Run pharo_launcher_template_update to refresh the active profile sources.list before planning image creation.",
      path: sourcesFilePath,
    });
  }

  return fs
    .readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const entryPath = path.join(root, entry.name);
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".ston")) {
        return readInstalledTemplatesFromFile(entryPath, diagnostics);
      }
      if (entry.isDirectory()) {
        return (
          inventoryTemplate(
            "installed",
            { name: entry.name },
            entryPath,
          ) ?? []
        );
      }
      return [];
    });
}

function probeSummary(
  result: LauncherCommandResult,
  diagnostic?: string,
): PharoLauncherInventoryProbe {
  return {
    ok: result.ok,
    args: result.command.args,
    parserStatus: result.parser.status,
    durationMs: result.command.durationMs,
    exitCode: result.command.exitCode,
    timedOut: result.command.timedOut,
    ...(diagnostic ? { diagnostic } : {}),
  };
}

async function runInventoryProbe(
  toolName: "pharo_launcher_template_list" | "pharo_launcher_image_list",
  args: readonly string[],
  runner: LauncherCliRunner,
  config: PharoLauncherConfig,
  timeoutMs: number | undefined,
): Promise<LauncherCommandResult> {
  const result = await runner(args, {
    config,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  return normalizeLauncherResult(toolName, args, result);
}

function addCommandDiagnostic(
  diagnostics: PharoLauncherInventoryDiagnostic[],
  code: string,
  label: string,
  result: LauncherCommandResult,
): string | undefined {
  if (result.ok) {
    return undefined;
  }

  const diagnostic =
    result.diagnostic ??
    `${label} failed with exit code ${result.command.exitCode ?? "unknown"}.`;
  diagnostics.push({
    severity: "error",
    code,
    message: diagnostic,
    action:
      result.action ??
      "Run pharo_launcher_validate_installation and inspect the command stderr before planning image creation.",
  });
  return diagnostic;
}

function addEmptyTemplateInventoryDiagnostic(
  diagnostics: PharoLauncherInventoryDiagnostic[],
  config: PharoLauncherConfig,
): void {
  diagnostics.push({
    severity: "error",
    code: "template_inventory_empty",
    message:
      "The active launcher profile has no installed or downloadable templates, so image creation cannot choose a template.",
    action:
      "Run pharo_launcher_template_update, verify the active profile template source root, and seed or repair template-source bootstrap state before planning image creation.",
    ...(config.profile ? { path: config.profile.templateSourcesDir } : {}),
  });
}

function addProbeErrorDiagnostic(
  diagnostics: PharoLauncherInventoryDiagnostic[],
  code: string,
  label: string,
  error: unknown,
): string {
  const message = error instanceof Error ? error.message : String(error);
  const diagnostic = `${label} could not be executed: ${message}`;
  diagnostics.push({
    severity: "error",
    code,
    message: diagnostic,
    action:
      "Check the resolved launcher configuration and filesystem paths before planning image creation.",
  });
  return diagnostic;
}

function collectVersions(
  templates: readonly PharoTemplateInventoryEntry[],
  images: readonly PharoImageInventoryEntry[],
): PharoVersionInventoryEntry[] {
  const byVersion = new Map<string, PharoVersionInventoryEntry>();

  function versionEntry(pharoVersion: string): PharoVersionInventoryEntry {
    const existing = byVersion.get(pharoVersion);
    if (existing) {
      return existing;
    }

    const entry = {
      id: versionId(pharoVersion),
      pharoVersion,
      templateIds: [],
      installedTemplateIds: [],
      downloadableTemplateIds: [],
      imageIds: [],
    };
    byVersion.set(pharoVersion, entry);
    return entry;
  }

  for (const template of templates) {
    if (!template.pharoVersion) {
      continue;
    }

    const entry = versionEntry(template.pharoVersion);
    entry.templateIds.push(template.id);
    if (template.source === "installed") {
      entry.installedTemplateIds.push(template.id);
    } else {
      entry.downloadableTemplateIds.push(template.id);
    }
  }

  for (const image of images) {
    if (!image.pharoVersion) {
      continue;
    }

    versionEntry(image.pharoVersion).imageIds.push(image.id);
  }

  return [...byVersion.values()].sort((left, right) =>
    left.pharoVersion.localeCompare(right.pharoVersion, undefined, {
      numeric: true,
    }),
  );
}

function templateMatchesCreateRequest(
  template: PharoTemplateInventoryEntry,
  request: PharoLauncherTemplateCreateRequest,
): boolean {
  if (template.name !== request.templateName) {
    return false;
  }

  return (
    !request.templateCategory || template.category === request.templateCategory
  );
}

function imageMatchesTemplate(
  image: PharoImageInventoryEntry,
  template: PharoTemplateInventoryEntry,
): boolean {
  if (template.url && image.originTemplate?.url === template.url) {
    return true;
  }

  if (template.name && image.originTemplate?.name === template.name) {
    return true;
  }

  if (!template.pharoVersion || image.pharoVersion !== template.pharoVersion) {
    return false;
  }

  return !template.architecture || image.architecture === template.architecture;
}

function vmNameMatchesTemplate(value: string, template: PharoTemplateInventoryEntry): boolean {
  const normalized = value.toLowerCase();
  const version = template.pharoVersion?.toLowerCase();
  const majorVersion =
    version && version.endsWith("0") ? version.slice(0, -1) : version;
  const versionMatches =
    !version ||
    normalized.includes(version) ||
    Boolean(majorVersion && normalized.includes(majorVersion));
  const architecture = template.architecture?.toLowerCase();
  const architectureMatches =
    !architecture ||
    normalized.includes(architecture) ||
    (architecture === "64" && /\b(?:x64|64|64bit)\b/.test(normalized)) ||
    (architecture === "arm64" && /\b(?:arm64|aarch64)\b/.test(normalized));

  return versionMatches && architectureMatches;
}

function findLocalVmProof(
  config: PharoLauncherConfig,
  template: PharoTemplateInventoryEntry | undefined,
): PharoLauncherOfflineReadinessInput {
  if (!config.profile) {
    return {
      name: "vm",
      status: "unknown",
      diagnostic:
        "VM readiness is unknown because no scoped launcher profile is active.",
    };
  }

  const root = config.profile.vmsDir;
  if (pathKind(root) !== "directory" || !isReadable(root)) {
    return {
      name: "vm",
      status: "missing",
      path: root,
      diagnostic:
        "The active profile VM root is missing or unreadable, so no local VM can be proven.",
    };
  }

  if (!template?.pharoVersion) {
    return {
      name: "vm",
      status: "unknown",
      path: root,
      diagnostic:
        "VM readiness is unknown because the selected template has no Pharo version metadata.",
    };
  }

  const entries = fs.readdirSync(root, { withFileTypes: true });
  const match = entries.find((entry) => vmNameMatchesTemplate(entry.name, template));
  if (!match) {
    return {
      name: "vm",
      status: "missing",
      path: root,
      diagnostic:
        "No profile-local VM matched the selected template version and architecture.",
    };
  }

  return {
    name: "vm",
    status: "ready",
    path: path.join(root, match.name),
    diagnostic:
      "A profile-local VM matches the selected template version and architecture.",
  };
}

interface TemplateCreateReadinessOptions {
  config: PharoLauncherConfig;
  request: PharoLauncherTemplateCreateRequest;
  installedTemplates: readonly PharoTemplateInventoryEntry[];
  downloadableTemplates: readonly PharoTemplateInventoryEntry[];
  existingImages: readonly PharoImageInventoryEntry[];
  existingKnown: boolean;
}

function selectedTemplate(
  options: TemplateCreateReadinessOptions,
): {
  installedTemplate?: PharoTemplateInventoryEntry;
  downloadableTemplate?: PharoTemplateInventoryEntry;
  template?: PharoTemplateInventoryEntry;
} {
  const installedTemplate = options.installedTemplates.find((template) =>
    templateMatchesCreateRequest(template, options.request),
  );
  const downloadableTemplate = options.downloadableTemplates.find((template) =>
    templateMatchesCreateRequest(template, options.request),
  );
  const template = installedTemplate ?? downloadableTemplate;
  return { installedTemplate, downloadableTemplate, template };
}

function templateSourceReadinessInput(
  options: TemplateCreateReadinessOptions,
  installedTemplate: PharoTemplateInventoryEntry | undefined,
  downloadableTemplate: PharoTemplateInventoryEntry | undefined,
): PharoLauncherOfflineReadinessInput {
  if (installedTemplate) {
    return {
      name: "templateSource",
      status: "ready",
      templateId: installedTemplate.id,
      ...(installedTemplate.sourcePath
        ? { path: installedTemplate.sourcePath }
        : {}),
      diagnostic:
        "The selected template is present in the active profile template source catalog.",
    };
  }

  return {
    name: "templateSource",
    status: "missing",
    ...(options.config.profile
      ? { path: options.config.profile.templateSourcesDir }
      : {}),
    diagnostic: downloadableTemplate
      ? "The selected template is known only from downloadable inventory, not from the active profile template source catalog."
      : "The selected template is not present in the active profile template source catalog.",
  };
}

function baseImageReadinessInput(
  baseImage: PharoImageInventoryEntry | undefined,
  existingKnown: boolean,
): PharoLauncherOfflineReadinessInput {
  if (baseImage) {
    return {
      name: "baseImage",
      status: "ready",
      imageId: baseImage.id,
      ...(baseImage.imagePath ? { path: baseImage.imagePath } : {}),
      diagnostic:
        "An existing image proves the selected template base artifact is already local.",
    };
  }

  return {
    name: "baseImage",
    status: existingKnown ? "missing" : "unknown",
    diagnostic: existingKnown
      ? "No existing image proves the selected template base artifact is already local."
      : "Base image artifact readiness is unknown because existing image inventory could not be read.",
  };
}

function readinessStatus(
  inputs: readonly PharoLauncherOfflineReadinessInput[],
): PharoLauncherTemplateCreateReadinessReport["status"] {
  return inputs.some((input) => input.status === "missing")
    ? "missing"
    : inputs.some((input) => input.status === "unknown")
      ? "unknown"
      : "ready";
}

function templateCreateReadiness(
  options: TemplateCreateReadinessOptions,
): PharoLauncherTemplateCreateReadinessReport {
  const { installedTemplate, downloadableTemplate, template } =
    selectedTemplate(options);
  const baseImage =
    template &&
    options.existingImages.find((image) => imageMatchesTemplate(image, template));

  const inputs: PharoLauncherOfflineReadinessInput[] = [
    templateSourceReadinessInput(
      options,
      installedTemplate,
      downloadableTemplate,
    ),
    baseImageReadinessInput(baseImage, options.existingKnown),
    findLocalVmProof(options.config, template),
  ];

  return {
    status: readinessStatus(inputs),
    request: options.request,
    inputs,
    ...(template ? { template } : {}),
    ...(baseImage ? { baseImage } : {}),
    diagnostics: inputs
      .filter((input) => input.status !== "ready")
      .map((input) => input.diagnostic),
  };
}

export async function getPharoLauncherInventory(
  runner: LauncherCliRunner = runLauncherCli,
  config: PharoLauncherConfig = loadPharoLauncherConfig(),
  options: PharoLauncherInventoryOptions = {},
): Promise<PharoLauncherInventoryReport> {
  const diagnostics: PharoLauncherInventoryDiagnostic[] = [];
  const configReport = getPharoLauncherConfigReport(config);
  const activeProfile = getInventoryProfile(config);
  const profiles = {
    ...(activeProfile ? { active: activeProfile } : {}),
    available: activeProfile ? [activeProfile] : [],
  };

  addConfigurationDiagnostics(config, diagnostics);
  addProfileDiagnostics(config, diagnostics);

  const installedTemplates = readInstalledTemplates(config, diagnostics);
  const probes: PharoLauncherInventoryReport["probes"] = {};
  let downloadableTemplates: PharoTemplateInventoryEntry[] = [];
  let existingImages: PharoImageInventoryEntry[] = [];
  let downloadableKnown = false;
  let existingKnown = false;

  if (!diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    try {
      const templateList = await runInventoryProbe(
        "pharo_launcher_template_list",
        ["template", "list", "--ston"],
        runner,
        config,
        options.timeoutMs,
      );
      const diagnostic = addCommandDiagnostic(
        diagnostics,
        "downloadable_template_probe_failed",
        "Downloadable template inventory",
        templateList,
      );
      probes.templateList = probeSummary(templateList, diagnostic);
      downloadableKnown = templateList.ok;
      downloadableTemplates = templateList.ok
        ? templatesFromData(templateList.data)
            .map((template) => inventoryTemplate("downloadable", template))
            .filter(
              (template): template is PharoTemplateInventoryEntry =>
                template !== undefined,
            )
        : [];
    } catch (error) {
      probes.templateList = {
        ok: false,
        args: ["template", "list", "--ston"],
        parserStatus: "skipped",
        durationMs: 0,
        exitCode: null,
        timedOut: false,
        diagnostic: addProbeErrorDiagnostic(
          diagnostics,
          "downloadable_template_probe_error",
          "Downloadable template inventory",
          error,
        ),
      };
    }

    try {
      const imageList = await runInventoryProbe(
        "pharo_launcher_image_list",
        ["image", "list", "--ston"],
        runner,
        config,
        options.timeoutMs,
      );
      const diagnostic = addCommandDiagnostic(
        diagnostics,
        "existing_image_probe_failed",
        "Existing image inventory",
        imageList,
      );
      probes.imageList = probeSummary(imageList, diagnostic);
      existingKnown = imageList.ok;
      existingImages = imageList.ok
        ? imagesFromData(imageList.data)
            .map(inventoryImage)
            .filter(
              (image): image is PharoImageInventoryEntry =>
                image !== undefined,
            )
        : [];
    } catch (error) {
      probes.imageList = {
        ok: false,
        args: ["image", "list", "--ston"],
        parserStatus: "skipped",
        durationMs: 0,
        exitCode: null,
        timedOut: false,
        diagnostic: addProbeErrorDiagnostic(
          diagnostics,
          "existing_image_probe_error",
          "Existing image inventory",
          error,
        ),
      };
    }
  }

  const allTemplates = [...installedTemplates, ...downloadableTemplates];
  if (
    downloadableKnown &&
    installedTemplates.length === 0 &&
    downloadableTemplates.length === 0
  ) {
    addEmptyTemplateInventoryDiagnostic(diagnostics, config);
  }
  const readiness = options.templateCreateRequest
    ? templateCreateReadiness({
        config,
        request: options.templateCreateRequest,
        installedTemplates,
        downloadableTemplates,
        existingImages,
        existingKnown,
      })
    : undefined;

  return {
    ok: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    service: "pharo-launcher-mcp",
    config: configReport,
    profiles,
    templates: {
      installed: installedTemplates,
      downloadable: downloadableTemplates,
      downloadableKnown,
    },
    versions: collectVersions(allTemplates, existingImages),
    images: {
      existing: existingImages,
      existingKnown,
      declared: [...(options.declaredImages ?? [])],
    },
    probes,
    ...(readiness ? { templateCreateReadiness: readiness } : {}),
    diagnostics,
  };
}

function isVersionTokenCharacter(char: string): boolean {
  return (
    (char >= "0" && char <= "9") ||
    (char >= "A" && char <= "Z") ||
    (char >= "a" && char <= "z") ||
    char === "." ||
    char === "-" ||
    char === "+" ||
    char === "_"
  );
}

function isVersionLikeToken(token: string): boolean {
  let digitCount = 0;
  let dotCount = 0;

  for (const char of token) {
    if (char >= "0" && char <= "9") {
      digitCount += 1;
    } else if (char === ".") {
      dotCount += 1;
    }
  }

  return digitCount > 0 && dotCount > 0 && token[0] !== "." && token.at(-1) !== ".";
}

function firstVersionLikeToken(output: string): string | undefined {
  let tokenStart: number | undefined;

  for (let index = 0; index <= output.length; index += 1) {
    const char = output[index];
    if (char !== undefined && isVersionTokenCharacter(char)) {
      tokenStart ??= index;
      continue;
    }

    if (tokenStart === undefined) {
      continue;
    }

    const token = output.slice(tokenStart, index);
    if (isVersionLikeToken(token)) {
      return token;
    }
    tokenStart = undefined;
  }

  return undefined;
}

function parseVersion(result: LauncherCliResult): string | undefined {
  const output = `${result.stdout}\n${result.stderr}`;
  return firstVersionLikeToken(output);
}

export async function getPharoLauncherVersion(
  runner: LauncherCliRunner = runLauncherCli,
  config: PharoLauncherConfig = loadPharoLauncherConfig(),
): Promise<PharoLauncherVersionReport> {
  const command = await runner(["--version"], {
    config,
    timeoutMs: 10_000,
  });

  return {
    ok: command.exitCode === 0 && !command.timedOut,
    version: parseVersion(command),
    command,
  };
}

export async function validatePharoLauncherInstallation(
  runner: LauncherCliRunner = runLauncherCli,
  config: PharoLauncherConfig = loadPharoLauncherConfig(),
): Promise<PharoLauncherValidationReport> {
  const report = getPharoLauncherConfigReport(config);
  const args = ["--version"];

  try {
    const result = await runner(args, {
      config,
      timeoutMs: 10_000,
    });
    const harmlessCliCall = {
      args,
      ok: result.exitCode === 0 && !result.timedOut,
      result,
    };

    return {
      ok:
        report.launcherDir.exists &&
        report.launcherVm.exists &&
        report.launcherImage.exists &&
        report.launcherScript.exists &&
        harmlessCliCall.ok,
      config: report,
      harmlessCliCall,
    };
  } catch (error) {
    return {
      ok: false,
      config: report,
      harmlessCliCall: {
        args,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
