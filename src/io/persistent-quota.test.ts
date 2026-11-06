import { describe, expect, it } from "vitest";
import { ASSUMPTIONS } from "@/domain/assumptions";
import { MemoryKv } from "./kv";
import { quotaSnapshot, reserveRadarCall, reserveTotalCall } from "./persistent-quota";
import { monthKey } from "./quota";

describe("persistent quota", () => {
  it("stops radar calls at the radar budget and still counts them toward the monthly cap", async () => {
    const kv = new MemoryKv();
    const now = new Date("2026-11-04T00:00:00Z");
    for (let i = 0; i < ASSUMPTIONS.radarMonthlyBudget; i += 1) {
      const slot = await reserveRadarCall(kv, now);
      expect(slot.ok).toBe(true);
    }
    const blocked = await reserveRadarCall(kv, now);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.limit).toBe(ASSUMPTIONS.radarMonthlyBudget);
    const report = await reserveTotalCall(kv, now);
    expect(report.ok).toBe(true);
    if (report.ok) expect(report.used).toBe(ASSUMPTIONS.radarMonthlyBudget + 1);
  });

  it("stops every listings call at 900", async () => {
    const kv = new MemoryKv();
    const now = new Date("2026-11-04T00:00:00Z");
    for (let i = 0; i < ASSUMPTIONS.autodevMonthlyStop; i += 1) {
      expect((await reserveTotalCall(kv, now)).ok).toBe(true);
    }
    expect((await reserveTotalCall(kv, now)).ok).toBe(false);
    expect((await reserveRadarCall(kv, now)).ok).toBe(false);
  });

  it("parallel reserveTotalCall does not lose updates (regression for GET/SET race)", async () => {
    const kv = new MemoryKv();
    const now = new Date("2026-11-06T12:00:00Z");
    const parallel = 40;
    const results = await Promise.all(Array.from({ length: parallel }, () => reserveTotalCall(kv, now)));
    const oks = results.filter((r) => r.ok);
    expect(oks).toHaveLength(parallel);
    const usedValues = oks.map((r) => (r.ok ? r.used : 0)).sort((a, b) => a - b);
    expect(usedValues).toEqual(Array.from({ length: parallel }, (_, i) => i + 1));
    const snap = await quotaSnapshot(kv, now);
    expect(snap.total).toBe(parallel);
    const raw = await kv.get(`quota:total:count:${monthKey(now)}`);
    expect(Number(raw)).toBe(parallel);
  });

  it("parallel reservations at the hard stop never exceed the monthly cap in the store", async () => {
    const kv = new MemoryKv();
    const now = new Date("2026-11-06T12:00:00Z");
    // Fill to stop-5, then race 20 for the last slots.
    for (let i = 0; i < ASSUMPTIONS.autodevMonthlyStop - 5; i += 1) {
      expect((await reserveTotalCall(kv, now)).ok).toBe(true);
    }
    const raced = await Promise.all(Array.from({ length: 20 }, () => reserveTotalCall(kv, now)));
    const okCount = raced.filter((r) => r.ok).length;
    expect(okCount).toBe(5);
    expect(raced.filter((r) => !r.ok)).toHaveLength(15);
    const snap = await quotaSnapshot(kv, now);
    expect(snap.total).toBe(ASSUMPTIONS.autodevMonthlyStop);
  });
});