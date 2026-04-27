import path from "node:path";
import type {
  LauncherImage,
  LauncherOutputFormat,
  LauncherProcess,
  LauncherTemplate,
  LauncherVm,
} from "./models.js";

export interface ParseResult<T = unknown> {
  status: "parsed" | "unsupported" | "failed";
  format: LauncherOutputFormat;
  data?: T;
  message?: string;
}

function stonBlocks(source: string, className: string): string[] {
  const blocks: string[] = [];
  let index = 0;
  const marker = `${className}{`;

  while (index < source.length) {
    const start = source.indexOf(marker, index);
    if (start === -1) {
      break;
    }

    let depth = 0;
    let end = start + className.length;
    for (; end < source.length; end += 1) {
      const char = source[end];
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          end += 1;
          break;
        }
      }
    }

    blocks.push(source.slice(start, end));
    index = end;
  }

  return blocks;
}

function field(block: string, name: string): string | undefined {
  return block.match(new RegExp(`#${name}:'([^']*)'`))?.[1];
}

function numberField(block: string, name: string): number | undefined {
  const value = block.match(new RegExp(`#${name}:(\\d+)`))?.[1];
  return value ? Number(value) : undefined;
}

function urlField(block: string): string | undefined {
  return block.match(/#url:URL\['([^']*)'\]/)?.[1];
}

function relativePath(block: string): string | undefined {
  const match = block.match(/RelativePath\[((?:'[^']*'(?:,\s*)?)+)\]/);
  if (!match?.[1]) {
    return undefined;
  }

  const parts = [...match[1].matchAll(/'([^']*)'/g)].map((part) => part[1]);
  return parts.join("/");
}

function basenameWithoutImageExtension(imagePath: string): string {
  const basename = imagePath.split(/[\\/]/).at(-1) ?? imagePath;
  return basename.replace(/\.image$/i, "");
}

export function parseLauncherImagesFromSton(source: string): LauncherImage[] {
  return stonBlocks(source, "PhLImage").map((block) => {
    const imagePath = relativePath(block);

    return {
      ...(imagePath
        ? {
            name:
              imagePath.split(/[\\/]/)[0] ??
              basenameWithoutImageExtension(imagePath),
            imagePath,
          }
        : {}),
      ...(field(block, "architecture")
        ? { architecture: field(block, "architecture") }
        : {}),
      ...(field(block, "pharoVersion")
        ? { pharoVersion: field(block, "pharoVersion") }
        : {}),
      ...(numberField(block, "formatNumber")
        ? { formatNumber: numberField(block, "formatNumber") }
        : {}),
      originTemplate: {
        ...(field(block, "name") ? { name: field(block, "name") } : {}),
        ...(urlField(block) ? { url: urlField(block) } : {}),
      },
      ...(field(block, "id") ? { vmId: field(block, "id") } : {}),
    };
  });
}

export function parseLauncherImagesFromText(source: string): LauncherImage[] {
  return source
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => /^\d+\s+/.test(line))
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.+?)\s{2,}(\d+)\s+(\S+)/);
      if (!match) {
        return { name: line.replace(/^\d+\s+/, "").trim() };
      }

      return {
        name: match[2].trim(),
        architecture: match[3],
        pharoVersion: match[4],
      };
    });
}

export function parseLauncherTemplatesFromSton(source: string): LauncherTemplate[] {
  const blocks = [
    ...stonBlocks(source, "PhLRemoteTemplate"),
    ...stonBlocks(source, "PhLTemplate"),
  ];

  return blocks.map((block) => ({
    ...(field(block, "name") ? { name: field(block, "name") } : {}),
    ...(field(block, "category") ? { category: field(block, "category") } : {}),
    ...(urlField(block) ? { url: urlField(block) } : {}),
  }));
}

export function parseLauncherTemplatesFromText(source: string): LauncherTemplate[] {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("#") && !line.startsWith("--"))
    .map((line) => ({ name: line.replace(/^\d+\s+/, "") }));
}

