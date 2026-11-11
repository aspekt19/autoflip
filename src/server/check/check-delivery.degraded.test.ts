import { describe, expect, it } from "vitest";
import {
  CHECK_DELIVERY_LOGIC_VERSION,
  checkDeliveryKey,
  isDegradedCheckDeliveryResult,
} from "./check-delivery";

describe("Check delivery degraded replay guard", () => {
  it("bumps logic version so pre-fix caches miss", () => {
    expect(CHECK_DELIVERY_LOGIC_VERSION).toBeGreaterThanOrEqual(3);
    expect(checkDeliveryKey("u", "2026-11", "VIN")).toContain(`v${CHECK_DELIVERY_LOGIC_VERSION}`);
  });

  it("flags High + Needs inspection as degraded", () => {
    expect(
      isDegradedCheckDeliveryResult({
        verdict: "needs_inspection",
        confidence: "High",
        openParkIt: false,
        openParkOutside: false,
      }),
    ).toBe(true);
  });

  it("flags missing stop-flag fields as degraded", () => {
    expect(isDegradedCheckDeliveryResult({ verdict: "buy", confidence: "Medium" })).toBe(true);
  });

  it("accepts a complete current payload", () => {
    expect(
      isDegradedCheckDeliveryResult({
        verdict: "negotiate",
        confidence: "Medium",
        openParkIt: false,
        openParkOutside: false,
        redFlags: [],
      }),
    ).toBe(false);
  });
});
