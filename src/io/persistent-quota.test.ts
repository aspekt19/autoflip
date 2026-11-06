import { describe, expect, it } from "vitest";
import { ASSUMPTIONS } from "@/domain/assumptions";
import { MemoryKv } from "./kv";
import {
  __quotaKeys,
  quotaSnapshot,
  releaseReservedTotalCall,
  reserveRadarCall,
  reserveTotalCall,
} from "./persistent-quota";
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

  it("parallel reserveTotalCall does not lose updates (in-process only — not Upstash proof)", async () => {
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
    expect(kv.backend).toBe("memory"); // honesty: this is not distributed proof
  });

  it("parallel reservations at the hard stop never exceed the monthly cap in the store", async () => {
    const kv = new MemoryKv();
    const now = new Date("2026-11-06T12:00:00Z");
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

  it("corrupt counter fails closed (no NaN quota admit)", async () => {
    const kv = new MemoryKv();
    const now = new Date("2026-11-06T12:00:00Z");
    await kv.set(__quotaKeys.totalMonthKey(monthKey(now)), "NaN-garbage");
    const decision = await reserveTotalCall(kv, now);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.message).toMatch(/corrupt|failing closed/i);
  });

  it("legacy blob seed uses durable counter that releaseReservedTotalCall can DECR", async () => {
    const kv = new MemoryKv();
    const now = new Date("2026-11-06T12:00:00Z");
    const month = monthKey(now);
    await kv.set(__quotaKeys.TOTAL_BLOB_KEY, JSON.stringify({ [month]: 10 }));
    const reserved = await reserveTotalCall(kv, now);
    expect(reserved.ok).toBe(true);
    if (reserved.ok) expect(reserved.used).toBe(11);
    await releaseReservedTotalCall(kv, now);
    const snap = await quotaSnapshot(kv, now);
    expect(snap.total).toBe(10);
  });
});
