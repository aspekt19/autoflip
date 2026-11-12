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

  it("charges for documented nothing-fits (agent summary + emptyReason)", () => {
    expect(
      resaleDeliveryChargesCredit({
        best: null,
        emptyReason: "no_flip_candidates",
        agentVerdict: { summary: "Searched twice under budget; nothing profitable remained." } as never,
        reviewNote: "Nothing fit after relaxations.",
        message: "No flip was published.",
      }),
    ).toBe(true);
  });

  it("skips charge for incomplete empty (no agent explanation)", () => {
    expect(resaleDeliveryChargesCredit({ best: null })).toBe(false);
    expect(resaleDeliveryChargesCredit({ best: undefined as never })).toBe(false);
    expect(resaleDeliveryChargesCredit({ best: { vin: "   " } as never })).toBe(false);
    expect(
      resaleDeliveryChargesCredit({
        best: null,
        emptyReason: "no_flip_candidates",
      }),
    ).toBe(false);
  });
});
