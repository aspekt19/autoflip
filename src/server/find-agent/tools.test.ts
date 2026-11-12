import { describe, expect, it } from "vitest";
import { TtlCache } from "@/io/cache";
import { MemoryCounter } from "@/io/quota";
import type { Listing } from "@/domain/types";
import {
  applySearchListingsFunnel,
  createFindAgentToolState,
  executeFindAgentTool,
  parseLimitArg,
  parseSearchListingsArgs,
  parseZipArg,
  relaxHintsFromFunnel,
} from "./tools";

describe("find-agent tool arg validation", () => {
  it("rejects a bad zip", () => {
    const bad = parseZipArg("ABCDE");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues[0]?.field).toBe("zip");
  });

  it("accepts a 5-digit zip", () => {
    const ok = parseZipArg("33101");
    expect(ok).toEqual({ ok: true, value: "33101" });
  });

  it("rejects limit over 50", () => {
    const bad = parseLimitArg(99);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues[0]?.field).toBe("limit");
  });

  it("rejects search_listings with bad zip and limit together", () => {
    const bad = parseSearchListingsArgs({ make: "Toyota", zip: "nope", limit: 99 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.issues.some((i) => i.field === "zip")).toBe(true);
      expect(bad.issues.some((i) => i.field === "limit")).toBe(true);
    }
  });

  it("accepts bodyFamily and transmission", () => {
    const ok = parseSearchListingsArgs({
      make: "Toyota",
      bodyFamily: "car",
      transmission: "automatic",
      zip: "43215",
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.bodyFamily).toBe("car");
      expect(ok.value.transmission).toBe("automatic");
    }
  });
});

function listing(partial?: Partial<Listing>): Listing {
  return {
    vin: "JTMRWRFV0KJ123456",
    year: 2018,
    make: "Toyota",
    model: "Camry",
    trim: "LE",
    miles: 62000,
    priceUsd: 14_500,
    city: "Columbus",
    state: "OH",
    zip: "43215",
    dealer: "Test",
    vdp: "https://example.com/vdp",
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: false,
    accidentCount: 0,
    oneOwner: true,
    ownerCount: 1,
    usageType: null,
    fuel: "Gasoline",
    engine: null,
    drivetrain: "FWD",
    transmission: "Automatic",
    bodyStyle: "Car",
    style: "Sedan",
    distanceMiles: 42,
    createdAt: "2026-01-01T00:00:00.000Z",
    latitude: null,
    longitude: null,
    removedAt: null,
    source: "autodev",
    ...partial,
  };
}

describe("search_listings funnel", () => {
  it("counts body_family locally when feed tags Car + Sedan style", () => {
    const rows = [
      listing(),
      listing({ vin: "JTMRWRFV0KJ123457", bodyStyle: "SUV", style: "SUV", model: "RAV4" }),
    ];
    const { listings: kept, funnel } = applySearchListingsFunnel(rows, {
      bodyStyle: "Sedan",
      priceMaxUsd: 20_000,
      milesMax: 100_000,
      zip: "43215",
      radiusMi: 100,
    });
    expect(funnel.map((s) => s.step)).toEqual([
      "provider_raw",
      "normalized_vin_ymm",
      "passenger_gate",
      "transmission",
      "body_family",
      "price",
      "miles",
      "radius",
    ]);
    expect(funnel.find((s) => s.step === "provider_raw")?.count).toBe(2);
    expect(funnel.find((s) => s.step === "body_family")?.count).toBe(1);
    // Boundary: returned listings are unfiltered (both passengers); funnel shows body cut.
    expect(kept).toHaveLength(2);
    expect(kept.map((r) => r.model).sort()).toEqual(["Camry", "RAV4"]);
  });

  it("hints omit_body when provider_raw is 0 with a car body request", () => {
    const hints = relaxHintsFromFunnel([{ step: "provider_raw", count: 0 }], {
      bodyStyle: "Sedan",
      priceMaxUsd: 11_000,
    });
    expect(hints).toContain("omit_body");
    expect(hints).toContain("raise_price");
  });

  it("omits Sedan on the provider URL and returns funnel + relaxHints", async () => {
    let requestedUrl = "";
    const fetchImpl: typeof fetch = async (input) => {
      requestedUrl = String(input);
      if (requestedUrl.includes("listings")) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    };
    const executed = await executeFindAgentTool(
      "search_listings",
      { make: "Toyota", bodyStyle: "Sedan", zip: "43215", radiusMi: 100, priceMaxUsd: 11000 },
      {
        fetch: fetchImpl,
        autodevKey: "test",
        autodev: { cache: new TtlCache<unknown>(), counter: new MemoryCounter() },
      },
      createFindAgentToolState(),
    );
    expect(executed.ok).toBe(true);
    expect(requestedUrl).not.toMatch(/bodyStyle=Sedan/i);
    expect(Array.isArray(executed.result.funnel)).toBe(true);
    expect(executed.result.totalReturned).toBe(0);
    expect(executed.result.relaxHints).toEqual(expect.arrayContaining(["omit_body"]));
    const query = executed.result.query as { providerBodyStyle: string | null };
    expect(query.providerBodyStyle).toBeNull();
  });
});
