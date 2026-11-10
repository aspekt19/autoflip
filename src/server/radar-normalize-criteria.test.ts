import { describe, expect, it } from "vitest";
import { normalizeCriteria } from "./radar-normalize-criteria";

describe("normalizeCriteria provenance", () => {
  it("defaults criteriaParseSource to form and keeps Find origin", () => {
    const out = normalizeCriteria(
      {
        priceMax: 15_000,
        zip: "43215",
        radiusMiles: 100,
        models: [{ make: "Honda", model: "Civic" }],
        freeText: "sedan for commute",
        criteriaOrigin: "find",
        originSearchId: "tok_1",
      },
      "personal",
      100,
    );
    expect(out.criteriaParseSource).toBe("form");
    expect(out.criteriaOrigin).toBe("find");
    expect(out.originSearchId).toBe("tok_1");
  });
});
