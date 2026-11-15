import type { LauncherOutputFormat, LauncherTemplate } from "./models.js";
import { objectOpenings, stonFields, stringValue, urlValue } from "./ston.js";

export interface ParseResult<T = unknown> {
  status: "parsed" | "unsupported" | "failed";
  format: LauncherOutputFormat;
  data?: T;
  /** The category the Launcher marks as its default, for a category listing. */
  defaultCategory?: string;
  message?: string;
}

/**
 * Every template of `template list --ston`, in the Launcher's order: each
 * `PhL…Template{` object, whatever its class, a `PhLLocalTemplate` as well as a
 * `PhLRemoteTemplate`. A `PhLTemplateGroup` is not one.
 */
export function parseLauncherTemplatesFromSton(source: string): LauncherTemplate[] {
  return objectOpenings(source, /PhL\w*Template/).map((open) => {
    const fields = stonFields(source, open);
    const name = stringValue(fields.get("name"));
    const category = stringValue(fields.get("category"));
    const url = urlValue(fields.get("url"));
    const local = /PhLLocalTemplate\s*$/.test(source.slice(0, open));
    return {
      ...(name ? { name } : {}),
      ...(category ? { category } : {}),
      ...(url ? { url } : {}),
      ...(local ? { local } : {}),
    };
  });
}

const briefCategoryRow = /^(\*?)\s*\d+\s+(.*?)\s*$/;

/**
 * The categories of `template categories --brief`, in the Launcher's order.
 *
 * It prints one row per category and no header
 * (`ConsoleListFormatter>>printAttributeRows`): the mark `*` on the default, or
 * a space, when one is the default; the index, padded right to two; one space;
 * the name, which the Launcher shortens past 75 characters as every cell.
 */
export function parseTemplateCategoriesFromBrief(source: string): {
  categories: string[];
  defaultCategory?: string;
} {
  const categories: string[] = [];
  let defaultCategory: string | undefined;
  for (const line of source.split(/\r?\n/)) {
    const row = briefCategoryRow.exec(line);
    if (!row || !row[2]) {
      continue;
    }

    categories.push(row[2]);
    if (row[1] === "*") {
      defaultCategory ??= row[2];
    }
  }

  return { categories, ...(defaultCategory ? { defaultCategory } : {}) };
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
    case "pharo_launcher_template_category_list": {
      const { categories, defaultCategory } =
        parseTemplateCategoriesFromBrief(stdout);
      return {
        status: "parsed",
        format,
        data: categories,
        ...(defaultCategory ? { defaultCategory } : {}),
      };
    }

    case "pharo_launcher_template_list":
      return parseWithStatus(format, () => parseLauncherTemplatesFromSton(stdout));

    default:
      return {
        status: "unsupported",
        format,
        message: `No parser registered for ${toolName}`,
      };
  }
}
