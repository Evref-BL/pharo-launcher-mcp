import type { LauncherTemplate } from "./models.js";
import { objectOpenings, stonFields, stringValue, urlValue } from "./ston.js";

/**
 * What a listing said, read: its records, or why they could not be read. A
 * command that lists nothing has nothing to read.
 */
export type ParseResult =
  | { status: "parsed"; data: unknown; defaultCategory?: string }
  | { status: "none" }
  | { status: "failed"; message: string };

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

function isCommand(args: readonly string[], ...command: string[]): boolean {
  return command.every((word, index) => args[index] === word);
}

/** The records of a Launcher listing, read from what it wrote. */
export function parseLauncherOutput(args: readonly string[], stdout: string): ParseResult {
  if (isCommand(args, "template", "categories")) {
    const { categories, defaultCategory } = parseTemplateCategoriesFromBrief(stdout);
    return { status: "parsed", data: categories, ...(defaultCategory ? { defaultCategory } : {}) };
  }

  if (isCommand(args, "template", "list")) {
    try {
      return { status: "parsed", data: parseLauncherTemplatesFromSton(stdout) };
    } catch (error) {
      return { status: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  }

  return { status: "none" };
}
