import { describe, expect, it } from "vitest";
import { resaleDeliveryChargesCredit } from "./resale-job";

describe("resaleDeliveryChargesCredit", () => {
  it("charges when a flip VIN is present", () => {
    expect(
      resaleDeliveryChargesCredit({
        best: { vin: "1HGCM82633A004352" } as never,
      }),
    ).toBe(true);
  });

  it("skips charge for incomplete empty pass", () => {
    expect(resaleDeliveryChargesCredit({ best: null })).toBe(false);
    expect(resaleDeliveryChargesCredit({ best: undefined as never })).toBe(false);
    expect(resaleDeliveryChargesCredit({ best: { vin: "   " } as never })).toBe(false);
  });

  it("charges documented nothing-fits after agent verdict", () => {
    expect(
      resaleDeliveryChargesCredit({
        best: null,
        nothingFitsDocumented: true,
        agentVerdictReached: true,
      }),
    ).toBe(true);
  });
});
