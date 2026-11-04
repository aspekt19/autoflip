import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import { demoPresets } from "@/domain/demo-presets";
import { criteriaKey } from "@/domain/radar-watch";
import { listAlerts, saveSearches, seenVins } from "./radar-store";
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
    await saveSearches(kv, [preset, copy]);
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
    const seen = await seenVins(kv, criteriaKey(preset.criteria));
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
    expect(calls).toBe(2);
  });
});
