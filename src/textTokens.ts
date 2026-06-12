export function isAsciiDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

export function isWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\t";
}

export function leadingDigits(value: string): string | undefined {
  let index = 0;
  while (isAsciiDigit(value[index])) {
    index += 1;
  }

  return index > 0 ? value.slice(0, index) : undefined;
}

export function stripLeadingNumber(value: string): string {
  const digits = leadingDigits(value);
  if (!digits || !isWhitespace(value[digits.length])) {
    return value;
  }

  return value.slice(digits.length).trimStart();
}

export function afterLeadingDigits(value: string): string | undefined {
  const digits = leadingDigits(value);
  if (!digits || !isWhitespace(value[digits.length])) {
    return undefined;
  }

  return value.slice(digits.length).trimStart();
}

export function whitespaceTokens(value: string): string[] {
  const tokens: string[] = [];
  let tokenStart: number | undefined;

  for (let index = 0; index < value.length; index += 1) {
    if (isWhitespace(value[index])) {
      if (tokenStart !== undefined) {
        tokens.push(value.slice(tokenStart, index));
        tokenStart = undefined;
      }
      continue;
    }

    tokenStart ??= index;
  }

  if (tokenStart !== undefined) {
    tokens.push(value.slice(tokenStart));
  }

  return tokens;
}

export function quotedValues(value: string): string[] {
  const values: string[] = [];
  let quotedStart: number | undefined;

  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '"') {
      continue;
    }

    if (quotedStart === undefined) {
      quotedStart = index + 1;
      continue;
    }

    values.push(value.slice(quotedStart, index));
    quotedStart = undefined;
  }

  return values;
}

export function hasCaseInsensitiveSuffix(value: string, suffix: string): boolean {
  return value.toLowerCase().endsWith(suffix.toLowerCase());
}

export function compactTokenText(value: string): string {
  return value.toLowerCase().replaceAll(" ", "").replaceAll("-", "").replaceAll("_", "");
}
