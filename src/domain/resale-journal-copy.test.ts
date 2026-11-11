import { describe, expect, it } from "vitest";
import { buyerSafeResaleJournalText, formatResaleJournalInputId } from "./resale-journal-copy";

describe("resale journal buyer copy", () => {
  it("formats evidence ids without raw prefixes", () => {
    expect(formatResaleJournalInputId("vin:1HGCM82633A004352")).toBe("VIN 1HGCM82633A004352");
    expect(formatResaleJournalInputId("pnl:1HGCM82633A004352")).toBe("P&L for 1HGCM82633A004352");
    expect(formatResaleJournalInputId("check:price_comps")).toBe("price comps");
    expect(formatResaleJournalInputId("direction:sedan_value:Sedan value")).toBe("Search direction Sedan value");
    expect(formatResaleJournalInputId("profitMidUsd")).toBe("mid profit");
    expect(formatResaleJournalInputId("compCount")).toBe("similar listing count");
  });

  it("strips raw tags from decided/why text", () => {
    const cleaned = buyerSafeResaleJournalText(
      "Used vin:ABC and pnl:ABC with profitMidUsd and compCount under flipDesiredProfitUsd",
    );
    expect(cleaned).not.toMatch(/\bvin:/i);
    expect(cleaned).not.toMatch(/\bpnl:/i);
    expect(cleaned).not.toMatch(/profitMidUsd|compCount|flipDesiredProfitUsd/);
    expect(cleaned).toMatch(/VIN ABC/);
    expect(cleaned).toMatch(/mid profit/);
    expect(cleaned).toMatch(/similar listing count/);
    expect(cleaned).toMatch(/target profit/);
  });
});
