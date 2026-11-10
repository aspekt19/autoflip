import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import { readVinDayValuation, rememberVinDayValuation } from "@/io/vin-day-valuation-store";
import {
  buildVinDayValuation,
  preferExistingValuation,
  valuationReuseNote,
} from "./vin-day-valuation";

describe("vin-day valuation", () => {
  const vin = "4T1BF1FK0EU848445";

  it("builds a same-day snapshot from evaluateListingPrice numbers only", () => {
    const snap = buildVinDayValuation({
      vin,
      fairValueUsd: 15_898.4,
      sampleSize: 9,
      methodNote: "Adjusted similar listing asks",
      source: "find",
      now: new Date("2026-11-10T18:00:00.000Z"),
    });
    expect(snap).not.toBeNull();
    expect(snap!.fairValueUsd).toBe(15_898);
    expect(snap!.sampleSize).toBe(9);
    expect(snap!.utcDate).toBe("2026-11-10");
    expect(valuationReuseNote(snap!)).toMatch(/Find valuation from 2026-11-10 UTC/);
    expect(valuationReuseNote(snap!)).toMatch(/\$15,898/);
    expect(valuationReuseNote(snap!)).toMatch(/9 similar listings/);
  });

  it("rejects short or invented sample sizes", () => {
    expect(
      buildVinDayValuation({
        vin,
        fairValueUsd: 15_000,
        sampleSize: 2,
        methodNote: "thin",
        source: "check",
      }),
    ).toBeNull();
    expect(
      buildVinDayValuation({
        vin: "SHORT",
        fairValueUsd: 15_000,
        sampleSize: 9,
        methodNote: "bad vin",
        source: "check",
      }),
    ).toBeNull();
  });

  it("keeps the first writer for the UTC day (Find then Check)", async () => {
    const kv = new MemoryKv();
    const now = new Date("2026-11-10T12:00:00.000Z");
    const find = await rememberVinDayValuation(kv, {
      vin,
      fairValueUsd: 15_898,
      sampleSize: 9,
      methodNote: "Find pool",
      source: "find",
      now,
    });
    expect(find?.fairValueUsd).toBe(15_898);
    expect(find?.sampleSize).toBe(9);

    const checkAttempt = await rememberVinDayValuation(kv, {
      vin,
      fairValueUsd: 14_630,
      sampleSize: 15,
      methodNote: "Check pool",
      source: "check",
      now: new Date("2026-11-10T20:00:00.000Z"),
    });
    expect(checkAttempt?.fairValueUsd).toBe(15_898);
    expect(checkAttempt?.sampleSize).toBe(9);
    expect(checkAttempt?.source).toBe("find");

    const read = await readVinDayValuation(kv, vin, now);
    expect(read?.fairValueUsd).toBe(15_898);
    expect(preferExistingValuation(find, checkAttempt!).fairValueUsd).toBe(15_898);
  });
});
