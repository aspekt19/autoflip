import { describe, expect, it } from "vitest";
import {
  FREE_VEHICLE_CHECKS_PER_MONTH,
  freeCheckQuotaView,
  freeCheckResetLabel,
  nextUtcMonthResetIso,
} from "./free-check-quota";
import { ASSUMPTIONS } from "./assumptions";

describe("free-check-quota domain", () => {
  it("pins the monthly free allotment to existing assumptions (no invented prices)", () => {
    expect(FREE_VEHICLE_CHECKS_PER_MONTH).toBe(ASSUMPTIONS.freeVehicleChecksPerMonth);
    expect(FREE_VEHICLE_CHECKS_PER_MONTH).toBe(3);
  });

  it("exposes a clear UTC reset label for the consumer UI", () => {
    const now = new Date("2026-11-09T15:30:00.000Z");
    expect(nextUtcMonthResetIso(now)).toBe("2026-12-01T00:00:00.000Z");
    expect(freeCheckResetLabel(now)).toMatch(/1 December 2026 \(00:00 UTC\)/);
    const view = freeCheckQuotaView(1, now);
    expect(view.remaining).toBe(2);
    expect(view.resetsLabel).toBe(freeCheckResetLabel(now));
  });
});
