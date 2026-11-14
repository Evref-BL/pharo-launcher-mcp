import type { LauncherOutputFormat, LauncherTemplate } from "./models.js";

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

function urlField(block: string): string | undefined {
  return block.match(/#url:URL\['([^']*)'\]/)?.[1];
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

export function parseLauncherOutput(
  toolName: string,
  format: LauncherOutputFormat,
  stdout: string,
): ParseResult {
  switch (toolName) {
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

    default:
      return {
        status: "unsupported",
        format,
        message: `No parser registered for ${toolName}`,
      };
  }
}
