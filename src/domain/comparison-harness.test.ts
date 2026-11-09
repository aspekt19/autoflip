/**
 * Mocked CI tests for the comparison harness — fixture mode only, no network.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  runCheapestFind,
  runLemonlessCheck,
  runLemonlessCheckLive,
  runLemonlessFind,
  runLemonlessFindLive,
  runPlainOfflineCheck,
  runPlainOfflineFind,
  sharedCheckPayload,
  sharedFindPayload,
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
    expect(findCases.every((c) => c.listings.length >= 3)).toBe(true);
    expect(checkCases.every((c) => c.rawText && c.subject)).toBe(true);
  });

  it("marks synthetic cases and forbids canned plain_llm offline answers", () => {
    expect(findCases.every((c) => c.synthetic === true)).toBe(true);
    expect(checkCases.every((c) => c.synthetic === true)).toBe(true);
    expect(findCases.every((c) => c.labels.provenance?.fairValueMethod)).toBe(true);
    expect(checkCases.every((c) => c.labels.provenance?.fairValueMethod)).toBe(true);
    for (const row of [...findCases, ...checkCases] as Array<Record<string, unknown>>) {
      expect(row.plainLlmOffline).toBeUndefined();
    }
  });

  it("includes tricky check labels (sold, salvage, missing VIN, high miles)", () => {
    const ids = new Set(checkCases.map((c) => c.id));
    expect(ids.has("check-sold-camry")).toBe(true);
    expect(ids.has("check-salvage-rebuilt")).toBe(true);
    expect(ids.has("check-missing-vin")).toBe(true);
    expect(ids.has("check-high-mileage")).toBe(true);
    expect(checkCases.find((c) => c.id === "check-sold-camry")?.labels.isSold).toBe(true);
  });

  it("labels every case synthetic and does not present harness VINs as live captures", () => {
    for (const row of [...findCases, ...checkCases]) {
      expect(row.synthetic).toBe(true);
      expect(row.capture?.source).toBe("harness_authored");
      expect(`${row.capture?.note ?? ""} ${row.note}`).toMatch(/synthetic|not a live/i);
      expect(`${row.capture?.note ?? ""} ${row.note}`).not.toMatch(/real vin|this vin was seen live/i);
    }
  });

  it("keeps scoring labels off the shared SUT payload", () => {
    const find = findCases[0]!;
    const check = checkCases[0]!;
    const findPayload = JSON.stringify(sharedFindPayload(find));
    const checkPayload = JSON.stringify(sharedCheckPayload(check));
    expect(findPayload).not.toMatch(/fairValueByVin|expectedAvoidVins|preferredVin|provenance/);
    expect(checkPayload).not.toMatch(/fairValueUsd|expectedRedFlagIds|expectedPriceBand|provenance/);
    expect(findPayload).not.toContain('"labels"');
    expect(checkPayload).not.toContain('"labels"');
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

  it("plain offline find is not_run (canned answers forbidden)", () => {
    const fixture = findCases.find((c) => c.id === "find-family-suv-15k-68114")!;
    const out = runPlainOfflineFind(fixture);
    expect(out.status).toBe("not_run");
    const score = scoreArmOnFind({ fixture, output: out });
    expect(score.status).toBe("not_run");
    expect(score.inventedNumber).toBeNull();
  });

  it("Lemonless check flags SOLD and does not treat it as buyable", () => {
    const fixture = checkCases.find((c) => c.id === "check-sold-camry")!;
    const out = runLemonlessCheck(fixture);
    expect(out.redFlags).toContain("sold");
    const score = scoreArmOnCheck({ fixture, output: out });
    expect(score.pickedSold).toBe(false);
    expect(score.redFlagsCaught).toBeGreaterThanOrEqual(1);
  });

  it("plain offline check is not_run", () => {
    const fixture = checkCases.find((c) => c.id === "check-sold-camry")!;
    const out = runPlainOfflineCheck(fixture);
    expect(out.status).toBe("not_run");
    const score = scoreArmOnCheck({ fixture, output: out });
    expect(score.status).toBe("not_run");
    expect(score.pickedSold).toBeNull();
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
    expect(out.status).toBe("ran");
    expect(out.costUsd).toBe(0);
    // Must not pick the SOLD VIN.
    expect(out.pickVin).not.toBe("5J6RM4H5XEL999001");
  });

  it("live Lemonless stays offline unless the paid flag and key are both set", async () => {
    const paid = process.env.COMPARISON_ALLOW_PAID;
    const key = process.env.SERV_API_KEY;
    delete process.env.COMPARISON_ALLOW_PAID;
    delete process.env.SERV_API_KEY;
    try {
      const find = await runLemonlessFindLive(findCases[0]!);
      const check = await runLemonlessCheckLive(checkCases[0]!);
      expect(find.model).toBeNull();
      expect(find.liveTrace ?? null).toBeNull();
      expect(find.costUsd).toBe(0);
      expect(check.model).toBeNull();
      expect(check.liveTrace ?? null).toBeNull();
      expect(check.costUsd).toBe(0);
    } finally {
      if (paid === undefined) delete process.env.COMPARISON_ALLOW_PAID;
      else process.env.COMPARISON_ALLOW_PAID = paid;
      if (key === undefined) delete process.env.SERV_API_KEY;
      else process.env.SERV_API_KEY = key;
    }
  });

  it("Lemonless live path uses the production verdict helpers and never reads labels", () => {
    const src = readFileSync(resolve("eval/comparison/arms.ts"), "utf8");
    expect(src).not.toMatch(/fixture\.labels\b/);
    expect(src).not.toMatch(/Choose buy\|negotiate/);
    expect(src).not.toMatch(/runCheck/);
    expect(src).toMatch(/verdictDecisionFacts/);
    expect(src).toMatch(/resolveVerdictDecision/);
    expect(src).toMatch(/runReportVerdictChallenge/);
  });
});

describe("price band helper", () => {
  it("maps ask vs fair into bands", () => {
    expect(bandFromAskVsFair(8000, 15000)).toBe("far_below");
    expect(bandFromAskVsFair(15000, 15000)).toBe("fair");
    expect(bandFromAskVsFair(20000, 15000)).toBe("far_above");
  });
});
