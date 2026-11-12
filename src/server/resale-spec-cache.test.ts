import { describe, expect, it } from "vitest";
import { resaleDeliveryReusable } from "./resale-spec-cache";

describe("resale spec cache", () => {
  it("does not replay a stop that never reached a verdict", () => {
    expect(
      resaleDeliveryReusable({
        verdictAction: "pass",
        best: null,
        message: "This search stopped before a verdict. There is not enough information for a verdict.",
      }),
    ).toBe(false);
    expect(
      resaleDeliveryReusable({
        message: "This result did not meet the checks for a published verdict.",
      }),
    ).toBe(false);
  });

  it("replays a pass that names the closest car", () => {
    expect(
      resaleDeliveryReusable({
        verdictAction: "pass",
        best: { vin: "2T1BURHE2GC640812" },
        message: "No flip worth it here. Closest is the 2016 Toyota Corolla.",
      }),
    ).toBe(true);
  });
});
