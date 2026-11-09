/**
 * Mocked CI tests for the comparison harness — fixture mode only, no network.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  runCheapestFind,
  runLemonlessCheck,
  runLemonlessFind,
  runPlainOfflineCheck,
  runPlainOfflineFind,
} from "../../eval/comparison/arms";
import { bandFromAskVsFair, scoreArmOnCheck, scoreArmOnFind } from "../../eval/comparison/score";
import type { CheckCaseFixture, FindCaseFixture } from "../../eval/comparison/types";

const findCases = (
  JSON.parse(readFileSync(resolve("eval/comparison/fixtures/find-cases.json"), "utf8")) as {
    cases: FindCaseFixture[];
  }
).cases;
const checkCases = (
  JSON.parse(readFileSync(resolve("eval/comparison/fixtures/check-cases.json"), "utf8")) as {
    cases: CheckCaseFixture[];
  }
).cases;

describe("comparison fixtures", () => {
  it("ships ~10 find and ~10 check cases with captured inputs", () => {
    expect(findCases.length).toBeGreaterThanOrEqual(10);
    expect(checkCases.length).toBeGreaterThanOrEqual(10);
    expect(findCases.every((c) => c.listings.length >= 3 && c.plainLlmOffline)).toBe(true);
    expect(checkCases.every((c) => c.rawText && c.subject && c.plainLlmOffline)).toBe(true);
  });

  it("includes tricky check labels (sold, salvage, missing VIN, high miles)", () => {
    const ids = new Set(checkCases.map((c) => c.id));
    expect(ids.has("check-sold-camry")).toBe(true);
    expect(ids.has("check-salvage-rebuilt")).toBe(true);
    expect(ids.has("check-missing-vin")).toBe(true);
    expect(ids.has("check-high-mileage")).toBe(true);
    expect(checkCases.find((c) => c.id === "check-sold-camry")?.labels.isSold).toBe(true);
  });
});

describe("comparison arms (offline)", () => {
  it("cheapest find picks the lowest ask, including SOLD bait when present", () => {
    const fixture = findCases.find((c) => c.id === "find-family-suv-15k-68114")!;
    const out = runCheapestFind(fixture);
    expect(out.pickVin).toBe("5J6RM4H5XEL999001");
    const score = scoreArmOnFind({ fixture, output: out });
    expect(score.pickedSold).toBe(true);
  });

  it("plain offline find invents a fair value on the SOLD bait case", () => {
    const fixture = findCases.find((c) => c.id === "find-family-suv-15k-68114")!;
    const out = runPlainOfflineFind(fixture);
    const score = scoreArmOnFind({ fixture, output: out });
    expect(score.pickedSold).toBe(true);
    expect(score.inventedNumber).toBe(true);
  });

  it("Lemonless check flags SOLD and does not treat it as buyable", () => {
    const fixture = checkCases.find((c) => c.id === "check-sold-camry")!;
    const out = runLemonlessCheck(fixture);
    expect(out.redFlags).toContain("sold");
    const score = scoreArmOnCheck({ fixture, output: out });
    expect(score.pickedSold).toBe(false);
    expect(score.redFlagsCaught).toBeGreaterThanOrEqual(1);
  });

  it("plain offline check misses SOLD and scores as pickedSold", () => {
    const fixture = checkCases.find((c) => c.id === "check-sold-camry")!;
    const out = runPlainOfflineCheck(fixture);
    const score = scoreArmOnCheck({ fixture, output: out });
    expect(score.pickedSold).toBe(true);
  });

  it("Lemonless check catches salvage/rebuilt title_brand", () => {
    const fixture = checkCases.find((c) => c.id === "check-salvage-rebuilt")!;
    const out = runLemonlessCheck(fixture);
    expect(out.redFlags.some((f) => /title_brand|salvage|rebuilt/i.test(f))).toBe(true);
    const score = scoreArmOnCheck({ fixture, output: out });
    expect(score.redFlagsCaught).toBeGreaterThanOrEqual(1);
  });

  it("Lemonless find runs without network on family SUV fixture", () => {
    const fixture = findCases.find((c) => c.id === "find-family-suv-15k-68114")!;
    const out = runLemonlessFind(fixture);
    expect(out.arm).toBe("lemonless");
    expect(out.costUsd).toBe(0);
    // Must not pick the SOLD VIN.
    expect(out.pickVin).not.toBe("5J6RM4H5XEL999001");
  });
});

describe("price band helper", () => {
  it("maps ask vs fair into bands", () => {
    expect(bandFromAskVsFair(8000, 15000)).toBe("far_below");
    expect(bandFromAskVsFair(15000, 15000)).toBe("fair");
    expect(bandFromAskVsFair(20000, 15000)).toBe("far_above");
  });
});
