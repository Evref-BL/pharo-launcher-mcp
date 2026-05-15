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

  return {
    ok,
    ...(ok && data !== undefined ? { data } : {}),
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
