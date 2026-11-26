import { loadPharoLauncherConfig } from "./config.js";
import type { CallToolOptions } from "./launcher.js";
import { runLauncherCli } from "./launcherCli.js";
import { callTool } from "./server.js";

/** What `--probe-images` prints, and the status it exits with. */
export interface ProbeImagesOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * `pharo-launcher-mcp --probe-images`. It asks the Launcher itself to list
 * its images, which checks that the CLI starts and reads this scope's
 * configuration, and exits with that command's status; what the Launcher
 * wrote goes to standard error only when it failed. Then it prints what
 * `image_list` answers, which reads the images directory.
 */
export async function probeImages(options: CallToolOptions = {}): Promise<ProbeImagesOutcome> {
  const config = options.config ?? loadPharoLauncherConfig();
  const runner = options.runner ?? runLauncherCli;
  const listed = await runner(["image", "list", "--rowMode"], {
    config,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  const exitCode = listed.exitCode === 0 && !listed.timedOut ? 0 : listed.exitCode || 1;
  const answer = await callTool("image_list", {}, { ...options, config });

  return {
    exitCode,
    stdout: `${answer.content.map((part) => part.text).join("\n")}\n`,
    stderr:
      exitCode === 0
        ? ""
        : [listed.stdout, listed.stderr]
            .filter((output) => output.trim().length > 0)
            .map((output) => (output.endsWith("\n") ? output : `${output}\n`))
            .join(""),
  };
}
