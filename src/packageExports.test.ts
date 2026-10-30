import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface PackageManifest {
  bin: Record<string, string>;
  main: string;
  types: string;
  exports: Record<string, string>;
}

// fileURLToPath, not URL.pathname: on Windows the latter is "/C:/..." and
// every path built from it is wrong.
const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  fs.readFileSync(path.join(packageRoot, "..", "package.json"), "utf8"),
) as PackageManifest;

/** `./dist/config.js` is built from `src/config.ts`, which is what exists here. */
function sourceFor(distPath: string): string {
  return path.join(
    packageRoot,
    "..",
    distPath.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts"),
  );
}

describe("package exports", () => {
  it("exports a subpath for every file a consumer may import", () => {
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      if (subpath === "./package.json") {
        continue;
      }

      expect(
        fs.existsSync(sourceFor(target)),
        `${subpath} points at ${target}, which no source file builds`,
      ).toBe(true);
    }
  });

  it("does not make the executable the package entry point", () => {
    // dist/index.js starts an MCP server on stdio when it is loaded, so
    // importing the package must not reach it. It is the bin, nothing else.
    expect(manifest.bin["pharo-launcher-mcp"]).toBe("dist/index.js");
    expect(Object.values(manifest.exports)).not.toContain("./dist/index.js");
    expect(manifest.main).not.toContain("index.js");
    expect(manifest.types).not.toContain("index.d.ts");
  });
});
