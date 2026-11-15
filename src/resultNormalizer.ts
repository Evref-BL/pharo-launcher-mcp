import type { LauncherCliResult } from "./launcherCli.js";
import type { LauncherCommandResult, LauncherOutputFormat } from "./models.js";
import { parseLauncherOutput, type ParseResult } from "./parser.js";

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

/** What a command wrote, trimmed, its middle left out when it is long. */
export function outputTail(
  source: string,
  maxLength = defaultDiagnosticTailLength,
): string | undefined {
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

/**
 * A message put at the end of a sentence: no second period when it ends with
 * one, and after a colon, its lines indented, when it has several.
 */
export function sentenceWithMessage(sentence: string, message: string): string {
  const lines = message.trim().split(/\r?\n/);
  if (lines.length > 1) {
    return `${sentence}:\n${lines.map((line) => (line ? `  ${line}` : "")).join("\n")}`;
  }

  const line = lines[0] ?? "";
  return `${sentence}: ${line}${line.endsWith(".") ? "" : "."}`;
}

/** What a Launcher command said when it failed. */
export function launcherMessage(result: LauncherCliResult): string {
  return (
    outputTail(result.stderr) ??
    outputTail(result.stdout) ??
    result.timeoutReason ??
    (result.signal
      ? `it was killed by signal ${result.signal}`
      : `it exited with ${result.exitCode ?? "no exit code"}`)
  );
}

export function normalizeLauncherResult(
  toolName: string,
  args: readonly string[],
  result: LauncherCliResult,
  options: NormalizeLauncherResultOptions = {},
): LauncherCommandResult {
  const ok = result.exitCode === 0 && !result.timedOut;
  const format = outputFormat(args);
  // A native process list hands over its records: nothing to parse back.
  const parseResult: Omit<ParseResult, "status"> & {
    status: ParseResult["status"] | "skipped";
  } = !ok
    ? { status: "skipped" as const, format, message: "Command failed" }
    : toolName === "pharo_launcher_process_list" && result.processes
      ? { status: "parsed" as const, format, data: result.processes }
      : parseLauncherOutput(toolName, format, result.stdout);
  const data =
    parseResult.status === "parsed"
      ? parseResult.data
      : ok && parseResult.status === "unsupported"
        ? { message: trimmedMessage(result.stdout) }
        : undefined;
  // A command's own output is its diagnostic: nothing here rewrites it.
  const commandDiagnostic = !ok
    ? failedOutputDiagnostic(
        result,
        options.diagnosticTailLength ?? defaultDiagnosticTailLength,
      )
    : undefined;
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
      ...(result.signal ? { signal: result.signal } : {}),
      timedOut: result.timedOut,
      ...(result.timeoutReason
        ? { timeoutReason: result.timeoutReason }
        : {}),
    },
    ...(result.launch ? { launch: result.launch } : {}),
    ...(ok && parseResult.defaultCategory
      ? { defaultCategory: parseResult.defaultCategory }
      : {}),
  };
}
