import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TtlCache } from "./cache";
import { MemoryCounter } from "./quota";
import { autodevSearch, listingsSearchUrl, realPriceRangeParam, type AutodevDeps } from "./autodev";
import { PLACEHOLDER_PRICE_BELOW_USD, hasImplausiblePrice } from "@/domain/find-hard-eligibility";

/**
 * Recorded api.auto.dev responses for the prod Find query
 * "Reliable used sedan, $15,000, <100k miles, near Dallas TX" (ZIP 75201, 50 mi, sort=price):
 *  - placeholder-first-page: price range "1-15750" → the first (cheapest) page is all $1 / $220 rows.
 *  - real-prices: price range "1000-15750" → real asks.
 */
const placeholderFirstPage = JSON.parse(
  readFileSync("fixtures/autodev-dallas-sedan-placeholder-first-page.json", "utf8"),
);
const realPrices = JSON.parse(readFileSync("fixtures/autodev-dallas-sedan-real-prices.json", "utf8"));

function deps(body: unknown, urls: string[]): AutodevDeps {
  return {
    cache: new TtlCache<unknown>(),
    counter: new MemoryCounter(),
    apiKey: "test-key",
    now: new Date("2026-11-28T00:00:00Z"),
    retryBaseMs: 1,
    sleep: async () => undefined,
    fetch: (async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch,
  };
}

const prodQuery = {
  priceRange: "1-15750",
  milesRange: "0-99999",
  used: true,
  zip: "75201",
  distanceMiles: 50,
  sort: "price" as const,
  limit: 50,
};

describe("placeholder prices at the provider (prod regression: 18 → 0 cars)", () => {
  it("the recorded ascending-price first page is entirely placeholder asks", () => {
    const prices = (placeholderFirstPage.data as Array<{ retailListing: { price: number } }>).map(
      (r) => r.retailListing.price,
    );
    expect(prices.length).toBeGreaterThanOrEqual(18);
    expect(prices.every((p) => p < PLACEHOLDER_PRICE_BELOW_USD)).toBe(true);
  });

  it("asks the provider for real prices only, so placeholders cannot fill the first page", () => {
    const url = listingsSearchUrl(prodQuery);
    expect(new URL(url).searchParams.get("retailListing.price")).toBe(`${PLACEHOLDER_PRICE_BELOW_USD}-15750`);
  });

  it("clamps the lower bound for every range shape and leaves others alone", () => {
    expect(realPriceRangeParam("1-25000")).toBe("1000-25000");
    expect(realPriceRangeParam("0-25000")).toBe("1000-25000");
    expect(realPriceRangeParam("5000-25000")).toBe("5000-25000");
    expect(realPriceRangeParam("-25000")).toBe("1000-25000");
    expect(realPriceRangeParam("2000-")).toBe("2000-");
    expect(realPriceRangeParam("1-")).toBe("1000-");
    expect(realPriceRangeParam("1-500")).toBe("1-500");
    expect(realPriceRangeParam("weird")).toBe("weird");
    expect(realPriceRangeParam(undefined)).toBeUndefined();
  });

  it("an all-placeholder page yields no cars and says how many rows were ignored (never invents prices)", async () => {
    const urls: string[] = [];
    const result = await autodevSearch(prodQuery, deps(placeholderFirstPage, urls));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.listings).toHaveLength(0);
    // 18 of the 20 recorded rows parse into listings: exactly the "count=18" prod logged before the price-sanity rule.
    expect(result.placeholderPricesDropped).toBe(18);
  });

  it("the real-price page keeps real cars, including sedans, and none is implausible", async () => {
    const urls: string[] = [];
    const result = await autodevSearch(prodQuery, deps(realPrices, urls));
    expect(urls[0]).toContain("retailListing.price=1000-15750");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.listings.length).toBeGreaterThan(0);
    expect(result.listings.some((l) => /sedan/i.test(`${l.bodyStyle} ${l.style}`))).toBe(true);
    expect(result.listings.every((l) => !hasImplausiblePrice(l, 2026))).toBe(true);
    // Only the year-floor rule removes anything here (e.g. a 2024 Mustang at $1,098), never a normal old sedan.
    expect(result.placeholderPricesDropped).toBeLessThan(realPrices.data.length);
    expect(result.listings.some((l) => l.year === 2015 && l.model === "Corolla" && l.priceUsd === 2495)).toBe(true);
  });
});
