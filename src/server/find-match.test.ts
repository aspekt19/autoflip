import { describe, expect, it, vi } from "vitest";
import { MemoryKv } from "@/io/kv";
import { TtlCache } from "@/io/cache";
import { MemoryCounter } from "@/io/quota";
import { listingsSearchUrl } from "@/io/autodev";
import { runFindMatch } from "./find-match";

/** 17-char VINs — no I/O/Q (parser rejects otherwise → empty “ok” outcomes). */
function listingRow(vin: string, make: string, model: string, price = 15_000) {
  return {
    vin,
    vehicle: { year: 2019, make, model, trim: null },
    retailListing: {
      price,
      miles: 40_000,
      used: true,
      city: "Bentonville",
      state: "AR",
      zip: "72712",
      vdpURL: null,
      primaryImage: null,
    },
  };
}

const VIN = {
  toyota: "4T1B11HK5JU000001",
  mazda: "JM3KFBAY5K0000002",
  honda: "5J6RM4H75KL000003",
  camry: "4T1B11HK5JU000099",
} as const;

function servAllow() {
  return Response.json({ choices: [{ message: { content: "ALLOW" } }] });
}

function autodevOk(rows: unknown[]) {
  return Response.json({ data: rows });
}

describe("runFindMatch Stage2A search semantics", () => {
  it("searches ≥3 named preferred models and continues after first timeout", async () => {
    const fetches: string[] = [];
    let autodevCalls = 0;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const href = String(url);
      if (href.includes("openserv") || href.includes("inference") || href.includes("chat/completions")) {
        return servAllow();
      }
      fetches.push(href);
      autodevCalls += 1;
      // First model times out / fails; later models succeed.
      if (autodevCalls === 1) {
        throw new Error("network timeout");
      }
      const make = href.includes("Mazda")
        ? "Mazda"
        : href.includes("Honda")
          ? "Honda"
          : "Toyota";
      const model = make === "Mazda" ? "CX-5" : make === "Honda" ? "CR-V" : "RAV4";
      const vin = make === "Mazda" ? VIN.mazda : make === "Honda" ? VIN.honda : VIN.toyota;
      return autodevOk([listingRow(vin, make, model)]);
    });

    const need = {
      mode: "personal",
      useCase: "family",
      budgetUsd: 25_000,
      budgetKnown: true,
      preferredModels: [
        { make: "Toyota", model: "RAV4" },
        { make: "Mazda", model: "CX-5" },
        { make: "Honda", model: "CR-V" },
      ],
      preferredMakes: ["Toyota", "Mazda", "Honda"],
      openToOtherMakes: false,
      zip: "72712",
      distanceMiles: 100,
      milesMax: 80_000,
      note: null,
    };

    const result = await runFindMatch(
      { need },
      {
        autodevKey: "test-key",
        servKey: "serv",
        fetch: fetchImpl as typeof fetch,
        autodev: {
          cache: new TtlCache<unknown>(),
          counter: new MemoryCounter(),
        },
        kv: new MemoryKv(),
        env: {},
        maxProviderQueries: 6,
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.partialFailure).toBe(true);
    expect(result.body.providerQueriesUsed).toBeGreaterThanOrEqual(3);
    const named = result.body.directions.find((d) => d.direction.segment === "Models you named");
    expect(named).toBeTruthy();
    expect(named!.searchedModels.length).toBeGreaterThanOrEqual(3);
    expect(named!.queryOutcomes[0]?.outcome).toMatch(/timeout|error/);
    expect(named!.queryOutcomes.slice(1).some((o) => o.outcome === "ok")).toBe(true);
    expect(named!.listings.length).toBeGreaterThan(0);
    expect(fetches.length).toBeGreaterThanOrEqual(3);
    // Must not enlarge limit to evade quota.
    expect(fetches.filter((u) => u.includes("api.auto.dev")).every((u) => u.includes("limit=20"))).toBe(true);
  });

  it("nationwide (blank ZIP / no radius) keys comps as nationwide — not desired ZIP", async () => {
    const kv = new MemoryKv();
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const href = String(url);
      if (!href.includes("api.auto.dev")) return servAllow();
      return autodevOk([listingRow(VIN.camry, "Toyota", "Camry")]);
    });

    const need = {
      mode: "personal",
      useCase: "commute",
      budgetUsd: 20_000,
      budgetKnown: true,
      preferredModels: [{ make: "Toyota", model: "Camry" }],
      preferredMakes: ["Toyota"],
      openToOtherMakes: false,
      zip: null,
      distanceMiles: null,
      milesMax: null,
      note: null,
    };

    const result = await runFindMatch(
      { need },
      {
        autodevKey: "test-key",
        servKey: "serv",
        fetch: fetchImpl as typeof fetch,
        autodev: {
          cache: new TtlCache<unknown>(),
          counter: new MemoryCounter(),
        },
        kv,
        env: {},
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.geoScope.kind).toBe("nationwide");
    expect(result.body.scope.toLowerCase()).toMatch(/nationwide/);
    const anyNationwide = await (async () => {
      for (const year of [2018, 2019, 2020]) {
        const hit = await kv.get(`comps:v2:toyota:camry:${year}:nationwide`);
        if (hit) return hit;
      }
      return null;
    })();
    expect(anyNationwide).toBeTruthy();
    const parsed = JSON.parse(anyNationwide!) as { schemaVersion: number; geo: { kind: string } };
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.geo.kind).toBe("nationwide");
    expect(await kv.get("comps:v2:toyota:camry:2019:zip:727:d100")).toBeNull();
    void listingsSearchUrl;
  });

  it("optional ZIP nationwide vs ZIP+radius: multi-make searchZip omitted when nationwide", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const href = String(url);
      if (!href.includes("api.auto.dev")) return servAllow();
      urls.push(href);
      const make = href.includes("Mazda") ? "Mazda" : "Toyota";
      return autodevOk([
        listingRow(make === "Mazda" ? VIN.mazda : VIN.toyota, make, make === "Mazda" ? "CX-5" : "RAV4"),
      ]);
    });

    const nationwide = await runFindMatch(
      {
        need: {
          mode: "personal",
          useCase: "family",
          budgetUsd: 25_000,
          budgetKnown: true,
          preferredModels: [
            { make: "Toyota", model: "RAV4" },
            { make: "Mazda", model: "CX-5" },
          ],
          preferredMakes: ["Toyota", "Mazda"],
          openToOtherMakes: false,
          zip: null,
          distanceMiles: null,
        },
      },
      {
        autodevKey: "k",
        servKey: "s",
        fetch: fetchImpl as typeof fetch,
        autodev: {
          cache: new TtlCache<unknown>(),
          counter: new MemoryCounter(),
        },
        kv: new MemoryKv(),
        env: {},
      },
    );
    expect(nationwide.ok).toBe(true);
    if (!nationwide.ok) return;
    expect(nationwide.body.geoScope.kind).toBe("nationwide");
    expect(urls.every((u) => !u.includes("zip="))).toBe(true);

    urls.length = 0;
    const local = await runFindMatch(
      {
        need: {
          mode: "personal",
          useCase: "family",
          budgetUsd: 25_000,
          budgetKnown: true,
          preferredModels: [{ make: "Toyota", model: "RAV4" }],
          preferredMakes: ["Toyota"],
          openToOtherMakes: false,
          zip: "72712",
          distanceMiles: 100,
        },
      },
      {
        autodevKey: "k",
        servKey: "s",
        fetch: fetchImpl as typeof fetch,
        autodev: {
          cache: new TtlCache<unknown>(),
          counter: new MemoryCounter(),
        },
        kv: new MemoryKv(),
        env: {},
      },
    );
    expect(local.ok).toBe(true);
    if (!local.ok) return;
    expect(local.body.geoScope).toEqual({ kind: "zip", zip: "72712", distanceMiles: 100 });
    expect(urls.some((u) => u.includes("zip=72712"))).toBe(true);
    expect(urls.some((u) => u.includes("distance=100"))).toBe(true);
  });

  it("fail-closes on serverless Memory before Autodev (shared-store)", async () => {
    const fetchSpy = vi.fn(async () => servAllow());
    const result = await runFindMatch(
      {
        need: {
          mode: "personal",
          useCase: "family",
          budgetUsd: 20_000,
          budgetKnown: true,
          preferredModels: [{ make: "Toyota", model: "RAV4" }],
          preferredMakes: ["Toyota"],
          openToOtherMakes: false,
          zip: "72712",
          distanceMiles: 100,
        },
      },
      {
        autodevKey: "test-key",
        servKey: "serv",
        fetch: fetchSpy as typeof fetch,
        autodev: {
          cache: new TtlCache<unknown>(),
          counter: new MemoryCounter(),
        },
        kv: new MemoryKv(),
        env: { VERCEL: "1" },
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.body.error).toBe("quota_backend_not_distributed");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
