import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const binDir = path.resolve(process.cwd(), "bin");

describe("bundled launcher scripts", () => {
  it("keeps the Windows wrapper aligned with the shell wrapper capabilities", () => {
    const script = fs.readFileSync(
      path.join(binDir, "pharo-launcher.cmd"),
      "utf8",
    );

    expect(script).toContain("SCRIPT_DIR=%~dp0");
    expect(script).toContain("PHARO_LAUNCHER_IMAGE");
    expect(script).toContain("PHARO_LAUNCHER_VM");
    expect(script).toContain("--headless");
    expect(script).toContain("--no-default-preferences");
    expect(script).toContain("clap launcher %*");
  });

  it("keeps the shell wrapper headless and argument-preserving", () => {
    const script = fs.readFileSync(
      path.join(binDir, "pharo-launcher.sh"),
      "utf8",
    );

    expect(script).toContain("set -f");
    expect(script).toContain("PHARO_LAUNCHER_IMAGE");
    expect(script).toContain("PHARO_LAUNCHER_VM");
    expect(script).toContain("--headless");
    expect(script).toContain("--no-default-preferences");
    expect(script).toContain('clap launcher "$@"');
  });
});

