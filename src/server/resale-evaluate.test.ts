import { describe, expect, it } from "vitest";
import { listingsSearchUrl } from "@/io/autodev";
import { evaluateResaleDeal, resaleListingQuery } from "./resale-evaluate";

describe("evaluateResaleDeal", () => {
  it("rejects invalid year without calling Autodev", async () => {
    const result = await evaluateResaleDeal(
      {
        year: 1900,
        make: "Toyota",
        model: "Camry",
        miles: 40_000,
        askingUsd: 18_000,
      },
      { autodevKey: "test", autodev: { cache: {} as never, counter: {} as never } },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("invalid_year");
  });

  it("reports listings unconfigured when Autodev key is missing", async () => {
    const result = await evaluateResaleDeal({
      year: 2020,
      make: "Toyota",
      model: "Camry",
      miles: 40_000,
      askingUsd: 18_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("listings_unconfigured");
    expect(result.message).toMatch(/not configured/i);
  });

  it("asks for the same model-year window the price math uses, and only used cars", () => {
    const query = resaleListingQuery(
      {
        year: 2018,
        make: "Honda",
        model: "CR-V",
        miles: 60_000,
        askingUsd: 16_000,
        zip: "68114",
      },
      new Date("2026-11-09T00:00:00Z"),
    );
    expect(query.year).toBeUndefined();
    expect(query.yearRange).toBe("2015-2021");
    expect(query.used).toBe(true);
    const url = listingsSearchUrl(query);
    expect(url).toContain("vehicle.year=2015-2021");
    expect(url).toContain("retailListing.used=true");
    expect(url).not.toContain("RESALE");
  });
});
