import { describe, expect, it } from "vitest";
import { findDeliveryChargesCredit } from "./find-delivery";

describe("findDeliveryChargesCredit", () => {
  it("charges only when ok + provider query + ≥1 listing and no emptyReason", () => {
    expect(
      findDeliveryChargesCredit({
        ok: true,
        providerQueriesUsed: 2,
        listingCount: 3,
        emptyReason: null,
      }),
    ).toBe(true);
  });

  it("does not charge on zero cars or no provider query", () => {
    expect(
      findDeliveryChargesCredit({
        ok: true,
        providerQueriesUsed: 2,
        listingCount: 0,
        emptyReason: null,
      }),
    ).toBe(false);
    expect(
      findDeliveryChargesCredit({
        ok: true,
        providerQueriesUsed: 0,
        listingCount: 0,
        emptyReason: "no_directions",
      }),
    ).toBe(false);
    expect(
      findDeliveryChargesCredit({
        ok: true,
        providerQueriesUsed: 1,
        listingCount: 0,
        emptyReason: "empty_inventory",
      }),
    ).toBe(false);
  });
});
