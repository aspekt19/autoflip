import { describe, expect, it } from "vitest";
import {
  NO_RADAR_PLAN,
  PLAN_CATALOG,
  planById,
  radarLimitsForLookup,
  watchIntervalHours,
} from "./plans";

describe("Deal Radar paid plans (no free tier)", () => {
  it("defines Radar $100 and Radar Pro $250 with shared watch caps", () => {
    const radar = planById("radar");
    expect(radar?.amountCents).toBe(10_000);
    expect(radar?.watchLimit).toBe(5);
    expect(radar?.intervalHours).toBe(24);
    expect(radar?.servCallCapPerMonth).toBe(1500);
    expect(radar?.reportCreditsPerMonth).toBe(5);

    const pro = planById("radar_pro");
    expect(pro?.amountCents).toBe(25_000);
    expect(pro?.watchLimit).toBe(20);
    expect(pro?.intervalHours).toBe(24);
    expect(pro?.servCallCapPerMonth).toBe(6000);
    expect(pro?.reportCreditsPerMonth).toBe(15);

    expect(PLAN_CATALOG).toHaveLength(2);
    expect(PLAN_CATALOG.map((p) => p.id)).toEqual(["radar", "radar_pro"]);
  });

  it("resolves no-plan as unpaid with zero watches", () => {
    expect(radarLimitsForLookup(null)).toEqual(NO_RADAR_PLAN);
    expect(watchIntervalHours(NO_RADAR_PLAN)).toBe(Number.POSITIVE_INFINITY);
  });

  it("resolves cadence from plan limits", () => {
    const radar = radarLimitsForLookup("autoflip_radar_monthly");
    expect(watchIntervalHours(radar)).toBe(24);
    const pro = radarLimitsForLookup("radar_pro");
    expect(watchIntervalHours(pro)).toBe(24);
  });
});
