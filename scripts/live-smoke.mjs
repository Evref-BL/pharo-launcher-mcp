#!/usr/bin/env node
/**
 * Run this package's live checks against a real PharoLauncher, in a profile of
 * its own so nothing touches the launcher you use.
 *
 * This replaces three PowerShell scripts. They asked the same questions, but
 * only on Windows: they read `%LOCALAPPDATA%\Pharo Launcher` directly, wrote
 * backslash paths, and left the other two platforms this package supports with
 * no way to run any of it. Everything they needed to be portable is already
 * here — `./platform` knows where a launcher lives on each platform, and the
 * checks themselves are four flags on the bin.
 *
 *   node scripts/live-smoke.mjs
 *   node scripts/live-smoke.mjs --profile live-test --force
 *   node scripts/live-smoke.mjs --skip-build
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function usage() {
  return [
    "Usage:",
    "  node scripts/live-smoke.mjs [options]",
    "",
    "Options:",
    "  --profile <name>      Profile name. Defaults to live-test.",
    "  --state-root <path>   Profile root. Defaults to",
    "                        <repo parent>/.pharo-launcher-mcp/profiles/<name>.",
    "  --source-image <path> Launcher image to copy. Defaults to this",
    "                        platform's installed PharoLauncher.",
    "  --force               Overwrite a launcher image already in the profile.",
    "  --skip-build          Use dist as it is.",
    "  --help",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { profile: "live-test" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`${argument} needs a value`);
      }
      index += 1;
      return value;
    };

    switch (argument) {
      case "--profile":
        options.profile = next();
        break;
      case "--state-root":
        options.stateRoot = next();
        break;
      case "--source-image":
        options.sourceImage = next();
        break;
      case "--force":
        options.force = true;
        break;
      case "--skip-build":
        options.skipBuild = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

function run(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.error) {
    throw new Error(`${label} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${label} exited ${result.status}`);
  }
}

/** The directories a launcher profile is made of, and the env that names them. */
function profileLayout(stateRoot) {
  const launcherDir = path.join(stateRoot, "launcher");
  return {
    launcherDir,
    directories: [
      stateRoot,
      launcherDir,
      path.join(stateRoot, "images"),
      path.join(stateRoot, "vms"),
      path.join(stateRoot, "templates"),
      path.join(stateRoot, "init-scripts"),
      path.join(stateRoot, "logs"),
    ],
    environment: {
      PHARO_LAUNCHER_MCP_STATE_ROOT: stateRoot,
      PHARO_LAUNCHER_MCP_LAUNCHER_IMAGE: path.join(
        launcherDir,
        "PharoLauncher.image",
      ),
      PHARO_LAUNCHER_MCP_IMAGES_DIR: path.join(stateRoot, "images"),
      PHARO_LAUNCHER_MCP_VMS_DIR: path.join(stateRoot, "vms"),
      PHARO_LAUNCHER_MCP_TEMPLATE_SOURCES_DIR: path.join(stateRoot, "templates"),
      PHARO_LAUNCHER_MCP_INIT_SCRIPTS_DIR: path.join(stateRoot, "init-scripts"),
      PHARO_LAUNCHER_MCP_LOGS_DIR: path.join(stateRoot, "logs"),
      PHARO_LAUNCHER_MCP_LAUNCHER_CONFIGURATION: path.join(
        launcherDir,
        "pharo-launcher-cli-config.ston",
      ),
    },
  };
}

function copyInto(source, destination, force, label) {
  if (!fs.existsSync(source)) {
    return `no ${label} beside the launcher image: ${source}`;
  }
  if (fs.existsSync(destination) && !force) {
    return `${label} already in the profile: ${destination} (--force overwrites)`;
  }
  fs.copyFileSync(source, destination);
  return `copied ${label}: ${source} -> ${destination}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }

  if (!options.skipBuild) {
    run("npm", ["run", "build"], "npm run build");
  }

  // Asked of the package rather than reimplemented, and asked through the
  // discovery it actually uses: `defaultLauncherDir` answers
  // ~/Library/Application Support/Pharo Launcher on macOS, where a standard
  // install is /Applications/PharoLauncher.app, and describeConfig is what
  // resolves that — the same answer PLexus opens images with.
  const { openPharoLauncher } = await import(
    path.join(repoRoot, "dist", "launcher.js")
  );
  const discovered = openPharoLauncher().describeConfig();

  const stateRoot = path.resolve(
    options.stateRoot ??
      path.join(
        path.dirname(repoRoot),
        ".pharo-launcher-mcp",
        "profiles",
        options.profile,
      ),
  );
  const layout = profileLayout(stateRoot);
  for (const directory of layout.directories) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const sourceImage =
    options.sourceImage ??
    process.env.PHARO_LAUNCHER_IMAGE ??
    discovered.launcherImage?.path ??
    discovered.installationLauncherImage?.path;
  if (!sourceImage || !fs.existsSync(sourceImage)) {
    throw new Error(
      `Source PharoLauncher image not found: ${sourceImage ?? "nothing discovered"}\n` +
        `Discovery reported ${discovered.discovery?.source ?? "no source"}.\n` +
        "Pass --source-image, or set PHARO_LAUNCHER_DIR or PHARO_LAUNCHER_IMAGE.",
    );
  }
  console.log(`launcher: ${discovered.discovery?.source ?? "unknown"}`);

  const profileImage = layout.environment.PHARO_LAUNCHER_MCP_LAUNCHER_IMAGE;
  console.log(
    copyInto(sourceImage, profileImage, options.force, "launcher image"),
  );
  console.log(
    copyInto(
      `${sourceImage.slice(0, -path.extname(sourceImage).length)}.changes`,
      `${profileImage.slice(0, -".image".length)}.changes`,
      options.force,
      "launcher changes",
    ),
  );

  const environment = {
    PHARO_LAUNCHER_MCP_PROFILE: options.profile,
    ...layout.environment,
  };
  Object.assign(process.env, environment);

  // A plain KEY=value file, which every shell can read and the PowerShell one
  // could not be: `set -a; . profile.env` in sh, or read it in a test.
  const environmentFile = path.join(stateRoot, "profile.env");
  fs.writeFileSync(
    environmentFile,
    `${Object.entries(environment)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
  );

  console.log("");
  console.log(`profile: ${options.profile}`);
  console.log(`root:    ${stateRoot}`);
  console.log(`env:     ${environmentFile}`);

  const bin = path.join(repoRoot, "dist", "index.js");
  for (const check of [
    "--health",
    "--version-check",
    "--validate-installation",
    "--probe-images",
  ]) {
    console.log("");
    console.log(`live smoke: ${check.slice(2)}`);
    run(process.execPath, [bin, check], `${check} check`);
  }

  console.log("");
  console.log("Live smoke completed.");
  return 0;
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("");
    console.error(usage());
    process.exitCode = 1;
  });
