import { describe, expect, it } from "vitest";
import {
  parseLauncherTemplatesFromSton,
  parseLauncherOutput,
  parseTemplateCategoriesFromBrief,
} from "./parser.js";
import {
  launcherMessage,
  launcherRefusal,
  normalizeLauncherResult,
} from "./resultNormalizer.js";

const cliResult = {
  exitCode: 0,
  stdout: "",
  stderr: "",
  durationMs: 12,
  timedOut: false,
};

describe("result normalizer", () => {
  it("says how a command ended, and has no data for a command that lists nothing", () => {
    const result = normalizeLauncherResult(["template", "update"], { ...cliResult, stdout: "Done!" });

    expect(result).toEqual({
      ok: true,
      command: { durationMs: 12, exitCode: 0, timedOut: false },
    });
  });

  it("keeps a failed command's output as its diagnostic, without data", () => {
    const result = normalizeLauncherResult(["template", "list", "--ston"], {
      ...cliResult,
      exitCode: 1,
      stderr: "failed",
    });

    expect(result).toEqual({
      ok: false,
      diagnostic: "failed",
      command: { durationMs: 12, exitCode: 1, timedOut: false },
    });
  });

  it.each([
    ["Image template category 'Nope' not found. Please enter a correct image tamplate category name.", "unknown-category"],
    ["Nope not found, please enter a correct category name.", "unknown-category"],
    ["Pharo 99 not found, please enter a correct template name.", "unknown-template"],
    ["Something else went wrong.", undefined],
  ])("reads what the Launcher refused from %j", (stdout, refusal) => {
    expect(launcherRefusal({ ...cliResult, exitCode: 1, stdout })).toBe(refusal);
  });

  // A canned text used to replace any of these, and hid why it failed.
  it.each([
    [
      ["template", "list", "--ston"],
      "Image template category 'Official distributions' not found. Please enter a correct image tamplate category name.",
    ],
    [
      ["image", "launch", "Task"],
      "Cannot tell which VM Task needs: neither its meta-inf.ston, its pharo.version nor its template gives a Pharo version.",
    ],
    [
      ["image", "launch", "Task"],
      "Profile-scoped image launch could not find image file for Task.",
    ],
  ])("keeps the command's own words as the diagnostic of %j", (args, stderr) => {
    const result = normalizeLauncherResult(args, {
      ...cliResult,
      exitCode: 1,
      stderr,
    });

    expect(result.diagnostic).toBe(stderr);
    expect(result.action).toBeUndefined();
  });

  it("reads the brief category listing, with its default", () => {
    const result = normalizeLauncherResult(
      ["template", "categories", "--brief"],
      { ...cliResult, stdout: "*1  Official distributions\n 2  Pharo Mooc\n 10 Moose\n" },
    );

    expect(result).toMatchObject({
      ok: true,
      data: ["Official distributions", "Pharo Mooc", "Moose"],
      defaultCategory: "Official distributions",
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

    const result = normalizeLauncherResult(["process", "list"], {
      ...cliResult,
      stdout: "printed, and not read back",
      processes,
    });

    expect(result).toMatchObject({ ok: true, data: processes });
  });

  it("reads nothing from a command that lists nothing", () => {
    expect(parseLauncherOutput(["image", "copy", "a", "b"], "Done!")).toEqual({ status: "none" });
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
      normalizeLauncherResult(["image", "delete", "x"], killed).command,
    ).toEqual({
      durationMs: 12,
      exitCode: null,
      signal: "SIGKILL",
      timedOut: false,
    });
  });
});
