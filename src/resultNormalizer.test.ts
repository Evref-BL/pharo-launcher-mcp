import { describe, expect, it } from "vitest";
import {
  parseLauncherTemplatesFromSton,
  parseLauncherOutput,
  parseTemplateCategoriesFromBrief,
} from "./parser.js";
import { launcherMessage, normalizeLauncherResult } from "./resultNormalizer.js";

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

  // A canned text used to replace any of these, and hid why it failed.
  it.each([
    [
      "pharo_launcher_template_list",
      ["template", "list", "--ston"],
      "Image template category 'Official distributions' not found. Please enter a correct image tamplate category name.",
    ],
    [
      "pharo_launcher_image_start",
      ["image", "launch", "Task"],
      "Cannot tell which VM Task needs: neither its meta-inf.ston, its pharo.version nor its template gives a Pharo version.",
    ],
    [
      "pharo_launcher_image_start",
      ["image", "launch", "Task"],
      "Profile-scoped image launch could not find image file for Task.",
    ],
  ])("keeps the command's own words as the diagnostic of %s", (toolName, args, stderr) => {
    const result = normalizeLauncherResult(toolName, args, {
      ...cliResult,
      exitCode: 1,
      stderr,
    });

    expect(result.diagnostic).toBe(stderr);
    expect(result.action).toBeUndefined();
  });

  it("carries an image start's launch report", () => {
    const launch = { by: "launcher" as const, pid: 73100 };

    expect(
      normalizeLauncherResult(
        "pharo_launcher_image_start",
        ["image", "launch", "--detached", "Task"],
        { ...cliResult, launch },
      ).launch,
    ).toEqual(launch);
  });

  it("reads the brief category listing, with its default", () => {
    const result = normalizeLauncherResult(
      "pharo_launcher_template_category_list",
      ["template", "categories", "--brief"],
      { ...cliResult, stdout: "*1  Official distributions\n 2  Pharo Mooc\n 10 Moose\n" },
    );

    expect(result).toMatchObject({
      ok: true,
      data: ["Official distributions", "Pharo Mooc", "Moose"],
      defaultCategory: "Official distributions",
      parser: { status: "parsed" },
    });
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

  // A PhLLocalTemplate is the user's own; the reader used to look for two
  // class names only, and missed it.
  it("lists every kind of template in the Launcher's order, and no group", () => {
    const templates = parseLauncherTemplatesFromSton(
      "OrderedCollection[" +
        "PhLRemoteTemplate{#name:'Pharo 14.0 - 64bit (next stable)',#url:URL['https://files.pharo.org/image/140/latest-64.zip']}," +
        "PhLLocalTemplate{#name:'My ''own'' template',#zipFile:FileReference{#path:'/x/my.zip'}}," +
        "PhLTemplateGroup{#name:'Not a template'}," +
        "PhLRemoteTemplate { #name : 'Pharo 13.0 - 64bit (stable)' }" +
        "]",
    );

    expect(templates).toEqual([
      {
        name: "Pharo 14.0 - 64bit (next stable)",
        url: "https://files.pharo.org/image/140/latest-64.zip",
      },
      { name: "My 'own' template", local: true },
      { name: "Pharo 13.0 - 64bit (stable)" },
    ]);
  });

  // ConsoleListFormatter>>printAttributeRows: the default mark or a space, the
  // index padded right to two, one space, the name. No header with --brief.
  it.each([
    [
      "with a default",
      "*1  Official distributions\n 2  Pharo Mooc\n 10 Moose\n",
      ["Official distributions", "Pharo Mooc", "Moose"],
      "Official distributions",
    ],
    ["with none", "1  Official distributions\n2  Pharo Mooc\n", ["Official distributions", "Pharo Mooc"], undefined],
    ["with the default second", " 1 A\r\n*2 B b\r\n", ["A", "B b"], "B b"],
    ["with no category", "", [], undefined],
  ])("reads brief categories %s", (_label, source, categories, defaultCategory) => {
    expect(parseTemplateCategoriesFromBrief(source)).toEqual({
      categories,
      ...(defaultCategory ? { defaultCategory } : {}),
    });
  });

  it("says a signal ended a command that wrote nothing, and carries the signal", () => {
    const killed = { ...cliResult, exitCode: null, signal: "SIGKILL" as const };

    expect(launcherMessage(killed)).toBe("it was killed by signal SIGKILL");
    expect(launcherMessage({ ...killed, stderr: "Killed." })).toBe("Killed.");
    expect(
      normalizeLauncherResult("pharo_launcher_image_delete", ["image", "delete", "x"], killed).command,
    ).toEqual({
      args: ["image", "delete", "x"],
      durationMs: 12,
      exitCode: null,
      signal: "SIGKILL",
      timedOut: false,
    });
  });
});
