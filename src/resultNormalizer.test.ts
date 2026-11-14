import { describe, expect, it } from "vitest";
import {
  parseLauncherTemplatesFromSton,
  parseLauncherOutput,
} from "./parser.js";
import { normalizeLauncherResult } from "./resultNormalizer.js";

const cliResult = {
  exitCode: 0,
  stdout: "",
  stderr: "",
  durationMs: 12,
  timedOut: false,
};

describe("result normalizer", () => {
  it("normalizes command metadata without raw output by default", () => {
    const result = normalizeLauncherResult(
      "pharo_launcher_template_update",
      ["template", "update"],
      {
        ...cliResult,
        stdout: "Done!",
      },
    );

    expect(result).toEqual({
      ok: true,
      data: {
        message: "Done!",
      },
      parser: {
        status: "unsupported",
        format: "text",
        message: "No parser registered for pharo_launcher_template_update",
      },
      command: {
        args: ["template", "update"],
        durationMs: 12,
        exitCode: 0,
        timedOut: false,
      },
    });
  });

  it("includes raw output when requested", () => {
    const result = normalizeLauncherResult(
      "pharo_launcher_template_update",
      ["template", "update"],
      {
        ...cliResult,
        stdout: "Done!",
        stderr: "warn",
      },
      { includeRaw: true },
    );

    expect(result.raw).toEqual({
      stdout: "Done!",
      stderr: "warn",
      format: "text",
    });
  });

  it("preserves failed command output without data", () => {
    const result = normalizeLauncherResult(
      "pharo_launcher_image_list",
      ["image", "list", "--ston"],
      {
        ...cliResult,
        exitCode: 1,
        stdout: "",
        stderr: "failed",
      },
    );

    expect(result.ok).toBe(false);
    expect(result.data).toBeUndefined();
    expect(result.diagnostic).toBe("failed");
    expect(result.raw).toBeUndefined();
    expect(result.parser).toEqual({
      status: "skipped",
      format: "ston",
      message: "Command failed",
    });
  });

  it("normalizes default template category failures as bootstrap diagnostics", () => {
    const result = normalizeLauncherResult(
      "pharo_launcher_template_list",
      ["template", "list", "--ston"],
      {
        ...cliResult,
        exitCode: 1,
        stdout: "",
        stderr:
          "Image template category 'Official distributions' not found. Categories are: OrderedCollection[]",
      },
    );

    expect(result).toMatchObject({
      ok: false,
      diagnostic:
        "Pharo Launcher could not list default templates because the active template source inventory is empty or not bootstrapped.",
      action: expect.stringContaining(
        "PHARO_LAUNCHER_MCP_TEMPLATE_SOURCES_DIR",
      ),
      parser: {
        status: "skipped",
        format: "ston",
      },
    });
    expect(result.raw).toBeUndefined();
  });

  it("does not normalize explicit template category failures as bootstrap diagnostics", () => {
    const result = normalizeLauncherResult(
      "pharo_launcher_template_list",
      ["template", "list", "--templateCategory", "unknown", "--ston"],
      {
        ...cliResult,
        exitCode: 1,
        stdout: "",
        stderr:
          "Image template category 'unknown' not found. Categories are: OrderedCollection[]",
      },
    );

    expect(result.ok).toBe(false);
    expect(result.diagnostic).toContain("Image template category 'unknown'");
    expect(result.action).toBeUndefined();
  });

  it("normalizes profile-scoped image launch refusals as VM store diagnostics", () => {
    const result = normalizeLauncherResult(
      "pharo_launcher_image_start",
      ["image", "launch", "--script", "bootstrap.st", "ScopedImage"],
      {
        ...cliResult,
        exitCode: 1,
        stdout: "",
        stderr:
          "Refusing profile-scoped image launch before invoking Pharo Launcher.\nThat launch can download, extract, or run VMs outside PHARO_LAUNCHER_MCP_VMS_DIR (/tmp/profile/vms).",
      },
    );

    expect(result).toMatchObject({
      ok: false,
      diagnostic:
        "Profile-scoped image launch was refused because Pharo Launcher can use the default VM store instead of the configured profile VM directory.",
      action: expect.stringContaining("PhLVirtualMachineManager"),
      parser: {
        status: "skipped",
        format: "text",
      },
    });
    expect(result.raw).toBeUndefined();
  });

  it("extracts LauncherTemplate models", () => {
    const templates = parseLauncherTemplatesFromSton(
      "OrderedCollection[PhLRemoteTemplate{#name:'Pharo 13.0 - 64bit (stable)',#url:URL['https://files.pharo.org/image/130/latest-64.zip']}]",
    );

    expect(templates).toEqual([
      {
        name: "Pharo 13.0 - 64bit (stable)",
        url: "https://files.pharo.org/image/130/latest-64.zip",
      },
    ]);
  });

  // The native list hands over its records, so nothing prints them and parses
  // the print back.
  it("takes a process list's records as its data", () => {
    const processes = [
      {
        pid: 3093,
        commandLine: "/vms/Pharo /images/MCP debug/MCP debug.image",
        imagePath: "/images/MCP debug/MCP debug.image",
        imageName: "MCP debug",
      },
    ];

    const result = normalizeLauncherResult(
      "pharo_launcher_process_list",
      ["process", "list"],
      { ...cliResult, stdout: "printed for raw only", processes },
    );

    expect(result).toMatchObject({
      ok: true,
      data: processes,
      parser: { status: "parsed" },
    });
  });

  it("returns unsupported parser status when no parser exists", () => {
    expect(parseLauncherOutput("pharo_launcher_image_copy", "text", "Done!")).toEqual({
      status: "unsupported",
      format: "text",
      message: "No parser registered for pharo_launcher_image_copy",
    });
  });
});
