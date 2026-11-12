import { describe, expect, it } from "vitest";
import { awdLimitFromText } from "./note-intake";
import { constraintStrength } from "./constraint-strength";
import { broadenStarterDirections, isOpenStarterNote } from "./starter-search";
import type { SearchDirection } from "./directions";
import { resaleEdgeSentence, resalePickHeading } from "./resale-presentation";
import { sellerLinkHonesty } from "./listing-seller-honesty";

const direction = {
  id: "compacts",
  segment: "Compacts",
  why: "Two models",
  guidance: "editorial" as const,
  yearMin: 2012,
  yearMax: 2026,
  yearBecause: "test",
  models: [
    { make: "Toyota", model: "Corolla" },
    { make: "Honda", model: "Civic" },
  ],
  search: { make: "Toyota", model: "Corolla" },
} satisfies SearchDirection;

describe("constraint strength", () => {
  it("treats must, need, and required as hard even when a preference follows", () => {
    expect(awdLimitFromText("must have AWD")).toBe("hard");
    expect(awdLimitFromText("I need AWD")).toBe("hard");
    expect(awdLimitFromText("AWD is required")).toBe("hard");
    expect(awdLimitFromText("must have AWD, preferably under 70k miles")).toBe("hard");
    expect(awdLimitFromText("Preferably AWD")).toBe("soft");
    expect(awdLimitFromText("I need a first car, preferably AWD")).toBe("soft");
    expect(constraintStrength("must have a sunroof", /sunroof/i)).toBe("hard");
    expect(constraintStrength("ideally a sunroof", /sunroof/i)).toBe("soft");
  });
});

describe("starter search", () => {
  it("replaces a two-model first-car plan with compacts, sedans, and small SUVs", () => {
    const note = "first car for a new driver in Chicago, max $12k, up to 120k miles, safe and cheap to run";
    expect(isOpenStarterNote(note)).toBe(true);
    const next = broadenStarterDirections(note, [direction]);
    const models = next.flatMap((row) => row.models).map((row) => row.model);
    expect(models).toEqual(expect.arrayContaining(["Camry", "RAV4", "Forester", "Corolla"]));
    expect(models.length).toBeGreaterThanOrEqual(4);
  });

  it("does not replace a model the shopper named", () => {
    const note = "first car, a Honda Civic, max $12k";
    expect(isOpenStarterNote(note)).toBe(false);
  });
});

describe("resale story and aggregator hosts", () => {
  it("does not recommend a pass, and does not call a $16 gap a deal", () => {
    expect(resalePickHeading("pass", true)).toBe("Closest candidate, not worth it");
    expect(resalePickHeading("buy", true)).toBe("Best flip");
    expect(resaleEdgeSentence({ amountUsd: 16, action: "pass" })).toMatch(/too small to call a deal/i);
    expect(resaleEdgeSentence({ amountUsd: 16, action: "pass" })).not.toMatch(/best flip/i);
  });

  it("does not flag an aggregator host against the dealer name", () => {
    const row = sellerLinkHonesty({
      dealer: "Toyota of Grapevine",
      vdp: "https://details.vast.com/inventory/1",
    });
    expect(row.mismatch).toBe(false);
    expect(row.note).toBeNull();
  });
});
