import { describe, expect, it } from "vitest";
import { parseEvalNotes, queriesFromEvalNotes } from "./from-notes";
import { evalShopperReplyFromQuery } from "./drive-chat";

describe("parseEvalNotes / queriesFromEvalNotes", () => {
  it("assigns explicit product and zip; does not force every note to Find", () => {
    const parsed = parseEvalNotes([
      { product: "find", note: "SUV under 20k near Denver 80202", zip: "80202" },
      { product: "resale", note: "Budget 15k in Chicago 60601, no other limits", zip: "60601" },
    ]);
    expect(parsed).toHaveLength(2);
    const qs = queriesFromEvalNotes(parsed!, 2);
    expect(qs.map((q) => q.product)).toEqual(["find", "resale"]);
    expect(qs[0]?.zip).toBe("80202");
    expect(qs[1]?.zip).toBe("60601");
  });

  it("alternates Find/Resale for bare strings", () => {
    const parsed = parseEvalNotes(["find note", "resale note"]);
    expect(parsed?.map((n) => n.product)).toEqual(["find", "resale"]);
  });
});

describe("evalShopperReplyFromQuery for custom budget-only notes", () => {
  it("does not add body/use limits or nationwide when tags are custom", () => {
    const reply = evalShopperReplyFromQuery({
      note: "Budget $15,000 around Chicago (60601). No other limits.",
      zip: "60601",
      tags: {
        product: "resale",
        city: "custom",
        budget: "custom",
        body: "custom",
        need: "custom",
        messy: false,
      },
    });
    expect(reply).toMatch(/no other preferences or limits/i);
    expect(reply).toMatch(/60601/);
    expect(reply).toMatch(/do not search nationwide/i);
    expect(reply).not.toMatch(/nationwide is fine/i);
    expect(reply).not.toMatch(/use: custom/i);
  });
});
