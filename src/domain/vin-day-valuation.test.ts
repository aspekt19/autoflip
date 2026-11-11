import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import { getOrComputeValuation, readVinDayValuation } from "@/io/vin-day-valuation-store";
import type { Listing } from "./types";
import {
  applyAskToValuation,
  buildComparisonSentence,
  buildVinDayValuation,
  poolScopePhrase,
  vinDayValuationKey,
  valuationReuseNote,
} from "./vin-day-valuation";

function car(partial: Partial<Listing> & Pick<Listing, "vin" | "priceUsd" | "miles">): Listing {
  return {
    year: 2019,
    make: "Hyundai",
    model: "Tucson",
    trim: null,
    city: "Omaha",
    state: "NE",
    zip: "68114",
    dealer: null,
    vdp: null,
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: false,
    accidentCount: null,
    oneOwner: null,
    ownerCount: null,
    usageType: null,
    fuel: null,
    engine: null,
    drivetrain: null,
    bodyStyle: "SUV",
    latitude: null,
    longitude: null,
    removedAt: null,
    createdAt: null,
    source: "sample",
    ...partial,
  };
}

describe("vin-day valuation v2", () => {
  const vin = "KM8J2CA43KU949132";
  const zip = "68114";
  const radius = 500;
  const now = new Date("2026-11-10T18:00:00.000Z");

  function poolAround(ask: number): Listing[] {
    return [
      car({ vin, priceUsd: ask, miles: 61_000 }),
      car({ vin: "KM8J2CA43KU949133", priceUsd: 15_500, miles: 58_000 }),
      car({ vin: "KM8J2CA43KU949134", priceUsd: 16_200, miles: 62_000 }),
      car({ vin: "KM8J2CA43KU949135", priceUsd: 15_800, miles: 59_500 }),
      car({ vin: "KM8J2CA43KU949136", priceUsd: 16_000, miles: 60_500 }),
    ];
  }

  it("keys by VIN + ZIP + radius + UTC date", () => {
    expect(
      vinDayValuationKey({ vin, zip, radiusMiles: 500, utcDate: "2026-11-10" }),
    ).toBe("valuation:v2:KM8J2CA43KU949132:68114:500:2026-11-10");
    expect(
      vinDayValuationKey({ vin, zip: null, radiusMiles: null, utcDate: "2026-11-10" }),
    ).toBe("valuation:v2:KM8J2CA43KU949132:none:none:2026-11-10");
  });

  it("Find then Check on the same VIN/ZIP/radius share value, count, tone, and text", async () => {
    const kv = new MemoryKv();
    const subject = car({ vin, priceUsd: 14_900, miles: 61_000 });
    const pool = poolAround(14_900);

    const find = await getOrComputeValuation({
      kv,
      vin,
      zip,
      radiusMiles: radius,
      priceUsd: 14_900,
      subject,
      pool,
      source: "find",
      now,
    });
    expect(find.valuation).not.toBeNull();
    expect(find.badge.fairValueUsd).toBe(find.valuation!.fairValueUsd);
    expect(find.badge.sampleSize).toBe(find.valuation!.sampleSize);
    expect(find.badge.tone).toBe(find.valuation!.tone);
    expect(find.badge.deltaLabel).toBe(find.valuation!.deltaLabel);
    expect(find.badge.sampleNote).toMatch(/Compared with \d+ similar Tucson listings within 500 mi of 68114/);

    // Different live pool would have produced a different fair value — Check must reuse.
    const otherPool = [
      subject,
      car({ vin: "KM8J2CA43KU949140", priceUsd: 12_000, miles: 40_000 }),
      car({ vin: "KM8J2CA43KU949141", priceUsd: 12_200, miles: 41_000 }),
      car({ vin: "KM8J2CA43KU949142", priceUsd: 12_400, miles: 42_000 }),
      car({ vin: "KM8J2CA43KU949143", priceUsd: 18_900, miles: 90_000 }),
    ];
    const check = await getOrComputeValuation({
      kv,
      vin,
      zip,
      radiusMiles: radius,
      priceUsd: 14_900,
      subject,
      pool: otherPool,
      source: "check_vin",
      now,
    });
    expect(check.valuation!.fairValueUsd).toBe(find.valuation!.fairValueUsd);
    expect(check.valuation!.sampleSize).toBe(find.valuation!.sampleSize);
    expect(check.badge.tone).toBe(find.badge.tone);
    expect(check.badge.label).toBe(find.badge.label);
    expect(check.badge.deltaLabel).toBe(find.badge.deltaLabel);
    expect(check.badge.sampleSize).toBe(find.badge.sampleSize);
    expect(check.badge.sampleNote).toMatch(/within 500 mi of 68114/);
    expect(check.badge.sampleNote).not.toMatch(/Compared with 15 /);
  });

  it("a different ZIP makes a separate record", async () => {
    const kv = new MemoryKv();
    const subject = car({ vin, priceUsd: 14_900, miles: 61_000 });
    const a = await getOrComputeValuation({
      kv,
      vin,
      zip: "68114",
      radiusMiles: radius,
      priceUsd: 14_900,
      subject,
      pool: poolAround(14_900),
      source: "find",
      now,
    });
    const b = await getOrComputeValuation({
      kv,
      vin,
      zip: "68102",
      radiusMiles: radius,
      priceUsd: 14_900,
      subject: { ...subject, zip: "68102" },
      pool: poolAround(14_900).map((row, i) => (i === 0 ? row : { ...row, zip: "68102", priceUsd: 13_000 + i * 100 })),
      source: "check_vin",
      now,
    });
    expect(a.valuation!.zip).toBe("68114");
    expect(b.valuation!.zip).toBe("68102");
    expect(
      vinDayValuationKey({ vin, zip: "68114", radiusMiles: radius, utcDate: "2026-11-10" }),
    ).not.toBe(vinDayValuationKey({ vin, zip: "68102", radiusMiles: radius, utcDate: "2026-11-10" }));
  });

  it("Check first, then Find, reuses the Check record", async () => {
    const kv = new MemoryKv();
    const subject = car({ vin, priceUsd: 14_900, miles: 61_000 });
    const check = await getOrComputeValuation({
      kv,
      vin,
      zip,
      radiusMiles: radius,
      priceUsd: 14_900,
      subject,
      pool: poolAround(14_900),
      source: "check_vin",
      now,
    });
    const find = await getOrComputeValuation({
      kv,
      vin,
      zip,
      radiusMiles: radius,
      priceUsd: 14_900,
      subject,
      pool: poolAround(16_500),
      source: "find",
      now,
    });
    expect(find.valuation!.source).toBe("check_vin");
    expect(find.valuation!.fairValueUsd).toBe(check.valuation!.fairValueUsd);
    expect(find.badge.sampleSize).toBe(check.badge.sampleSize);
    expect(find.badge.tone).toBe(check.badge.tone);
    expect(valuationReuseNote(find.valuation!)).toMatch(/VIN Check/);
  });

  it("listing-URL Check uses the store", async () => {
    const kv = new MemoryKv();
    const subject = car({ vin, priceUsd: 14_900, miles: 61_000 });
    const listing = await getOrComputeValuation({
      kv,
      vin,
      zip,
      radiusMiles: radius,
      priceUsd: 14_900,
      subject,
      pool: poolAround(14_900),
      source: "check_listing",
      now,
    });
    expect(listing.valuation!.source).toBe("check_listing");
    const again = await readVinDayValuation(kv, { vin, zip, radiusMiles: radius, now });
    expect(again?.fairValueUsd).toBe(listing.valuation!.fairValueUsd);

    const find = await getOrComputeValuation({
      kv,
      vin,
      zip,
      radiusMiles: radius,
      priceUsd: 15_200,
      subject: { ...subject, priceUsd: 15_200 },
      pool: poolAround(18_000),
      source: "find",
      now,
    });
    expect(find.valuation!.fairValueUsd).toBe(listing.valuation!.fairValueUsd);
    expect(find.valuation!.sampleSize).toBe(listing.valuation!.sampleSize);
    // Ask changed → tone/delta recomputed from stored fair value, not a second pool.
    expect(find.valuation!.askUsd).toBe(15_200);
    expect(find.badge.deltaUsd).toBe(15_200 - listing.valuation!.fairValueUsd);
    expect(find.badge.tone).toBe(find.valuation!.tone);
    expect(find.badge.deltaLabel).toBe(find.valuation!.deltaLabel);
  });

  it("poolScopePhrase is nationwide when radius is null (even if a dealer ZIP leaked in)", () => {
    expect(poolScopePhrase("33415", null)).toBe("nationwide");
    expect(poolScopePhrase("none", null)).toBe("nationwide");
    expect(poolScopePhrase("68114", 500)).toBe("within 500 mi of 68114");
    expect(buildComparisonSentence({ sampleSize: 8, model: "RAV4", zip: "33415", radiusMiles: null })).toBe(
      "Compared with 8 similar RAV4 listings nationwide.",
    );
  });

  it("applyAskToValuation keeps sample size and fair value, updates tone from the new ask", () => {
    const snap = buildVinDayValuation({
      vin,
      model: "Tucson",
      zip,
      radiusMiles: radius,
      askUsd: 14_000,
      fairValueUsd: 16_000,
      sampleSize: 9,
      label: "Good price",
      tone: "good",
      deltaUsd: -2_000,
      deltaLabel: "$2,000 below the fair value of $16,000, based on 9 similar Tucson listings within 500 mi of 68114",
      comparisonSentence: "Compared with 9 similar Tucson listings within 500 mi of 68114.",
      methodNote: "test",
      source: "find",
      now,
    })!;
    const high = applyAskToValuation(snap, 19_000);
    expect(high.fairValueUsd).toBe(16_000);
    expect(high.sampleSize).toBe(9);
    expect(high.tone).toBe("high");
    expect(high.label).toBe("High price");
    expect(high.deltaUsd).toBe(3_000);
    expect(high.deltaLabel).toMatch(/above the fair value of \$16,000/);
    expect(high.deltaLabel).toMatch(/based on 9 similar Tucson listings within 500 mi of 68114/);
    expect(high.comparisonSentence).toBe(snap.comparisonSentence);
  });
});
