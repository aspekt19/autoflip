import { describe, expect, it } from "vitest";
import {
  FREE_RADAR,
  PLAN_CATALOG,
  planById,
  radarLimitsForLookup,
  watchIntervalHours,
} from "./plans";

describe("Deal Radar TEST plans", () => {
  it("defines Free plus Plus / Flipper / Dealer with honest due intervals", () => {
    expect(FREE_RADAR.personalLimit).toBe(3);
    expect(FREE_RADAR.flipLimit).toBe(1);
    expect(FREE_RADAR.personalIntervalHours).toBe(24);
    expect(FREE_RADAR.flipIntervalHours).toBe(24);

    const plus = planById("radar_plus");
    expect(plus?.amountCents).toBe(999);
    expect(plus?.personalLimit).toBe(10);
    expect(plus?.flipLimit).toBe(2);
    expect(plus?.personalIntervalHours).toBe(12);
    expect(plus?.flipIntervalHours).toBe(12);
    expect(plus?.servCallCapPerMonth).toBe(400);

    const flipper = planById("flipper");
    expect(flipper?.amountCents).toBe(2900);
    expect(flipper?.flipLimit).toBe(5);
    expect(flipper?.flipIntervalHours).toBe(6);
    expect(flipper?.personalIntervalHours).toBe(24);
    expect(flipper?.servCallCapPerMonth).toBe(1500);
    expect(flipper?.reportCreditsPerMonth).toBe(3);

    const dealer = planById("dealer");
    expect(dealer?.amountCents).toBe(9900);
    expect(dealer?.flipLimit).toBe(20);
    expect(dealer?.flipIntervalHours).toBe(3);
    expect(dealer?.servCallCapPerMonth).toBe(5000);
    expect(dealer?.reportCreditsPerMonth).toBe(10);

    expect(PLAN_CATALOG).toHaveLength(3);
  });

  it("resolves cadence from plan limits (scheduler must tick at least this often)", () => {
    const free = radarLimitsForLookup(null);
    expect(watchIntervalHours("personal", free)).toBe(24);
    expect(watchIntervalHours("flip", free)).toBe(24);

    const dealer = radarLimitsForLookup("autoflip_dealer_monthly");
    expect(watchIntervalHours("flip", dealer)).toBe(3);
    expect(watchIntervalHours("personal", dealer)).toBe(24);

    const plus = radarLimitsForLookup("radar_plus");
    expect(watchIntervalHours("personal", plus)).toBe(12);
  });
});
