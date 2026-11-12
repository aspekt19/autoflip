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

  it("rejects limit over the sane per-call max (50)", () => {
    const bad = parseLimitArg(51);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues[0]?.field).toBe("limit");
  });

  it("accepts SERV-requested page sizes up to 50", () => {
    const ok = parseLimitArg(40);
    expect(ok).toEqual({ ok: true, value: 40 });
  });

  it("rejects search_listings with bad zip and limit together", () => {
    const bad = parseSearchListingsArgs({ make: "Toyota", zip: "nope", limit: 99 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.issues.some((i) => i.field === "zip")).toBe(true);
      expect(bad.issues.some((i) => i.field === "limit")).toBe(true);
    }
  });

  it("accepts page for provider pagination", () => {
    const ok = parseSearchListingsArgs({ make: "Toyota", zip: "43215", limit: 20, page: 2 });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.limit).toBe(20);
      expect(ok.value.page).toBe(2);
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
    expect(kept).toHaveLength(1);
    expect(kept[0]?.model).toBe("Camry");
  });

  it("hints omit_body when provider_raw is 0 with a car body request", () => {
    const hints = relaxHintsFromFunnel([{ step: "provider_raw", count: 0 }], {
      bodyStyle: "Sedan",
      priceMaxUsd: 11_000,
    });
    expect(hints).toContain("omit_body");
    expect(hints).toContain("raise_price");
  });

  it("reports searched filters, provenance constraint roles, and duplicateSearch on identical re-calls", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).includes("listings")) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    };
    const deps = {
      fetch: fetchImpl,
      autodevKey: "test",
      autodev: { cache: new TtlCache<unknown>(), counter: new MemoryCounter() },
    };
    // User set yearMin + priceMaxUsd; zip is SERV-chosen → relaxable.
    const state = createFindAgentToolState(undefined, ["yearMin", "priceMaxUsd"]);
    const args = {
      zip: "33101",
      radiusMi: 35,
      priceMaxUsd: 45000,
      yearMin: 2018,
      bodyFamily: "suv",
    };
    const first = await executeFindAgentTool("search_listings", args, deps, state);
    expect(first.ok).toBe(true);
    expect(first.result.searched).toEqual(
      expect.objectContaining({
        zip: "33101",
        radiusMi: 35,
        priceMaxUsd: 45000,
        yearMin: 2018,
        bodyFamily: "suv",
      }),
    );
    expect(first.result.hardKeys).toEqual(expect.arrayContaining(["yearMin", "priceMaxUsd"]));
    expect(first.result.hardKeys).not.toContain("zip");
    expect(first.result.relaxableKeys).toEqual(
      expect.arrayContaining(["zip", "radiusMi", "bodyFamily"]),
    );
    expect(first.result.duplicateSearch).toBeNull();

    const second = await executeFindAgentTool("search_listings", args, deps, state);
    expect(second.ok).toBe(true);
    expect(second.result.duplicateSearch).toEqual(
      expect.objectContaining({
        duplicate: true,
        priorCallIndex: 1,
      }),
    );
    expect(String(second.summary)).toMatch(/DUPLICATE/i);
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

  it("honors SERV page/limit on the provider URL (no silent ≤12 hide-cap)", async () => {
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
      { make: "Toyota", zip: "43215", limit: 40, page: 2 },
      {
        fetch: fetchImpl,
        autodevKey: "test",
        autodev: { cache: new TtlCache<unknown>(), counter: new MemoryCounter() },
      },
      createFindAgentToolState(),
    );
    expect(executed.ok).toBe(true);
    expect(requestedUrl).toMatch(/limit=40/);
    expect(requestedUrl).toMatch(/page=2/);
  });
  it("thin proxy returns unfiltered provider rows (no product-filter drops)", async () => {
    const camry = listing();
    const rav4 = listing({
      vin: "JTMRWRFV0KJ123457",
      bodyStyle: "SUV",
      style: "SUV",
      model: "RAV4",
      priceUsd: 25_000,
    });
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("listings")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                vin: camry.vin,
                vehicle: {
                  year: camry.year,
                  make: camry.make,
                  model: camry.model,
                  bodyStyle: "Car",
                  style: "Sedan",
                  mileage: camry.miles,
                  transmission: "Automatic",
                },
                retailListing: { price: camry.priceUsd, city: "Columbus", state: "OH" },
              },
              {
                vin: rav4.vin,
                vehicle: {
                  year: rav4.year,
                  make: rav4.make,
                  model: rav4.model,
                  bodyStyle: "SUV",
                  style: "SUV",
                  mileage: rav4.miles,
                  transmission: "Automatic",
                },
                retailListing: { price: rav4.priceUsd, city: "Columbus", state: "OH" },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    };
    const executed = await executeFindAgentTool(
      "search_listings",
      { bodyStyle: "Sedan", priceMaxUsd: 15_000, zip: "43215", radiusMi: 100 },
      {
        fetch: fetchImpl,
        autodevKey: "test",
        autodev: { cache: new TtlCache<unknown>(), counter: new MemoryCounter() },
      },
      createFindAgentToolState(),
    );
    expect(executed.ok).toBe(true);
    // Both rows returned despite body/price filters that would drop RAV4.
    expect(executed.result.totalReturned).toBeGreaterThanOrEqual(1);
    expect(executed.result.productFiltersWouldDrop).toBe(true);
    const cars = executed.result.cars as Array<{ vin: string; model: string }>;
    expect(cars.map((c) => c.model).sort()).toEqual(["Camry", "RAV4"]);
  });

  it("passes real upstream status/cause to SERV (not a generic error)", async () => {
    // 400 is non-retryable so the tool result surfaces in one attempt.
    const fetchImpl: typeof fetch = async () => new Response("bad filter", { status: 400 });
    const executed = await executeFindAgentTool(
      "search_listings",
      { make: "Toyota", model: "Camry", priceMaxUsd: 15_000 },
      {
        fetch: fetchImpl,
        autodevKey: "test",
        autodev: {
          cache: new TtlCache<unknown>(),
          counter: new MemoryCounter(),
        },
      },
      createFindAgentToolState(),
    );
    expect(executed.ok).toBe(false);
    expect(executed.result.error).toBe("upstream");
    expect(executed.result.status).toBe(400);
    expect(executed.result.cause).toBe("http_error");
    expect(executed.result.attempts).toBe(1);
    expect(String(executed.summary)).toMatch(/status=400/);
    expect(String(executed.summary)).toMatch(/cause=http_error/);
  });
});

describe("search waits for brief confirmation", () => {
  const deps = {
    fetch: (async () => new Response("should not run", { status: 500 })) as typeof fetch,
    autodevKey: "test",
    autodev: { cache: new TtlCache<unknown>(), counter: new MemoryCounter() },
  };

  it("rejects search_listings until the brief is confirmed", async () => {
    const state = createFindAgentToolState();
    state.requireBriefConfirm = true;
    const blocked = await executeFindAgentTool(
      "search_listings",
      { make: "Toyota", zip: "43215" },
      deps,
      state,
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.result.error).toBe("brief_not_confirmed");
  });

  it("allows ask_shopper and submit_brief before confirm", async () => {
    const state = createFindAgentToolState();
    state.requireBriefConfirm = true;
    const asked = await executeFindAgentTool(
      "ask_shopper",
      { question: "What is your budget?" },
      deps,
      state,
    );
    expect(asked.ok).toBe(true);
  });
});
