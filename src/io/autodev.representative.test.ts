import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TtlCache } from "./cache";
import { MemoryCounter } from "./quota";
import { autodevSearchRepresentative, representativeSortsFor, type AutodevDeps } from "./autodev";
import { hasImplausiblePrice } from "@/domain/find-hard-eligibility";

/** Recorded api.auto.dev responses for the prod Dallas query (ZIP 75201, 50 mi, $1,000-$15,750, <100k mi). */
const recorded = JSON.parse(readFileSync("fixtures/autodev-dallas-representative-sorts.json", "utf8")) as Record<
  string,
  unknown[]
>;
const cheapestFirst = JSON.parse(readFileSync("fixtures/autodev-dallas-sedan-real-prices.json", "utf8")) as { data: unknown[] };

function deps(urls: string[], over: { failSort?: string } = {}): AutodevDeps {
  return {
    cache: new TtlCache<unknown>(),
    counter: new MemoryCounter(),
    apiKey: "test-key",
    now: new Date("2026-11-28T00:00:00Z"),
    retryBaseMs: 1,
    maxAttempts: 1,
    sleep: async () => undefined,
    fetch: (async (url: string) => {
      urls.push(String(url));
      const sort = new URL(String(url)).searchParams.get("sort") ?? "";
      if (over.failSort && sort === over.failSort) return new Response("busy", { status: 503 });
      const data = recorded[`broad:${sort}`] ?? [];
      return new Response(JSON.stringify({ data }), { status: 200 });
    }) as unknown as typeof fetch,
  };
}

const query = { priceRange: "1-15750", milesRange: "0-99999", used: true, zip: "75201", distanceMiles: 50, limit: 50 };

describe("representative Find search (prod: sort=price asc only ever showed the cheapest end)", () => {
  it("never uses cheapest-first; defaults to newest + highest-within-budget", () => {
    for (const sort of [undefined, null, "", "price", "price.asc", "cheapest", "lowest_price", "relevance"]) {
      expect(representativeSortsFor(sort)).toEqual(["vehicle.year.desc", "retailListing.price.desc"]);
    }
    expect(representativeSortsFor("newest")).toEqual(["vehicle.year.desc"]);
    expect(representativeSortsFor("price_high")).toEqual(["retailListing.price.desc"]);
  });

  it("the recorded cheapest-first page is the biased slice: rock-bottom asks and very old cars", () => {
    const rows = cheapestFirst.data as Array<{ vehicle: { year: number }; retailListing: { price: number } }>;
    const prices = rows.map((r) => r.retailListing.price);
    expect(Math.max(...prices)).toBeLessThan(3_000);
    // The shopper's budget is $15,000; nothing in this slice asks even a fifth of it.
    expect(prices.every((p) => p < 15_000 * 0.2)).toBe(true);
    expect(rows.some((r) => r.vehicle.year <= 2006)).toBe(true);
  });

  it("covers both ends of the market inside the budget, interleaved, with no placeholder rows", async () => {
    const urls: string[] = [];
    const result = await autodevSearchRepresentative({ ...query, sort: "price" }, deps(urls));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sorts = urls.map((u) => new URL(u).searchParams.get("sort"));
    expect(sorts.sort()).toEqual(["retailListing.price.desc", "vehicle.year.desc"]);
    expect(urls.every((u) => new URL(u).searchParams.get("retailListing.price") === "1000-15750")).toBe(true);
    expect(result.searchedSorts).toHaveLength(2);
    const rows = result.listings;
    expect(rows.length).toBeGreaterThan(20);
    expect(new Set(rows.map((r) => r.vin)).size).toBe(rows.length);
    expect(rows.every((r) => !hasImplausiblePrice(r, 2026))).toBe(true);
    // Late-model market cars an ascending-price page never reaches.
    expect(rows.some((r) => r.year >= 2023 && /Sentra|Elantra|Versa/.test(r.model))).toBe(true);
    expect(rows.some((r) => r.make === "Honda" && r.model === "Civic" && r.year === 2019)).toBe(true);
    // Interleaved so a page cap keeps both views.
    const firstTen = rows.slice(0, 10);
    expect(firstTen.some((r) => (r.priceUsd ?? 0) >= 15_700)).toBe(true);
    expect(firstTen.some((r) => r.year >= 2025)).toBe(true);
  });

  it("keeps working when one view fails, and reports only the views that answered", async () => {
    const urls: string[] = [];
    const result = await autodevSearchRepresentative(query, deps(urls, { failSort: "retailListing.price.desc" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.searchedSorts).toEqual(["vehicle.year.desc"]);
    expect(result.listings.length).toBeGreaterThan(5);
  });

  it("model searches surface late-model Corollas, Civics and Camrys under the budget", () => {
    const rows = (model: string) =>
      (recorded[`${model}:vehicle.year.desc`] as Array<{ vehicle: { year: number }; retailListing: { price: number } }>).map(
        (r) => [r.vehicle.year, r.retailListing.price] as const,
      );
    expect(rows("Corolla").some(([year, price]) => year >= 2021 && price <= 15_000)).toBe(true);
    expect(rows("Civic").some(([year, price]) => year >= 2020 && price <= 15_000)).toBe(true);
    expect(rows("Camry").some(([year, price]) => year >= 2017 && price <= 15_000)).toBe(true);
  });
});
