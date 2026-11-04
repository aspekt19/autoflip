import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import { demoPresets } from "@/domain/demo-presets";
import { seenStorageKey } from "@/domain/radar-watch";
import { quotaSnapshot } from "@/io/persistent-quota";
import { listAlerts, listRuns, listSearches, saveSearches, seenVins } from "./radar-store";
import { runRadarCycle } from "./radar-cycle";

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
    expect(second.alertsSent).toBe(0);
    expect(second.autodevCalls).toBe(2);
    expect(calls).toBe(3);
  });

  it("keeps fetched listings and records a partial run when SERV times out", async () => {
    const kv = new MemoryKv();
    const civic = { ...demoPresets()[1]!, lastCheckedAt: "2026-11-04T12:00:00.000Z" };
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
    expect(run.alertsSent).toBeGreaterThan(0);
    expect(run.autodevCalls).toBe(1);
    expect(run.steps.find((step) => step.id === "serv_shadow_agent")?.status).toBe("timeout");
    expect(run.serv.shadow).toContain("timeout");
    const seen = await seenVins(kv, seenStorageKey(demoPresets()[0]!.id, demoPresets()[0]!.criteria));
    expect(seen.size).toBe(4);
    expect((await listAlerts(kv)).length).toBeGreaterThan(0);
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
    const alerts = await listAlerts(kv);
    expect(alerts.some((item) => item.vin === "2T3ZFREV2JW123456")).toBe(true);
    expect(second.alertsSent).toBeGreaterThan(0);
    const stored = await listSearches(kv);
    expect(stored.find((item) => item.id === "preset-personal-rav4")?.criteria.priceMax).toBe(demoPresets()[0]!.criteria.priceMax);
  });
});
