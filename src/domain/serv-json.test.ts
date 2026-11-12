import { describe, expect, it } from "vitest";
import {
  asFiniteNumber,
  asTrimmedString,
  extractServJson,
  normalizeEnum,
  tryExtractServJson,
} from "./serv-json";

describe("extractServJson", () => {
  it("parses bare JSON", () => {
    expect(extractServJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("strips markdown fences", () => {
    expect(extractServJson('```json\n{"pickKey":"a"}\n```')).toEqual({ pickKey: "a" });
  });

  it("extracts the first object from prose", () => {
    expect(extractServJson('Here is my answer:\n{"action":"buy"}\nThanks.')).toEqual({
      action: "buy",
    });
  });

  it("extracts arrays", () => {
    expect(extractServJson("Notes:\n[1,2,3]\nok")).toEqual([1, 2, 3]);
  });

  it("throws a clear error when nothing is recoverable", () => {
    expect(() => extractServJson("no json here")).toThrow(/no JSON/i);
  });
});

describe("tryExtractServJson", () => {
  it("returns null on empty or unreadable input", () => {
    expect(tryExtractServJson("")).toBeNull();
    expect(tryExtractServJson("not json")).toBeNull();
  });
});

describe("coerce helpers", () => {
  it("asTrimmedString", () => {
    expect(asTrimmedString("  hi ")).toBe("hi");
    expect(asTrimmedString("")).toBeNull();
    expect(asTrimmedString(1)).toBeNull();
  });

  it("asFiniteNumber accepts string numbers", () => {
    expect(asFiniteNumber(18_500)).toBe(18_500);
    expect(asFiniteNumber("18500")).toBe(18_500);
    expect(asFiniteNumber("18,500")).toBe(18_500);
    expect(asFiniteNumber("nope")).toBeNull();
  });

  it("normalizeEnum is case-insensitive and returns canonical form", () => {
    const allowed = ["buy", "negotiate", "inspect_first", "pass"] as const;
    expect(normalizeEnum("Buy", allowed)).toBe("buy");
    expect(normalizeEnum("MEDIUM", ["high", "medium", "low"])).toBe("medium");
    expect(normalizeEnum("ghost", allowed)).toBeNull();
  });
});
