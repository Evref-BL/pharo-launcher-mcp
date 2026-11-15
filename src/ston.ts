/**
 * Reading STON as Pharo Launcher writes it, compact (`#key:'value'`) or
 * pretty-printed (`#key : 'value'`), with `''` for one quote. Only what a
 * field needs is read, so a field this reader does not know never makes the
 * source unreadable.
 */

/** The index just past the string whose opening quote is at `index`. */
function skipString(source: string, index: number): number {
  let i = index + 1;
  while (i < source.length) {
    if (source[i] === "'") {
      if (source[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }

  return i;
}

/** Where the value starting at `index` ends: a `,` or a closing bracket at its depth. */
function endOfValue(source: string, index: number): number {
  let depth = 0;
  let i = index;
  while (i < source.length) {
    const char = source[i];
    if (char === "'") {
      i = skipString(source, i);
      continue;
    }
    if (char === "{" || char === "[" || char === "(") {
      depth += 1;
    } else if (char === "}" || char === "]" || char === ")") {
      if (depth === 0) {
        return i;
      }
      depth -= 1;
    } else if (char === "," && depth === 0) {
      return i;
    }
    i += 1;
  }

  return i;
}

/** The first `{` that opens an object, outside any string. */
export function firstObjectOpen(source: string): number {
  let i = 0;
  while (i < source.length) {
    if (source[i] === "'") {
      i = skipString(source, i);
      continue;
    }
    if (source[i] === "{") {
      return i;
    }
    i += 1;
  }

  return -1;
}

/**
 * Every object whose class name matches `className`, outside any string, in
 * the order they are written, nested ones included: the index of its `{`.
 */
export function objectOpenings(source: string, className: RegExp): number[] {
  const opening = new RegExp(`(?<![\\w])(?:${className.source})\\s*\\{`, "y");
  const openings: number[] = [];
  let i = 0;
  while (i < source.length) {
    if (source[i] === "'") {
      i = skipString(source, i);
      continue;
    }
    opening.lastIndex = i;
    const match = opening.exec(source);
    if (match) {
      i += match[0].length;
      openings.push(i - 1);
      continue;
    }
    i += 1;
  }

  return openings;
}

/** The fields of the object whose `{` is at `open`, as their source. */
export function stonFields(source: string, open: number): Map<string, string> {
  const fields = new Map<string, string>();
  const key = /\s*#([A-Za-z_][A-Za-z0-9_]*)\s*:/y;
  let i = open + 1;

  while (i < source.length) {
    while (/[\s,]/.test(source[i] ?? "")) {
      i += 1;
    }
    key.lastIndex = i;
    const match = key.exec(source);
    if (!match) {
      break;
    }

    const valueStart = key.lastIndex;
    const valueEnd = endOfValue(source, valueStart);
    fields.set(match[1]!, source.slice(valueStart, valueEnd).trim());
    i = valueEnd;
  }

  return fields;
}

/** The fields of a value that is an object, `Class { … }`. */
export function objectFields(value: string | undefined): Map<string, string> | undefined {
  if (value === undefined || !/^[A-Za-z]\w*\s*\{/.test(value)) {
    return undefined;
  }

  return stonFields(value, value.indexOf("{"));
}

/** A string value, `'…'`, its doubled quotes read as one. */
export function stringValue(value: string | undefined): string | undefined {
  const match = value === undefined ? null : /^'((?:''|[^'])*)'$/s.exec(value);
  return match ? match[1]!.replaceAll("''", "'") : undefined;
}

/** A URL value, `URL [ '…' ]`, or a plain string. */
export function urlValue(value: string | undefined): string | undefined {
  const url =
    value === undefined
      ? null
      : /^URL\s*\[\s*('(?:''|[^'])*')\s*\]$/s.exec(value);
  return stringValue(url ? url[1] : value);
}
