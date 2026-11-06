/**
 * Stage2A-followon — three reviewer integration gaps.
 * Full route/dispatch spies: persistent reserve, empty≠fail, model honesty.
 */
import { describe, expect, it, vi } from "vitest";
import { MemoryKv } from "@/io/kv";
import { TtlCache } from "@/io/cache";
import { MemoryCounter } from "@/io/quota";
import { monthKey } from "@/io/quota";
import { __quotaKeys, reserveTotalCall } from "@/io/persistent-quota";
import { ASSUMPTIONS } from "@/domain/assumptions";
import { proposeDirections } from "@/domain/directions";
import { findEmptyCopy, statusForFindEmpty } from "@/domain/find-empty";
import { emptyNeed } from "@/domain/need";
import { assembleRadar } from "./assemble";
import { runFindMatch } from "./find-match";

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
  a: "4T1B11HK5JU000001",
  b: "JM3KFBAY5K0000002",
  c: "5J6RM4H75KL000003",
} as const;

function servAllow() {
  return Response.json({ choices: [{ message: { content: "ALLOW" } }] });
}

function baseNeed(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

function deps(opts: {
  kv: MemoryKv;
  fetch: typeof fetch;
  reserve?: () => ReturnType<typeof reserveTotalCall>;
  maxProviderQueries?: number;
  env?: Record<string, string | undefined>;
  now?: Date;
}) {
  return {
    autodevKey: "test-key",
    servKey: "serv",
    fetch: opts.fetch,
    autodev: {
      cache: new TtlCache<unknown>(),
      counter: new MemoryCounter(),
      reserve: opts.reserve ?? (() => reserveTotalCall(opts.kv, opts.now ?? new Date("2026-11-06T12:00:00Z"))),
    },
    kv: opts.kv,
    env: opts.env ?? {},
    maxProviderQueries: opts.maxProviderQueries,
    now: opts.now ?? new Date("2026-11-06T12:00:00Z"),
  };
}

describe("Stage2A-followon: empty ≠ all-failure", () => {
  it("all-timeout → not 200 empty_inventory; truthful timeout copy", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (!String(url).includes("api.auto.dev")) return servAllow();
      throw new Error("network timeout");
    });
    const result = await runFindMatch(
      { need: baseNeed() },
      deps({ kv: new MemoryKv(), fetch: fetchImpl as typeof fetch }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(504);
    expect(result.body.emptyReason).toBe("provider_timeout");
    expect(result.body.emptyReason).not.toBe("empty_inventory");
    expect(String(result.body.headline)).toMatch(/timed out/i);
    expect(String(result.body.nextStep)).toMatch(/not treat this as proof/i);
    expect(String(result.body.headline)).not.toMatch(/No matching listings/i);
  });

  it("all demo_limit → 429 demo_limit, not empty_inventory", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (!String(url).includes("api.auto.dev")) return servAllow();
      throw new Error("should not fetch — quota blocks first");
    });
    const kv = new MemoryKv();
    const now = new Date("2026-11-06T12:00:00Z");
    const month = monthKey(now);
    // Seed at monthly stop so every reserve fails before fetch.
    await kv.set(__quotaKeys.totalMonthKey(month), String(ASSUMPTIONS.autodevMonthlyStop));

    const result = await runFindMatch(
      { need: baseNeed() },
      deps({
        kv,
        fetch: fetchImpl as typeof fetch,
        now,
        reserve: () => reserveTotalCall(kv, now),
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(429);
    expect(result.body.emptyReason).toBe("demo_limit");
    expect(fetchImpl.mock.calls.filter((c) => String(c[0]).includes("api.auto.dev"))).toHaveLength(0);
  });

  it("all genuine empty (provider 200, zero rows) → 200 empty_inventory", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (!String(url).includes("api.auto.dev")) return servAllow();
      return Response.json({ data: [] });
    });
    const result = await runFindMatch(
      { need: baseNeed({ preferredModels: [{ make: "Toyota", model: "RAV4" }], preferredMakes: ["Toyota"] }) },
      deps({ kv: new MemoryKv(), fetch: fetchImpl as typeof fetch }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(200);
    expect(result.body.emptyReason).toBe("empty_inventory");
    expect(result.body.headline).toMatch(/No matching listings/i);
  });

  it("mix success(empty)+failure → incomplete_search; not empty-market / loosen-filter advice", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (!String(url).includes("api.auto.dev")) return servAllow();
      n += 1;
      if (n === 1) return Response.json({ data: [] }); // genuine empty
      throw new Error("upstream boom");
    });
    const result = await runFindMatch(
      {
        need: baseNeed({
          preferredModels: [
            { make: "Toyota", model: "RAV4" },
            { make: "Mazda", model: "CX-5" },
          ],
          preferredMakes: ["Toyota", "Mazda"],
        }),
      },
      deps({ kv: new MemoryKv(), fetch: fetchImpl as typeof fetch }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(200);
    expect(result.body.emptyReason).toBe("incomplete_search");
    expect(result.body.partialFailure).toBe(true);
    expect(result.body.headline).toMatch(/Incomplete search/i);
    expect(result.body.headline).not.toMatch(/No matching listings/i);
    expect(result.body.nextStep).toMatch(/Retry/i);
    expect(result.body.nextStep).not.toMatch(/loosen|wider radius|raise the mileage/i);
    const group = result.body.directions[0];
    expect(group?.searchedModels).toEqual([{ make: "Toyota", model: "RAV4" }]);
    expect(group?.failedModels?.some((m) => m.model === "CX-5")).toBe(true);
  });

  it("partial nonempty keeps 200 and does not claim empty_inventory", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (!String(url).includes("api.auto.dev")) return servAllow();
      n += 1;
      if (n === 1) throw new Error("timeout");
      return Response.json({ data: [listingRow(VIN.b, "Mazda", "CX-5")] });
    });
    const result = await runFindMatch(
      {
        need: baseNeed({
          preferredModels: [
            { make: "Toyota", model: "RAV4" },
            { make: "Mazda", model: "CX-5" },
          ],
          preferredMakes: ["Toyota", "Mazda"],
        }),
      },
      deps({ kv: new MemoryKv(), fetch: fetchImpl as typeof fetch }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.emptyReason).toBeNull();
    expect(result.body.partialFailure).toBe(true);
    expect(result.body.directions.some((d) => d.listings.length > 0)).toBe(true);
  });

  it("shared-store block uses shared_store_required copy — not Auto.dev key missing", async () => {
    const result = await runFindMatch(
      { need: baseNeed() },
      deps({
        kv: new MemoryKv(),
        fetch: vi.fn(async () => servAllow()) as typeof fetch,
        env: { VERCEL: "1" },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(503);
    expect(result.body.emptyReason).toBe("shared_store_required");
    expect(result.body.error).toBe("quota_backend_not_distributed");
    expect(String(result.body.nextStep)).toMatch(/Upstash/i);
    expect(String(result.body.nextStep)).not.toMatch(/AUTODEV_API_KEY/i);
    expect(String(result.body.headline)).not.toMatch(/API key/i);
    const copy = findEmptyCopy("shared_store_required");
    expect(statusForFindEmpty(copy.reason)).toBe(503);
    expect(copy.nextStep).not.toMatch(/AUTODEV_API_KEY/i);
  });
});

describe("Stage2A-followon: persistent reserve wired through assembleRadar", () => {
  it("persistent quota key increments BEFORE fetch; cache hit does not re-charge", async () => {
    const kv = new MemoryKv();
    const now = new Date("2026-11-06T12:00:00Z");
    const month = monthKey(now);
    const key = __quotaKeys.totalMonthKey(month);
    let fetchCount = 0;
    const order: string[] = [];

    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (!String(url).includes("api.auto.dev")) return servAllow();
      const before = await kv.get(key);
      order.push(`fetch:count=${before}`);
      fetchCount += 1;
      return Response.json({ data: [listingRow(VIN.a, "Toyota", "RAV4")] });
    });

    const cache = new TtlCache<unknown>();
    const sharedDeps = {
      autodevKey: "k",
      servKey: "s",
      fetch: fetchImpl as typeof fetch,
      autodev: {
        cache,
        counter: new MemoryCounter(),
        reserve: async () => {
          order.push("reserve");
          return reserveTotalCall(kv, now);
        },
      },
      kv,
      env: {},
      now,
    };

    const first = await assembleRadar(
      { make: "Toyota", model: "RAV4", mode: "personal", zip: "72712", distanceMiles: 100 },
      sharedDeps,
    );
    expect(first.ok).toBe(true);
    expect(order[0]).toBe("reserve");
    expect(order[1]).toMatch(/^fetch:count=1$/);
    expect(await kv.get(key)).toBe("1");

    order.length = 0;
    const second = await assembleRadar(
      { make: "Toyota", model: "RAV4", mode: "personal", zip: "72712", distanceMiles: 100 },
      sharedDeps,
    );
    expect(second.ok).toBe(true);
    // Cache hit: no second reserve, no second fetch.
    expect(order).toEqual([]);
    expect(fetchCount).toBe(1);
    expect(await kv.get(key)).toBe("1");
  });

  it("parallel independent /find instances share the persistent cap", async () => {
    const kv = new MemoryKv();
    const now = new Date("2026-11-06T12:00:00Z");
    const month = monthKey(now);
    // Leave room for exactly 2 reserves.
    await kv.set(__quotaKeys.totalMonthKey(month), String(ASSUMPTIONS.autodevMonthlyStop - 2));

    let fetches = 0;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (!String(url).includes("api.auto.dev")) return servAllow();
      fetches += 1;
      return Response.json({ data: [listingRow(VIN.a, "Toyota", "RAV4")] });
    });

    const need = baseNeed({
      preferredModels: [{ make: "Toyota", model: "RAV4" }],
      preferredMakes: ["Toyota"],
    });

    const mk = () =>
      deps({
        kv,
        fetch: fetchImpl as typeof fetch,
        now,
        maxProviderQueries: 1,
        reserve: () => reserveTotalCall(kv, now),
      });

    // Two "instances" share kv — third must hit demo_limit without fetch.
    const [a, b] = await Promise.all([
      runFindMatch({ need }, mk()),
      runFindMatch({ need }, mk()),
    ]);
    expect(a.ok || b.ok).toBe(true);
    expect(fetches).toBe(2);
    expect(await kv.get(__quotaKeys.totalMonthKey(month))).toBe(String(ASSUMPTIONS.autodevMonthlyStop));

    const third = await runFindMatch({ need }, mk());
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.body.emptyReason).toBe("demo_limit");
    }
    expect(fetches).toBe(2); // no additional Autodev HTTP
  });

  it("assembleRadar without reserve still works via MemoryCounter but /find tests require reserve for ledger proof", async () => {
    // Guard: unwired counter alone must NOT be mistaken for persistent proof.
    const kv = new MemoryKv();
    const now = new Date("2026-11-06T12:00:00Z");
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (!String(url).includes("api.auto.dev")) return servAllow();
      return Response.json({ data: [listingRow(VIN.a, "Toyota", "RAV4")] });
    });
    await assembleRadar(
      { make: "Toyota", model: "RAV4", mode: "personal" },
      {
        autodevKey: "k",
        servKey: "s",
        fetch: fetchImpl as typeof fetch,
        autodev: { cache: new TtlCache(), counter: new MemoryCounter() }, // no reserve
        kv,
        now,
      },
    );
    expect(await kv.get(__quotaKeys.totalMonthKey(monthKey(now)))).toBeNull();
  });
});

