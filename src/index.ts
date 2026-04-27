#!/usr/bin/env node
import {
  getPharoLauncherHealth,
  getPharoLauncherVersion,
  validatePharoLauncherInstallation,
} from "./discovery.js";
import { runLauncherCli } from "./launcherCli.js";
import { startStdioServer } from "./server.js";

async function main(): Promise<void> {
  if (process.argv.includes("--health")) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          service: "pharo-launcher-mcp",
          health: getPharoLauncherHealth(),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (process.argv.includes("--version-check")) {
    const result = await getPharoLauncherVersion();
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (process.argv.includes("--validate-installation")) {
    const result = await validatePharoLauncherInstallation();
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (process.argv.includes("--probe-images")) {
    const result = await runLauncherCli(["image", "list", "--ston"]);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.exitCode ?? 1;
    return;
  }

  await startStdioServer();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
