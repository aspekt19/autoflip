import { describe, expect, it } from "vitest";
import { findAgentSettleChargesCredit, findDeliveryChargesCredit } from "./find-delivery";

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

describe("findAgentSettleChargesCredit", () => {
  it("charges chosen VIN or documented nothing-fits after agent loop", () => {
    expect(
      findAgentSettleChargesCredit({
        chosenVin: "1HGCM82633A004352",
        nothingFitsDocumented: false,
        agentLoopRan: true,
      }),
    ).toBe(true);
    expect(
      findAgentSettleChargesCredit({
        chosenVin: null,
        nothingFitsDocumented: true,
        agentLoopRan: true,
      }),
    ).toBe(true);
  });

  it("does not charge without agent loop or incomplete nothing-fits", () => {
    expect(
      findAgentSettleChargesCredit({
        chosenVin: "1HGCM82633A004352",
        nothingFitsDocumented: false,
        agentLoopRan: false,
      }),
    ).toBe(false);
    expect(
      findAgentSettleChargesCredit({
        chosenVin: null,
        nothingFitsDocumented: false,
        agentLoopRan: true,
      }),
    ).toBe(false);
  });
});
