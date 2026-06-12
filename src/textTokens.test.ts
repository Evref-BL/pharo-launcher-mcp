import { describe, expect, it } from "vitest";

import {
  afterLeadingDigits,
  compactTokenText,
  hasCaseInsensitiveSuffix,
  leadingDigits,
  quotedValues,
  stripLeadingNumber,
  whitespaceTokens,
} from "./textTokens.js";

describe("text token helpers", () => {
  it("reads and strips leading process/table numbers", () => {
    expect(leadingDigits("1234 /Applications/Pharo.app")).toBe("1234");
    expect(afterLeadingDigits("1234 /Applications/Pharo.app")).toBe(
      "/Applications/Pharo.app",
    );
    expect(stripLeadingNumber("12  Pharo 13.0")).toBe("Pharo 13.0");
    expect(stripLeadingNumber("Pharo 13.0")).toBe("Pharo 13.0");
  });

  it("splits unquoted whitespace tokens and quoted values", () => {
    expect(whitespaceTokens("one  two\tthree")).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(quotedValues('cmd "Pharo.image" "--headless"')).toEqual([
      "Pharo.image",
      "--headless",
    ]);
  });

  it("compares suffixes and compact architecture hints case-insensitively", () => {
    expect(hasCaseInsensitiveSuffix("Image.IMAGE", ".image")).toBe(true);
    expect(compactTokenText("Pharo 13.0 - 64 bit")).toContain("64bit");
  });
});
