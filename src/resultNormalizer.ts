import type { LauncherCliResult } from "./launcherCli.js";
import type { LauncherCommandResult, LauncherCommandRun } from "./models.js";
import { parseLauncherOutput } from "./parser.js";

const defaultDiagnosticTailLength = 2_000;

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

/**
 * A Launcher command's result as a call answers it: whether it did what it
 * was asked, its records read from what it wrote, and why it failed.
 */
export function normalizeLauncherResult(
  args: readonly string[],
  result: LauncherCliResult,
): LauncherCommandResult<unknown> & { defaultCategory?: string } {
  const command = commandRun(result);
  if (result.exitCode !== 0 || result.timedOut) {
    // A command's own output is its diagnostic: nothing here rewrites it. One
    // that wrote nothing is said by how it ended.
    return {
      ok: false,
      diagnostic:
        failedOutputDiagnostic(result, defaultDiagnosticTailLength)?.diagnostic ??
        launcherMessage(result),
      command,
    };
  }

  // A native process list hands over its records: nothing to read back.
  if (result.processes && args[0] === "process" && args[1] === "list") {
    return { ok: true, data: result.processes, command };
  }

  const parsed = parseLauncherOutput(args, result.stdout);
  if (parsed.status === "failed") {
    return {
      ok: false,
      diagnostic: sentenceWithMessage("Could not read what Pharo Launcher listed", parsed.message),
      command,
    };
  }

  return parsed.status === "parsed"
    ? {
        ok: true,
        data: parsed.data,
        ...(parsed.defaultCategory ? { defaultCategory: parsed.defaultCategory } : {}),
        command,
      }
    : { ok: true, command };
}

/** How a command ended. */
export function commandRun(result: LauncherCliResult): LauncherCommandRun {
  return {
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    ...(result.signal ? { signal: result.signal } : {}),
    timedOut: result.timedOut,
    ...(result.timeoutReason ? { timeoutReason: result.timeoutReason } : {}),
  };
}

/**
 * What the Launcher refused, read from what it wrote: a template or a
 * category it does not know.
 */
export function launcherRefusal(
  result: LauncherCliResult,
): "unknown-template" | "unknown-category" | undefined {
  const output = `${result.stdout}\n${result.stderr}`;
  if (
    /not found, please enter a correct category name/i.test(output) ||
    /Image template category '.*?' not found/i.test(output)
  ) {
    return "unknown-category";
  }
  return /not found, please enter a correct (?:short )?template name/i.test(output)
    ? "unknown-template"
    : undefined;
}
