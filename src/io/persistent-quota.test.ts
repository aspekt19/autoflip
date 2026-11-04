import { describe, expect, it } from "vitest";
import { ASSUMPTIONS } from "@/domain/assumptions";
import { MemoryKv } from "./kv";
import { reserveRadarCall, reserveTotalCall } from "./persistent-quota";

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
});