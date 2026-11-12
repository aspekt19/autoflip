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
      // Toyota is first preferred model — every attempt times out (incl. Auto.dev retries).
      if (href.includes("Toyota") || href.includes("RAV4")) {
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
      preferredModelsSource: "user_note",
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
    expect(result.body.providerQueriesUsed).toBeGreaterThanOrEqual(2);
    const named =
      result.body.directions.find((d) => d.direction.segment === "Models you named") ??
      result.body.directions[0];
    expect(named).toBeTruthy();
    // Toyota attempts fail (incl. retries); other models should still deliver listings.
    expect(named!.listings.length).toBeGreaterThan(0);
    // Attempted ≥3; searchedModels = successfully checked only (timeouts → failedModels).
    expect(named!.plannedModels.length).toBeGreaterThanOrEqual(3);
    expect(named!.failedModels.some((m) => m.outcome === "timeout" || m.outcome === "error")).toBe(true);
    expect(named!.searchedModels.length).toBeGreaterThanOrEqual(2);
    expect(named!.searchedModels.every((m) => !named!.failedModels.some((f) => f.model === m.model))).toBe(true);
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

  it("diversifies named-model results so CR-V inventory cannot hide Tucson/Sportage rows", async () => {
    let crv = 0;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const href = String(url);
      if (!href.includes("api.auto.dev")) return servAllow();
      if (href.includes("CR-V") || href.includes("CR%2DV") || href.includes("CR-V")) {
        crv += 1;
        return autodevOk(
          Array.from({ length: 8 }, (_, i) =>
            listingRow(`5J6RM4H75K${String(i).padStart(7, "0")}`, "Honda", "CR-V", 12_000 + i * 100),
          ),
        );
      }
      if (href.includes("Tucson")) {
        return autodevOk([listingRow("KM8J3CA4XJU000101", "Hyundai", "Tucson", 13_500)]);
      }
      if (href.includes("Sportage")) {
        return autodevOk([listingRow("KNDPMCAC5L7000202", "Kia", "Sportage", 12_800)]);
      }
      return autodevOk([]);
    });

    const result = await runFindMatch(
      {
        need: {
          mode: "personal",
          useCase: "family",
          note: "family car around 15000 looking at Honda CR-V Hyundai Tucson Kia Sportage",
          budgetUsd: 15_000,
          budgetKnown: true,
          preferredModels: [
            { make: "Honda", model: "CR-V" },
            { make: "Hyundai", model: "Tucson" },
            { make: "Kia", model: "Sportage" },
          ],
          preferredModelsSource: "user_note",
          preferredMakes: ["Honda", "Hyundai", "Kia"],
          openToOtherMakes: true,
          zip: "68114",
          distanceMiles: 50,
          milesMax: null,
        },
      },
      {
        autodevKey: "test-key",
        servKey: "serv",
        fetch: fetchImpl as typeof fetch,
        autodev: { cache: new TtlCache<unknown>(), counter: new MemoryCounter() },
        kv: new MemoryKv(),
        env: {},
        maxProviderQueries: 6,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const named = result.body.directions.find((d) => d.direction.segment === "Models you named");
    expect(named).toBeTruthy();
    const models = new Set(named!.listings.map((l) => l.model));
    expect(models.has("CR-V")).toBe(true);
    expect(models.has("Tucson")).toBe(true);
    expect(models.has("Sportage")).toBe(true);
    expect(crv).toBeGreaterThanOrEqual(1);
  });

  it("does not repeat the same VIN under Models you named and Compact crossovers", async () => {
    const mazdaVin = VIN.mazda;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const href = String(url);
      if (!href.includes("api.auto.dev")) return servAllow();
      // Both CX-5 and CR-V (editorial alternative) return overlapping Mazda rows for CX-5 query;
      // CR-V returns a Honda. Named direction queries CX-5 then RAV4.
      if (href.includes("CX-5") || href.includes("CX%2D5") || href.includes("CX-5".replace("-", "%2D"))) {
        return autodevOk([
          listingRow(mazdaVin, "Mazda", "CX-5", 14_699),
          listingRow("JM3KFBAY5K0000011", "Mazda", "CX-5", 15_200),
        ]);
      }
      if (href.includes("RAV4")) {
        return autodevOk([]); // empty RAV4 — honest availability gap, not invented
      }
      if (href.includes("CR-V") || href.includes("CR%2DV")) {
        // Provider mistakenly echoes the same Mazda VIN — must not reappear under Compact crossovers.
        return autodevOk([
          listingRow(mazdaVin, "Mazda", "CX-5", 14_699),
          listingRow(VIN.honda, "Honda", "CR-V", 16_500),
        ]);
      }
      return autodevOk([]);
    });

    const result = await runFindMatch(
      {
        need: {
          mode: "personal",
          useCase: "family",
          note: "reliable used SUV around $20,000 family Mazda CX-5 and Toyota RAV4 open to other options",
          budgetUsd: 20_000,
          budgetKnown: true,
          preferredModels: [
            { make: "Mazda", model: "CX-5" },
            { make: "Toyota", model: "RAV4" },
          ],
          preferredModelsSource: "user_note",
          preferredMakes: ["Mazda", "Toyota"],
          openToOtherMakes: true,
          zip: "68114",
          distanceMiles: 50,
          milesMax: null,
        },
      },
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
    const named = result.body.directions.find((d) => d.direction.segment === "Models you named");
    const crossover = result.body.directions.find((d) => /crossover/i.test(d.direction.segment));
    expect(named).toBeTruthy();
    expect(crossover).toBeTruthy();
    expect(crossover!.direction.search.model).not.toBe("CX-5");
    expect(crossover!.direction.search.model).not.toBe("RAV4");
    const namedVins = new Set(named!.listings.map((l) => l.vin));
    expect(namedVins.has(mazdaVin)).toBe(true);
    expect(crossover!.listings.some((l) => l.vin === mazdaVin)).toBe(false);
    expect(crossover!.listings.some((l) => l.vin === VIN.honda)).toBe(true);
  });

  it("compsPool keeps over-budget / missing-price / odd-odometer rows (display may hide them)", async () => {
    // 17-char VINs — no I/O/Q (parser rejects otherwise → empty “ok” outcomes).
    const OVER = "4T1B11HK5JU000701";
    const MISSING = "4T1B11HK5JU000702";
    const ODD = "4T1B11HK5JU000703";
    const OK = "4T1B11HK5JU000704";
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const href = String(url);
      if (!href.includes("api.auto.dev")) return servAllow();
      return autodevOk([
        {
          vin: OK,
          vehicle: { year: 2019, make: "Toyota", model: "Camry", trim: null },
          retailListing: {
            price: 15_000,
            miles: 40_000,
            used: true,
            city: "Bentonville",
            state: "AR",
            zip: "72712",
            vdpURL: null,
            primaryImage: null,
          },
        },
        {
          vin: OVER,
          vehicle: { year: 2019, make: "Toyota", model: "Camry", trim: null },
          retailListing: {
            price: 45_000,
            miles: 30_000,
            used: true,
            city: "Bentonville",
            state: "AR",
            zip: "72712",
            vdpURL: null,
            primaryImage: null,
          },
        },
        {
          vin: MISSING,
          vehicle: { year: 2018, make: "Toyota", model: "Camry", trim: null },
          retailListing: {
            price: null,
            miles: 50_000,
            used: true,
            city: "Bentonville",
            state: "AR",
            zip: "72712",
            vdpURL: null,
            primaryImage: null,
          },
        },
        {
          vin: ODD,
          vehicle: { year: 2020, make: "Toyota", model: "Camry", trim: null },
          retailListing: {
            price: 12_000,
            miles: 274_026,
            used: true,
            city: "Bentonville",
            state: "AR",
            zip: "72712",
            vdpURL: null,
            primaryImage: null,
          },
        },
      ]);
    });

    const result = await runFindMatch(
      {
        need: {
          mode: "personal",
          useCase: "commute",
          budgetUsd: 20_000,
          budgetKnown: true,
          preferredModels: [{ make: "Toyota", model: "Camry" }],
          preferredMakes: ["Toyota"],
          openToOtherMakes: false,
          zip: "72712",
          distanceMiles: 100,
          milesMax: null,
          note: null,
        },
      },
      {
        autodevKey: "test-key",
        servKey: "serv",
        fetch: fetchImpl as typeof fetch,
        autodev: { cache: new TtlCache<unknown>(), counter: new MemoryCounter() },
        kv: new MemoryKv(),
        env: {},
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const compsVins = new Set(result.body.compsPool.map((row) => row.vin));
    // Hygiene-only compsPool must expose rows that display filters would drop.
    expect(compsVins.has(OK)).toBe(true);
    expect(compsVins.has(OVER)).toBe(true);
    expect(compsVins.has(MISSING)).toBe(true);
    expect(compsVins.has(ODD)).toBe(true);

    const shownVins = new Set(
      result.body.directions.flatMap((group) => group.listings.map((row) => row.vin)),
    );
    // Display page may still hide product-filter / odd-odo rows.
    expect(shownVins.has(OK)).toBe(true);
    expect(shownVins.has(OVER)).toBe(false);
    expect(shownVins.has(MISSING)).toBe(false);
    expect(shownVins.has(ODD)).toBe(false);
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
