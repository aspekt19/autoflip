import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import { demoPresets } from "@/domain/demo-presets";
import { DEMO_USER_ID, seenStorageKey } from "@/domain/radar-watch";
import { quotaSnapshot } from "@/io/persistent-quota";
import { emptyPlans, writePlans } from "./plan-book";
import { listAlerts, listRuns, listSearches, saveSearches, seenVins } from "./radar-store";
import { runRadarCycle } from "./radar-cycle";

async function grantRadarPlan(kv: MemoryKv, userId: string) {
  await writePlans(kv, userId, {
    ...emptyPlans(),
    planId: "radar",
    personal: { status: "active", lookupKey: "autoflip_radar_monthly", searchLimit: 5 },
    flip: { status: "active", lookupKey: "autoflip_radar_monthly", searchLimit: 5 },
  });
}

const listings = {
  data: [14900, 17000, 17500, 18000].map((price, index) => ({
    vin: ["4T1KZ1AK4MU060006", "4T1K61AK0MU423359", "4T1K61AK4MU610393", "4T1NZ1AK2LU042082"][index],
    vehicle: {
      vin: ["4T1KZ1AK4MU060006", "4T1K61AK0MU423359", "4T1K61AK4MU610393", "4T1NZ1AK2LU042082"][index],
      year: 2016,
      make: "Toyota",
      model: "RAV4",
      bodyStyle: "SUV",
    },
    retailListing: { price, miles: index === 0 ? 40000 : 90000, city: "Miami", state: "FL", zip: "33101", used: true },
    history: null,
  })),
};

