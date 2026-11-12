import { describe, expect, it } from "vitest";
import { resaleDeliveryChargesCredit } from "./resale-job";

describe("resaleDeliveryChargesCredit", () => {
  it("charges only when a flip VIN is present", () => {
    expect(
      resaleDeliveryChargesCredit({
        best: { vin: "1HGCM82633A004352" } as never,
      }),
    ).toBe(true);
  });

  it("skips charge for nothing-fits / empty pass", () => {
    expect(resaleDeliveryChargesCredit({ best: null })).toBe(false);
    expect(resaleDeliveryChargesCredit({ best: undefined as never })).toBe(false);
    expect(resaleDeliveryChargesCredit({ best: { vin: "   " } as never })).toBe(false);
  });
});
