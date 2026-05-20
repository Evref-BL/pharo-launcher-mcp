import { describe, expect, it } from "vitest";
import {
  parseLauncherImagesFromSton,
  parseLauncherProcessesFromText,
  parseLauncherTemplatesFromSton,
  parseLauncherVmsFromSton,
  parseLauncherImagesFromText,
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
  it("normalizes command metadata and raw output", () => {
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
      raw: {
        stdout: "Done!",
        stderr: "",
        format: "text",
      },
      command: {
        args: ["template", "update"],
        durationMs: 12,
        exitCode: 0,
        timedOut: false,
      },
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
    expect(result.raw).toEqual({
      stdout: "",
      stderr: "failed",
      format: "ston",
    });
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
      raw: {
        stderr: expect.stringContaining("Official distributions"),
      },
    });
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
    expect(result.diagnostic).toBeUndefined();
    expect(result.action).toBeUndefined();
  });

  it("normalizes profile-scoped fromBuild refusals as VM store diagnostics", () => {
    const result = normalizeLauncherResult(
      "pharo_launcher_image_create_from_build",
      [
        "image",
        "create",
        "fromBuild",
        "--pharoVersion",
        "13",
        "--newImageName",
        "ScopedBuild",
        "1",
      ],
      {
        ...cliResult,
        exitCode: 1,
        stdout: "",
        stderr:
          "Refusing profile-scoped image create fromBuild before invoking Pharo Launcher.\nThat launch can download or run VMs outside PHARO_LAUNCHER_MCP_VMS_DIR (/tmp/profile/vms).",
      },
    );

    expect(result).toMatchObject({
      ok: false,
      diagnostic:
        "Profile-scoped fromBuild was refused because Pharo Launcher can launch with the default VM store instead of the configured profile VM directory.",
      action: expect.stringContaining("PhLVirtualMachineManager"),
      parser: {
        status: "skipped",
        format: "text",
      },
      raw: {
        stderr: expect.stringContaining("PHARO_LAUNCHER_MCP_VMS_DIR"),
      },
    });
  });

  it("normalizes profile-scoped image launch refusals as VM store diagnostics", () => {
    const result = normalizeLauncherResult(
      "pharo_launcher_image_launch",
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
      raw: {
        stderr: expect.stringContaining("PHARO_LAUNCHER_MCP_VMS_DIR"),
      },
    });
  });

  it("extracts LauncherImage models from STON output", () => {
    const images = parseLauncherImagesFromSton(
      "OrderedCollection[PhLImage{#formatNumber:68021,#architecture:'64',#pharoVersion:'130',#originTemplate:PhLRemoteTemplate{#name:'Pharo 13.0 - 64bit (stable)',#url:URL['https://files.pharo.org/image/130/latest-64.zip']},#vmManager:PhLVirtualMachineManager{#imageFile:FileLocator{#path:RelativePath['MCP13','MCP13.image'],#origin:#launcherImagesLocation}},#launchConfigurations:OrderedCollection[PhLLaunchConfiguration{#vm:PhLVirtualMachine{#id:'130-x64',#blessing:'stable'}}]}]",
    );

    expect(images).toEqual([
      {
        name: "MCP13",
        imagePath: "MCP13/MCP13.image",
        architecture: "64",
        pharoVersion: "130",
        formatNumber: 68021,
        originTemplate: {
          name: "Pharo 13.0 - 64bit (stable)",
          url: "https://files.pharo.org/image/130/latest-64.zip",
        },
        vmId: "130-x64",
      },
    ]);
  });

  it("extracts LauncherImage models from text table output", () => {
    const images = parseLauncherImagesFromText(`
#  Name                                             Architecture Pharo version Last modified
-- ------------------------------------------------ ------------ ------------- -------------------
1  Pharo 13.0 - 64bit (stable)                     64           130           2026-04-25 10:00:00
`);

    expect(images).toEqual([
      {
        name: "Pharo 13.0 - 64bit (stable)",
        architecture: "64",
        pharoVersion: "130",
      },
    ]);
  });

  it("returns a single model for info parser output with one item", () => {
    const result = parseLauncherOutput(
      "pharo_launcher_image_info",
      "ston",
      "OrderedCollection[PhLImage{#formatNumber:68021,#architecture:'64',#pharoVersion:'130',#vmManager:PhLVirtualMachineManager{#imageFile:FileLocator{#path:RelativePath['MCP13','MCP13.image'],#origin:#launcherImagesLocation}}}]",
    );

    expect(result).toMatchObject({
      status: "parsed",
      format: "ston",
      data: {
        name: "MCP13",
        imagePath: "MCP13/MCP13.image",
      },
    });
  });

  it("uses the list name filter when PharoLauncher omits image file metadata", () => {
    const result = normalizeLauncherResult(
      "pharo_launcher_image_list",
      ["image", "list", "--nameFilter", "MCP13Copy", "--ston"],
      {
        ...cliResult,
        stdout:
          "OrderedCollection[PhLImage{#originTemplate:PhLRemoteTemplate{#name:'Pharo 13.0 - 64bit (stable)',#url:URL['https://files.pharo.org/image/130/latest-64.zip']},#launchConfigurations:OrderedCollection[],#shouldRunInitializationScript:true}]",
      },
    );

    expect(result).toMatchObject({
      ok: true,
      data: [
        {
          name: "MCP13Copy",
          originTemplate: {
            name: "Pharo 13.0 - 64bit (stable)",
          },
        },
      ],
    });
  });

  it("uses the image info argument when PharoLauncher omits image file metadata", () => {
    const result = normalizeLauncherResult(
      "pharo_launcher_image_info",
      ["image", "info", "--ston", "MCP13Copy"],
      {
        ...cliResult,
        stdout:
          "OrderedCollection[PhLImage{#originTemplate:PhLRemoteTemplate{#name:'Pharo 13.0 - 64bit (stable)',#url:URL['https://files.pharo.org/image/130/latest-64.zip']},#launchConfigurations:OrderedCollection[],#shouldRunInitializationScript:true}]",
      },
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        name: "MCP13Copy",
        originTemplate: {
          name: "Pharo 13.0 - 64bit (stable)",
        },
      },
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

  it("extracts LauncherVm models", () => {
    const vms = parseLauncherVmsFromSton(
      "OrderedCollection[PhLVirtualMachine{#executableRef:FileLocator{#path:RelativePath['130-x64','Pharo.exe']},#id:'130-x64',#blessing:'stable',#arch:'64'}]",
    );

    expect(vms).toEqual([
      {
        id: "130-x64",
        architecture: "64",
        executablePath: "130-x64/Pharo.exe",
        blessing: "stable",
      },
    ]);
  });

  it("extracts LauncherProcess models from text output", () => {
    const processes = parseLauncherProcessesFromText(
      "3093 C:/Pharo/vms/130-x64/Pharo.exe C:/Pharo/images/MCP13/MCP13.image",
    );

    expect(processes).toEqual([
      {
        pid: 3093,
        commandLine:
          "3093 C:/Pharo/vms/130-x64/Pharo.exe C:/Pharo/images/MCP13/MCP13.image",
        executablePath: "C:/Pharo/vms/130-x64/Pharo.exe",
        imagePath: "C:/Pharo/images/MCP13/MCP13.image",
        imageName: "MCP13",
      },
    ]);
  });

  it("extracts LauncherProcess models from quoted Windows text output", () => {
    const processes = parseLauncherProcessesFromText(
      '3093 "C:\\Program Files\\Pharo\\Pharo.exe" "C:\\Users\\Ada\\Images\\MCP13\\MCP13.image" "C:\\Program Files\\Pharo\\Pharo.exe C:\\Users\\Ada\\Images\\MCP13\\MCP13.image"',
    );

    expect(processes).toEqual([
      {
        pid: 3093,
        commandLine:
          '3093 "C:\\Program Files\\Pharo\\Pharo.exe" "C:\\Users\\Ada\\Images\\MCP13\\MCP13.image" "C:\\Program Files\\Pharo\\Pharo.exe C:\\Users\\Ada\\Images\\MCP13\\MCP13.image"',
        executablePath: "C:\\Program Files\\Pharo\\Pharo.exe",
        imagePath: "C:\\Users\\Ada\\Images\\MCP13\\MCP13.image",
        imageName: "MCP13",
      },
    ]);
  });

  it("returns unsupported parser status when no parser exists", () => {
    expect(parseLauncherOutput("pharo_launcher_image_copy", "text", "Done!")).toEqual({
      status: "unsupported",
      format: "text",
      message: "No parser registered for pharo_launcher_image_copy",
    });
  });
});
