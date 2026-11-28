import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TtlCache } from "@/io/cache";
import { MemoryCounter } from "@/io/quota";
import { createFindAgentToolState, executeFindAgentTool } from "./tools";

/** Recorded Dallas payloads (api.auto.dev, 2026-11-28) and the dealer-ZIP geocodes the same feed returned. */
const zips = JSON.parse(readFileSync("fixtures/autodev-dallas-zip-lookups.json", "utf8")) as Record<string, Record<string, unknown>>;
const cheapest = JSON.parse(readFileSync("fixtures/autodev-dallas-sedan-real-prices.json", "utf8")) as { data: unknown[] };
const sorts = JSON.parse(readFileSync("fixtures/autodev-dallas-representative-sorts.json", "utf8")) as Record<string, unknown[]>;

type Calls = { listings: string[]; zip: string[] };

function stub(calls: Calls, opts: { zipDown?: () => boolean } = {}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const zip = /\/api\/zip\/(\d{5})/.exec(url)?.[1];
    if (zip) {
      calls.zip.push(zip);
      if (opts.zipDown?.() && zip !== "75201") return new Response("down", { status: 503 });
      return new Response(JSON.stringify({ success: true, payload: zips[zip] }), { status: 200 });
    }
    if (url.includes("/listings")) {
      calls.listings.push(url);
      const sort = new URL(url).searchParams.get("sort");
      const make = new URL(url).searchParams.get("vehicle.make");
      // Model-specific searches return the cheapest-end rows (they carry dealer ZIPs without coordinates).
      const data = make ? cheapest.data : (sorts[`broad:${sort}`] ?? []);
      return new Response(JSON.stringify({ data }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

const deps = (fetchImpl: typeof fetch) => ({
  fetch: fetchImpl,
  autodevKey: "t",
  autodev: { cache: new TtlCache<unknown>(), counter: new MemoryCounter(), maxAttempts: 1 },
});

describe("search_listings: representative strategy", () => {
  it("runs newest + highest-within-budget views, never cheapest-first, and tells SERV so", async () => {
    const calls: Calls = { listings: [], zip: [] };
    const executed = await executeFindAgentTool(
      "search_listings",
      { sort: "price", zip: "75201", radiusMi: 50, priceMaxUsd: 15_000, milesMax: 100_000 },
      deps(stub(calls)),
      createFindAgentToolState(),
    );
    expect(executed.ok).toBe(true);
    const sortParams = calls.listings.map((u) => new URL(u).searchParams.get("sort")).sort();
    expect(sortParams).toEqual(["retailListing.price.desc", "vehicle.year.desc"]);
    expect(calls.listings.every((u) => new URL(u).searchParams.get("retailListing.price") === "1000-15750")).toBe(true);
    const strategy = executed.result.searchStrategy as { sorts: string[]; note: string };
    expect(strategy.sorts).toHaveLength(2);
    expect(strategy.note).toMatch(/Cheapest-first is not used/);
    const cars = executed.result.cars as Array<{ year: number; price: number }>;
    expect(cars.some((c) => c.year >= 2023)).toBe(true);
    expect(cars.every((c) => c.price >= 1_000)).toBe(true);
  });
});

describe("search_listings: distance (cards showed 'unverified' for dealer-ZIP-only rows)", () => {
  const search = (state: ReturnType<typeof createFindAgentToolState>, calls: Calls, opts?: Parameters<typeof stub>[1]) =>
    executeFindAgentTool(
      "search_listings",
      { make: "Toyota", model: "Corolla", zip: "75201", radiusMi: 50, priceMaxUsd: 15_000 },
      deps(stub(calls, opts)),
      state,
    );

  it("fills distance from the dealer ZIP when the feed coordinates are 0,0", async () => {
    const calls: Calls = { listings: [], zip: [] };
    const executed = await search(createFindAgentToolState(), calls);
    const cars = executed.result.cars as Array<{ model: string; price: number; distanceMiles: number | null }>;
    const corolla = cars.find((c) => c.model === "Corolla" && c.price === 2_495);
    // The recorded Corolla row has location [0,0]; ZIP 75229 is ~8 miles from 75201.
    expect(corolla?.distanceMiles).toBe(8);
  });

  it("resolves each dealer ZIP once per run and keeps a known distance when a later search cannot place the car", async () => {
    const calls: Calls = { listings: [], zip: [] };
    const state = createFindAgentToolState();
    await search(state, calls);
    // Local Census centroids fill Dallas-area ZIPs; the live ZIP service is not needed.
    expect(calls.zip.filter((z) => z === "75229")).toHaveLength(0);
    let down = true;
    const second = await search(state, calls, { zipDown: () => down });
    down = false;
    expect(calls.zip.filter((z) => z === "75229")).toHaveLength(0);
    const vin = (second.result.cars as Array<{ vin: string; price: number; model: string }>).find(
      (c) => c.model === "Corolla" && c.price === 2_495,
    )!.vin;
    expect(state.listingsByVin.get(vin.toUpperCase())?.distanceMiles).toBe(8);
  });

  it("keeps an earlier distance when a later row for the same car has none", async () => {
    const calls: Calls = { listings: [], zip: [] };
    const state = createFindAgentToolState();
    await search(state, calls);
    const vin = [...state.listingsByVin.values()].find((l) => l.model === "Corolla")!.vin!.toUpperCase();
    const known = state.listingsByVin.get(vin)!;
    expect(known.distanceMiles).toEqual(expect.any(Number));
    // Simulate the loop remembering the same car again from a search that could not place it.
    state.zipPoints.clear();
    const down: Calls = { listings: [], zip: [] };
    await executeFindAgentTool(
      "search_listings",
      { make: "Toyota", model: "Corolla", zip: "75201", radiusMi: 50, priceMaxUsd: 15_000 },
      deps(stub(down, { zipDown: () => true })),
      state,
    );
    expect(state.listingsByVin.get(vin)?.distanceMiles).toBe(known.distanceMiles);
    expect(state.listingsByVin.get(vin)?.radiusCheck).toBe("known");
  });
});
