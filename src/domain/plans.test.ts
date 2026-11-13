import { describe, expect, it } from "vitest";
import {
  NO_RADAR_PLAN,
  PLAN_CATALOG,
  planById,
  radarLimitsForLookup,
  watchIntervalHours,
} from "./plans";

describe("Deal Radar paid plans (no free tier)", () => {
  it("defines Radar $100 = 1 watch and Radar Pro $250 = 3 watches; no report credits", () => {
    const radar = planById("radar");
    expect(radar?.amountCents).toBe(10_000);
    expect(radar?.watchLimit).toBe(1);
    expect(radar?.intervalHours).toBe(24);
    expect(radar?.servCallCapPerMonth).toBe(300);
    expect(radar?.reportCreditsPerMonth).toBe(0);

    const pro = planById("radar_pro");
    expect(pro?.amountCents).toBe(25_000);
    expect(pro?.watchLimit).toBe(3);
    expect(pro?.intervalHours).toBe(24);
    expect(pro?.servCallCapPerMonth).toBe(900);
    expect(pro?.reportCreditsPerMonth).toBe(0);

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
    expect(radar.watchLimit).toBe(1);
    const pro = radarLimitsForLookup("radar_pro");
    expect(watchIntervalHours(pro)).toBe(24);
    expect(pro.watchLimit).toBe(3);
  });
});
