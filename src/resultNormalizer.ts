import type { LauncherCliResult } from "./launcherCli.js";
import type {
  LauncherCommandResult,
  LauncherImage,
  LauncherOutputFormat,
} from "./models.js";
import { parseLauncherOutput } from "./parser.js";

function outputFormat(args: readonly string[]): LauncherOutputFormat {
  return args.includes("--ston") ? "ston" : "text";
}

function trimmedMessage(source: string): string | undefined {
  const message = source.trim();
  return message ? message : undefined;
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
      "Inspect pharo_launcher_inventory diagnostics, verify PHARO_LAUNCHER_MCP_TEMPLATE_SOURCES_DIR, and refresh or seed the active profile template sources before planning image creation.",
  };
}

function scopedFromBuildVmStoreDiagnostic(
  toolName: string,
  result: LauncherCliResult,
): Pick<LauncherCommandResult, "diagnostic" | "action"> | undefined {
  if (
    toolName !== "pharo_launcher_image_create_from_build" ||
    !result.stderr.includes("profile-scoped image create fromBuild")
  ) {
    return undefined;
  }

  return {
    diagnostic:
      "Profile-scoped fromBuild was refused because Pharo Launcher can launch with the default VM store instead of the configured profile VM directory.",
    action:
      "Use a non-fromBuild creation path with explicit launch control, or fix Pharo Launcher to initialize PhLVirtualMachineManager from the CLI configuration before fromBuild launch.",
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
    diagnostic ?? scopedFromBuildVmStoreDiagnostic(toolName, result);

  return {
    ok,
    ...(ok && data !== undefined ? { data } : {}),
    ...(commandDiagnostic ?? {}),
    parser: {
      status: parseResult.status,
      format: parseResult.format,
      ...(parseResult.message ? { message: parseResult.message } : {}),
    },
    raw: {
      stdout: result.stdout,
      stderr: result.stderr,
      format,
    },
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