describe("Stage2A-followon: planned vs checked models", () => {
  it("closed mandate: only named models — no editorial Camry 4th direction", () => {
    const need = {
      ...emptyNeed("personal"),
      useCase: "family" as const,
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
      note: "family SUV",
      make: "Toyota",
    };
    const dirs = proposeDirections(need, undefined, new Date("2026-11-06T00:00:00Z"));
    expect(dirs).toHaveLength(1);
    expect(dirs[0]?.models).toEqual([
      { make: "Toyota", model: "RAV4" },
      { make: "Mazda", model: "CX-5" },
      { make: "Honda", model: "CR-V" },
    ]);
    expect(dirs.flatMap((d) => d.models).some((m) => m.model === "Camry")).toBe(false);
  });

  it("budget_exhausted models are skipped — never in searchedModels / checked", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (!String(url).includes("api.auto.dev")) return servAllow();
      const make = String(url).includes("Mazda") ? "Mazda" : String(url).includes("Honda") ? "Honda" : "Toyota";
      const model = make === "Mazda" ? "CX-5" : make === "Honda" ? "CR-V" : "RAV4";
      const vin = make === "Mazda" ? VIN.b : make === "Honda" ? VIN.c : VIN.a;
      return Response.json({ data: [listingRow(vin, make, model)] });
    });

    const result = await runFindMatch(
      { need: baseNeed() },
      deps({ kv: new MemoryKv(), fetch: fetchImpl as typeof fetch, maxProviderQueries: 2 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const named = result.body.directions.find((d) => d.direction.segment === "Models you named");
    expect(named).toBeTruthy();
    expect(named!.plannedModels).toHaveLength(3);
    expect(named!.searchedModels).toHaveLength(2);
    expect(named!.skippedModels).toHaveLength(1);
    expect(named!.skippedModels[0]?.reason).toBe("budget_exhausted");
    expect(named!.searchedModels.some((m) => m.model === named!.skippedModels[0]?.model)).toBe(false);
    expect(named!.queryOutcomes.filter((o) => o.outcome === "budget_exhausted")).toHaveLength(1);
    // Only 2 Autodev dispatches
    expect(fetchImpl.mock.calls.filter((c) => String(c[0]).includes("api.auto.dev"))).toHaveLength(2);
  });
});
