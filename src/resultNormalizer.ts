import type { LauncherCliResult } from "./launcherCli.js";
import type {
  LauncherCommandResult,
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
  const data =
    parseResult.status === "parsed"
      ? parseResult.data
      : ok && parseResult.status === "unsupported"
        ? { message: trimmedMessage(result.stdout) }
        : undefined;

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

