import { describe, expect, it } from "vitest";
import { accidentHistoryStatement } from "./accident-history-statement";

describe("accidentHistoryStatement", () => {
  it("keeps listing claim and history-report-not-checked in one sentence", () => {
    const zero = accidentHistoryStatement(0);
    expect(zero.line).toMatch(/Listing says no accidents/i);
    expect(zero.line).toMatch(/history report has not been checked/i);
    expect(zero.line).not.toMatch(/accident history is unknown/i);

    const one = accidentHistoryStatement(1);
    expect(one.line).toMatch(/Listing says 1 accident was reported/i);
    expect(one.line).toMatch(/history report has not been checked/i);

    const missing = accidentHistoryStatement(null);
    expect(missing.line).toMatch(/not on this listing/i);
    expect(missing.line).toMatch(/history report has not been checked/i);
    expect(missing.gateReason).toMatch(/missing from the listing/i);
  });
});
