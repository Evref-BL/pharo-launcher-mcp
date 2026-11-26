#!/usr/bin/env node
import { createRequire } from "node:module";
import {
  getPharoLauncherHealth,
  getPharoLauncherVersion,
  validatePharoLauncherInstallation,
} from "./discovery.js";
import { probeImages } from "./probe.js";
import { startStdioServer } from "./server.js";

const usage = `Usage: pharo-launcher-mcp [option]

With no option, serves Pharo Launcher's tools over MCP on standard input and
output. Each option checks something instead, and exits 0 when it holds:

  --health                 the installation's paths, as JSON
  --version-check          the Launcher's version, as JSON
  --validate-installation  that the Launcher starts, as JSON
  --probe-images           that the Launcher lists its images, then what image_list answers
  --version                this package's version
  --help                   this text
`;

function printJson(value: { ok: boolean }): void {
  console.log(JSON.stringify(value, null, 2));
  process.exitCode = value.ok ? 0 : 1;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1) {
    process.stderr.write(`pharo-launcher-mcp takes one option at most.\n\n${usage}`);
    process.exitCode = 2;
    return;
  }

  switch (args[0]) {
    case undefined:
      await startStdioServer();
      return;
    case "--health":
      printJson(getPharoLauncherHealth());
      return;
    case "--version-check":
      printJson(await getPharoLauncherVersion());
      return;
    case "--validate-installation":
      printJson(await validatePharoLauncherInstallation());
      return;
    case "--probe-images": {
      const result = await probeImages();
      process.stderr.write(result.stderr);
      process.stdout.write(result.stdout);
      process.exitCode = result.exitCode;
      return;
    }
    case "--version":
      console.log(
        (createRequire(import.meta.url)("../package.json") as { version: string }).version,
      );
      return;
    case "--help":
    case "-h":
      process.stdout.write(usage);
      return;
    default:
      process.stderr.write(`Unknown option ${args[0]}.\n\n${usage}`);
      process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
