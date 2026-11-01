import type { LauncherCliResult } from "./launcherCli.js";
import type {
  LauncherCommandResult,
  LauncherImage,
  LauncherOutputFormat,
} from "./models.js";
import { parseLauncherOutput } from "./parser.js";

export interface NormalizeLauncherResultOptions {
  includeRaw?: boolean;
  diagnosticTailLength?: number;
}

const defaultDiagnosticTailLength = 2_000;

function outputFormat(args: readonly string[]): LauncherOutputFormat {
  return args.includes("--ston") ? "ston" : "text";
}

function trimmedMessage(source: string): string | undefined {
  const message = source.trim();
  return message ? message : undefined;
}

function outputTail(source: string, maxLength: number): string | undefined {
  const message = trimmedMessage(source);
  if (!message) {
    return undefined;
  }

  if (message.length <= maxLength) {
    return message;
  }

  const headLength = Math.min(400, Math.floor(maxLength / 4));
  const omissionMarker = "\n...\n";
  const tailLength = maxLength - headLength - omissionMarker.length;
  return `${message.slice(0, headLength)}${omissionMarker}${message.slice(
    message.length - tailLength,
  )}`;
}

function failedOutputDiagnostic(
  result: LauncherCliResult,
  maxLength: number,
): Pick<LauncherCommandResult, "diagnostic"> | undefined {
  const stderr = outputTail(result.stderr, maxLength);
  if (stderr) {
    return { diagnostic: stderr };
  }

  const stdout = outputTail(result.stdout, maxLength);
  return stdout ? { diagnostic: stdout } : undefined;
}

function optionValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasImageName(value: LauncherImage): boolean {
  return typeof value.name === "string" && value.name.length > 0;
}

function templateSourceBootstrapDiagnostic(
  toolName: string,
  args: readonly string[],
  result: LauncherCliResult,
): Pick<LauncherCommandResult, "diagnostic" | "action"> | undefined {
  if (toolName !== "pharo_launcher_template_list") {
    return undefined;
  }

  const output = `${result.stdout}\n${result.stderr}`;
  if (
    !/Image template category '.*' not found/i.test(output) ||
    args.includes("--templateCategory")
  ) {
    return undefined;
  }

  return {
    diagnostic:
      "Pharo Launcher could not list default templates because the active template source inventory is empty or not bootstrapped.",
    action:
      "Verify PHARO_LAUNCHER_MCP_TEMPLATE_SOURCES_DIR, then refresh or seed the active profile template sources with pharo_launcher_template_update before planning image creation.",
  };
}

function scopedImageLaunchVmStoreDiagnostic(
  toolName: string,
  result: LauncherCliResult,
): Pick<LauncherCommandResult, "diagnostic" | "action"> | undefined {
  if (toolName !== "pharo_launcher_image_start") {
    return undefined;
  }

  if (result.stderr.includes("Refusing profile-scoped image launch")) {
    return {
      diagnostic:
        "Profile-scoped image launch was refused because Pharo Launcher can use the default VM store instead of the configured profile VM directory.",
      action:
        "Launch from an explicit profile only after Pharo Launcher initializes PhLVirtualMachineManager from the CLI configuration, or after pharo-launcher-mcp has a verified launch path that keeps VM artifacts inside PHARO_LAUNCHER_MCP_VMS_DIR.",
    };
  }

  if (!result.stderr.includes("Profile-scoped image launch")) {
    return undefined;
  }

  return {
    diagnostic:
      "Profile-scoped image launch could not prepare the profile-local image and VM paths needed for direct launch.",
    action:
      "Inspect pharo_launcher_image_info, PHARO_LAUNCHER_MCP_IMAGES_DIR and PHARO_LAUNCHER_MCP_VMS_DIR before retrying the launch.",
  };
}

function withImageName(value: unknown, imageName: string | undefined): unknown {
  if (!imageName) {
    return value;
  }

  if (Array.isArray(value)) {
    if (value.length !== 1) {
      return value;
    }

    const item = value[0];
    if (typeof item !== "object" || item === null || hasImageName(item)) {
      return value;
    }

    return [{ ...item, name: imageName }];
  }

  if (typeof value === "object" && value !== null && !hasImageName(value)) {
    return { ...value, name: imageName };
  }

  return value;
}

function commandContextData(
  toolName: string,
  args: readonly string[],
  data: unknown,
): unknown {
  switch (toolName) {
    case "pharo_launcher_image_list":
      return withImageName(data, optionValue(args, "--nameFilter"));

    case "pharo_launcher_image_info":
      return withImageName(data, args.at(-1));

    default:
      return data;
  }
}

export function normalizeLauncherResult(
  toolName: string,
  args: readonly string[],
  result: LauncherCliResult,
  options: NormalizeLauncherResultOptions = {},
): LauncherCommandResult {
  const ok = result.exitCode === 0 && !result.timedOut;
  const format = outputFormat(args);
  const parseResult = ok
    ? parseLauncherOutput(toolName, format, result.stdout)
    : { status: "skipped" as const, format, message: "Command failed" };
  const parsedData =
    parseResult.status === "parsed"
      ? parseResult.data
      : ok && parseResult.status === "unsupported"
        ? { message: trimmedMessage(result.stdout) }
        : undefined;
  const data =
    parseResult.status === "parsed"
      ? commandContextData(toolName, args, parsedData)
      : parsedData;
  const diagnostic = templateSourceBootstrapDiagnostic(toolName, args, result);
  const commandDiagnostic =
    diagnostic ??
    scopedImageLaunchVmStoreDiagnostic(toolName, result) ??
    (!ok
      ? failedOutputDiagnostic(
          result,
          options.diagnosticTailLength ?? defaultDiagnosticTailLength,
        )
      : undefined);
  const raw = {
    stdout: result.stdout,
    stderr: result.stderr,
    format,
  };

  return {
    ok,
    ...(ok && data !== undefined ? { data } : {}),
    ...(commandDiagnostic ?? {}),
    parser: {
      status: parseResult.status,
      format: parseResult.format,
      ...(parseResult.message ? { message: parseResult.message } : {}),
    },
    ...(options.includeRaw ? { raw } : {}),
    command: {
      args: [...args],
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      ...(result.timeoutReason
        ? { timeoutReason: result.timeoutReason }
        : {}),
    },
  };
}