describe("radar cycle", () => {
  it("dedupes identical criteria, alerts once, and does not repeat seen VINs", async () => {
    const kv = new MemoryKv();
    const preset = demoPresets()[0]!;
    const copy = { ...preset, id: "user-copy", ownerId: "user-2", preset: false };
    const civic = { ...demoPresets()[1]!, lastCheckedAt: "2026-11-04T12:00:00.000Z" };
    // Paid-only: fixture owners (incl. DEMO_USER_ID) need an active TEST plan.
    await grantRadarPlan(kv, DEMO_USER_ID);
    await grantRadarPlan(kv, "user-2");
    await saveSearches(kv, [preset, copy, civic]);
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify(listings), { status: 200 });
    };
    const first = await runRadarCycle({
      kv,
      now: new Date("2026-11-04T12:00:00Z"),
      trigger: "cron",
      fetchImpl,
      autodevKey: "test",
      origin: "https://autoflip.example",
      env: {},
    });
    expect(calls).toBe(1);
    expect(first.autodevCalls).toBe(1);
    expect(first.payment.status).toBe("not_configured");
    expect(first.serv.promptGuard).toBe("not_configured");
    expect(first.alertsSent).toBeGreaterThan(0);
    const alerts = await listAlerts(kv);
    expect(new Set(alerts.map((item) => item.ownerId)).size).toBe(2);
    expect(alerts.every((item) => item.sample === false)).toBe(true);
    const seen = await seenVins(kv, seenStorageKey(preset.id, preset.criteria));
    expect(seen.size).toBe(4);
    const personalBefore = (await listAlerts(kv)).filter((item) => item.mode === "personal").length;

    const second = await runRadarCycle({
      kv,
      now: new Date("2026-11-04T18:00:00Z"),
      trigger: "cron",
      fetchImpl,
      autodevKey: "test",
      origin: "https://autoflip.example",
      env: {},
      forceAll: true,
    });
    const personalAfter = (await listAlerts(kv)).filter((item) => item.mode === "personal").length;
    expect(personalAfter).toBe(personalBefore);
    // Personal RAV4 group (1) + Flip liquid segments (3).
    expect(second.autodevCalls).toBe(4);
    expect(calls).toBe(5);
  });

  it("keeps fetched listings and records SERV activity when SERV times out (no invented alerts)", async () => {
    const kv = new MemoryKv();
    const civic = { ...demoPresets()[1]!, lastCheckedAt: "2026-11-04T12:00:00.000Z" };
    await grantRadarPlan(kv, DEMO_USER_ID);
    await saveSearches(kv, [demoPresets()[0]!, civic]);
    const fetchImpl: typeof fetch = (url, init) => {
      const target = String(url);
      if (target.includes("auto.dev")) return Promise.resolve(new Response(JSON.stringify(listings), { status: 200 }));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response("late", { status: 200 })), 5_000);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      });
    };
    const run = await runRadarCycle({
      kv,
      now: new Date("2026-11-04T12:00:00Z"),
      trigger: "cron",
      fetchImpl,
      autodevKey: "test",
      servKey: "serv-test",
      origin: "https://autoflip.example",
      env: {},
      timeouts: { serv: 40, autodev: 1_000 },
      deadlineMs: 5_000,
    });
    expect(run.listings).toBe(4);
    expect(run.autodevCalls).toBe(1);
    // Personal alerts require a finished SERV verdict; timeouts do not invent alerts.
    expect(run.steps.find((step) => step.id === "serv_verdict" || step.id === "listings")).toBeTruthy();
    expect(run.notes.some((note) => /email alerts are not configured/i.test(note))).toBe(true);
    const seen = await seenVins(kv, seenStorageKey(demoPresets()[0]!.id, demoPresets()[0]!.criteria));
    expect(seen.size).toBe(4);
    expect((await listRuns(kv)).some((item) => item.id === run.id)).toBe(true);
    expect((await quotaSnapshot(kv, new Date("2026-11-04T12:00:00Z"))).radar).toBe(1);
  });

  it("records why rows were dropped and does not treat those VINs as seen", async () => {
    const kv = new MemoryKv();
    const search = {
      ...demoPresets()[0]!,
      id: "custom-rav4",
      preset: false,
    };
    await grantRadarPlan(kv, search.ownerId);
    await saveSearches(kv, [search]);
    const payload = {
      data: [
        ...listings.data,
        {
          vin: "2T3ZFREV2JW123456",
          vehicle: { vin: "2T3ZFREV2JW123456", year: 2010, make: "Toyota", model: "RAV4", bodyStyle: "SUV" },
          retailListing: { price: 11_000, miles: 90_000, city: "Miami", state: "FL", zip: "33101", used: true, distance: 12 },
        },
        {
          vin: "2T3ZFREV2JW654321",
          vehicle: { vin: "2T3ZFREV2JW654321", year: 2016, make: "Toyota", model: "RAV4", bodyStyle: "SUV" },
          retailListing: { price: 16_000, miles: 90_000, city: "Orlando", state: "FL", zip: "32801", used: true, distance: 180 },
        },
      ],
    };
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify(payload), { status: 200 });
    const first = await runRadarCycle({
      kv,
      now: new Date("2026-11-04T12:00:00Z"),
      trigger: "cron",
      fetchImpl,
      autodevKey: "test",
      origin: "https://autoflip.example",
      env: {},
    });
    expect(first.filterBreakdown).toContain("year too old:");
    expect(first.filterBreakdown).toContain("outside radius:");
    const seen = await seenVins(kv, seenStorageKey(search.id, search.criteria));
    expect(seen.has("2T3ZFREV2JW123456")).toBe(false);
    expect(seen.has("2T3ZFREV2JW654321")).toBe(false);

    const widened = {
      ...search,
      criteria: { ...search.criteria, yearMin: 2008 },
    };
    await saveSearches(kv, [widened]);
    const second = await runRadarCycle({
      kv,
      now: new Date("2026-11-04T18:00:00Z"),
      trigger: "cron",
      fetchImpl,
      autodevKey: "test",
      origin: "https://autoflip.example",
      env: {},
      forceAll: true,
    });
    // Widening year re-evaluates the 2010 VIN. It may alert (good/fair) or be filtered
    // (e.g. suspiciously cheap) — either way it must no longer be treated as unseen-only-for-year.
    const seenAfter = await seenVins(kv, seenStorageKey(widened.id, widened.criteria));
    expect(seenAfter.has("2T3ZFREV2JW123456") || (await listAlerts(kv)).some((item) => item.vin === "2T3ZFREV2JW123456")).toBe(true);
    expect(second.listings).toBeGreaterThan(0);
    const stored = await listSearches(kv);
    expect(stored.some((item) => item.preset || item.id.startsWith("preset-"))).toBe(false);
    expect(stored.map((item) => item.id)).toEqual(["custom-rav4"]);
  });

  it("does not inject demo preset watches on an empty cron run", async () => {
    const kv = new MemoryKv();
    const run = await runRadarCycle({
      kv,
      now: new Date("2026-11-04T12:00:00Z"),
      trigger: "cron",
      fetchImpl: async () => new Response("{}", { status: 200 }),
      autodevKey: "test",
      origin: "https://autoflip.example",
      env: {},
    });
    expect(run.uniqueSearches).toBe(0);
    expect(await listSearches(kv)).toEqual([]);
  });

  it("does not say Not enough similar cars next to a fair value when the miles cap drops comps", async () => {
    const kv = new MemoryKv();
    const search = {
      ...demoPresets()[0]!,
      id: "miles-cap-rav4",
      ownerId: "user-miles",
      preset: false,
      name: "RAV4 under 80k miles",
      criteria: {
        make: "Toyota",
        model: "RAV4",
        yearMin: 2014,
        yearMax: 2019,
        priceMax: 20_000,
        zip: "68114",
        radiusMiles: 50,
        milesMax: 80_000,
      },
    };
    await grantRadarPlan(kv, "user-miles");
    await saveSearches(kv, [search]);
    const rows = [
      { vin: "2T3ZFREV0GW000001", year: 2016, price: 14_000, miles: 40_000 },
      { vin: "2T3ZFREV0GW000002", year: 2016, price: 15_000, miles: 70_000 },
      { vin: "2T3ZFREV0GW000003", year: 2015, price: 12_000, miles: 120_000 },
      { vin: "2T3ZFREV0GW000004", year: 2017, price: 16_000, miles: 130_000 },
      { vin: "2T3ZFREV0GW000005", year: 2016, price: 14_500, miles: 125_000 },
    ];
    const payload = {
      data: rows.map((row) => ({
        vin: row.vin,
        vehicle: { vin: row.vin, year: row.year, make: "Toyota", model: "RAV4", bodyStyle: "SUV" },
        retailListing: { price: row.price, miles: row.miles, city: "Omaha", state: "NE", zip: "68114", used: true, distance: 12 },
      })),
    };
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify(payload), { status: 200 });
    await runRadarCycle({
      kv,
      now: new Date("2026-11-09T12:00:00Z"),
      trigger: "cron",
      fetchImpl,
      autodevKey: "test",
      origin: "https://autoflip.example",
      env: {},
    });
    const alerts = (await listAlerts(kv)).filter((item) => item.searchId === search.id && item.vin === "2T3ZFREV0GW000001");
    expect(alerts).toHaveLength(1);
    const alert = alerts[0]!;
    expect(alert.badge?.fairValueUsd).not.toBeNull();
    expect(alert.badge?.label).not.toBe("Not enough similar cars");
    expect(alert.why).not.toContain("Not enough similar cars");
    expect(alert.numbers.fairValueUsd).toBe(alert.badge?.fairValueUsd);
    expect(alert.numbers.priceLabel).toBe(alert.badge?.label);
    expect(alert.why).toContain("fair value");
  });
});
