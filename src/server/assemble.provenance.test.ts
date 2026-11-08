/**
 * Ask/miles provenance must survive trusted find handoff without claiming "typed in".
 * Offline mocked Autodev only — no live providers / credits.
 */
import { describe, expect, it, vi } from "vitest";
import { TtlCache } from "@/io/cache";
import { MemoryKv } from "@/io/kv";
import { MemoryCounter } from "@/io/quota";
import { assembleReport } from "./assemble";

const VIN = "JM3KFBDM2J0424661";
const VDP = "https://dealer.example/auto/used-2018-mazda-cx-5/1/";

function listingPayload() {
  return {
    vin: VIN,
    vehicle: { year: 2018, make: "Mazda", model: "CX-5", trim: "Grand Touring" },
    retailListing: {
      price: 14_699,
      miles: 136_350,
      used: true,
      city: "Omaha",
      state: "NE",
      zip: "68107",
      vdp: VDP,
      primaryImage: null,
    },
    history: { accidentCount: null, oneOwner: null, ownerCount: null },
  };
}

function mockFetch(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const href = String(input);
    if (href.includes("api.auto.dev/listings/") && href.includes(VIN)) {
      return Response.json(listingPayload());
    }
    if (href.includes("api.auto.dev/listings") && href.includes("make=")) {
      return Response.json({
        data: [
          listingPayload(),
          {
            ...listingPayload(),
            vin: "JM3KFBDM2J0424662",
            retailListing: { ...listingPayload().retailListing, price: 15_200, miles: 120_000 },
          },
          {
            ...listingPayload(),
            vin: "JM3KFBDM2J0424663",
            retailListing: { ...listingPayload().retailListing, price: 13_900, miles: 140_000 },
          },
          {
            ...listingPayload(),
            vin: "JM3KFBDM2J0424664",
            retailListing: { ...listingPayload().retailListing, price: 14_100, miles: 130_000 },
          },
          {
            ...listingPayload(),
            vin: "JM3KFBDM2J0424665",
            retailListing: { ...listingPayload().retailListing, price: 14_400, miles: 125_000 },
          },
        ],
      });
    }
    if (href.includes("vpic.nhtsa")) {
      return Response.json({
        Results: [{ ModelYear: 2018, Make: "MAZDA", Model: "CX-5", ErrorCode: "0" }],
      });
    }
    if (href.includes("nhtsa.gov") || href.includes("fueleconomy") || href.includes("geocoding.geo.census")) {
      return Response.json({ results: [], Results: [], count: 0, result: { addressMatches: [] } });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

const deps = {
  autodevKey: "test-key",
  fetch: mockFetch(),
  autodev: { cache: new TtlCache(), counter: new MemoryCounter() },
  kv: new MemoryKv(),
  env: {},
};

describe("assembleReport ask/miles provenance", () => {
  it("labels trusted find-feed overlays as seller-feed, not typed-in", async () => {
    const result = await assembleReport(
      {
        mode: "personal",
        vin: VIN,
        url: VDP,
        zip: "68114",
        miles: 136_350,
        askingPriceUsd: 14_699,
        factSource: "find_feed",
        budgetUsd: 20_000,
        budgetKnown: true,
      },
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const notes = result.report.computed.dataNotes.join("\n");
    expect(notes).toMatch(/came from the seller listing feed selected on Find/i);
    expect(notes).not.toMatch(/typed in for this VIN/i);
  });

  it("keeps typed-in wording for manual Check / VIN overlays", async () => {
    const result = await assembleReport(
      {
        mode: "personal",
        vin: VIN,
        url: VDP,
        zip: "68114",
        miles: 136_350,
        askingPriceUsd: 14_699,
        factSource: "typed",
        budgetUsd: 20_000,
        budgetKnown: true,
      },
      {
        ...deps,
        fetch: mockFetch(),
        autodev: { cache: new TtlCache(), counter: new MemoryCounter() },
        kv: new MemoryKv(),
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const notes = result.report.computed.dataNotes.join("\n");
    expect(notes).toMatch(/Asking price was typed in for this VIN/i);
    expect(notes).toMatch(/Mileage was typed in for this VIN/i);
    expect(notes).not.toMatch(/seller listing feed selected on Find/i);
  });
});