export function parseTemplateCategoriesFromSton(source: string): string[] {
  return [...source.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

export function parseTemplateCategoriesFromText(source: string): string[] {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("#") && !line.startsWith("--"))
    .map((line) => line.replace(/^\d+\s+/, ""));
}

export function parseLauncherVmsFromSton(source: string): LauncherVm[] {
  return stonBlocks(source, "PhLVirtualMachine").map((block) => ({
    ...(field(block, "id") ? { id: field(block, "id") } : {}),
    ...(field(block, "name") ? { name: field(block, "name") } : {}),
    ...(field(block, "arch") ? { architecture: field(block, "arch") } : {}),
    ...(relativePath(block) ? { executablePath: relativePath(block) } : {}),
    ...(field(block, "status") ? { status: field(block, "status") } : {}),
    ...(field(block, "blessing") ? { blessing: field(block, "blessing") } : {}),
  }));
}

export function parseLauncherVmsFromText(source: string): LauncherVm[] {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("#") && !line.startsWith("--"))
    .map((line) => {
      const id = line.split(/\s+/)[0];
      return { id, status: line };
    });
}

export function parseLauncherProcessesFromText(source: string): LauncherProcess[] {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const pidText = line.match(/^(\d+)/)?.[1];
      if (!pidText) {
        return undefined;
      }

      const quotedValues = [...line.matchAll(/"([^"]+)"/g)].map(
        (match) => match[1],
      );
      const imagePath =
        quotedValues.find((value) => /\.image$/i.test(value)) ??
        line.match(/(\S+\.image)\b/i)?.[1];
      const executablePath =
        quotedValues.find((value) => /\.(?:exe|app)$/i.test(value)) ??
        line.replace(/^\d+\s+/, "").split(/\s+/)[0]?.replace(/^"|"$/g, "");

      return {
        pid: Number(pidText),
        commandLine: line,
        ...(executablePath ? { executablePath } : {}),
        ...(imagePath
          ? {
              imagePath,
              imageName: basenameWithoutImageExtension(path.basename(imagePath)),
            }
          : {}),
      };
    })
    .filter((process): process is LauncherProcess => Boolean(process));
}

function parseWithStatus<T>(
  format: LauncherOutputFormat,
  parser: () => T,
): ParseResult<T> {
  try {
    return {
      status: "parsed",
      format,
      data: parser(),
    };
  } catch (error) {
    return {
      status: "failed",
      format,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function singleOrArray<T>(items: T[]): T | T[] {
  return items.length === 1 ? items[0] : items;
}

export function parseLauncherOutput(
  toolName: string,
  format: LauncherOutputFormat,
  stdout: string,
): ParseResult {
  switch (toolName) {
    case "pharo_launcher_image_list":
      return parseWithStatus(format, () =>
        format === "ston"
          ? parseLauncherImagesFromSton(stdout)
          : parseLauncherImagesFromText(stdout),
      );

    case "pharo_launcher_image_info":
      return parseWithStatus(format, () =>
        singleOrArray(
          format === "ston"
            ? parseLauncherImagesFromSton(stdout)
            : parseLauncherImagesFromText(stdout),
        ),
      );

    case "pharo_launcher_template_category_list":
      return parseWithStatus(format, () =>
        format === "ston"
          ? parseTemplateCategoriesFromSton(stdout)
          : parseTemplateCategoriesFromText(stdout),
      );

    case "pharo_launcher_template_list":
      return parseWithStatus(format, () =>
        format === "ston"
          ? parseLauncherTemplatesFromSton(stdout)
          : parseLauncherTemplatesFromText(stdout),
      );

    case "pharo_launcher_template_info":
      return parseWithStatus(format, () =>
        singleOrArray(
          format === "ston"
            ? parseLauncherTemplatesFromSton(stdout)
            : parseLauncherTemplatesFromText(stdout),
        ),
      );

    case "pharo_launcher_vm_list":
      return parseWithStatus(format, () =>
        format === "ston"
          ? parseLauncherVmsFromSton(stdout)
          : parseLauncherVmsFromText(stdout),
      );

    case "pharo_launcher_vm_info":
      return parseWithStatus(format, () =>
        singleOrArray(
          format === "ston"
            ? parseLauncherVmsFromSton(stdout)
            : parseLauncherVmsFromText(stdout),
        ),
      );

    case "pharo_launcher_process_list":
      return parseWithStatus("text", () => parseLauncherProcessesFromText(stdout));

    default:
      return {
        status: "unsupported",
        format,
        message: `No parser registered for ${toolName}`,
      };
  }
}
