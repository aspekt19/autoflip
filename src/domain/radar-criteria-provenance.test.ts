import { describe, expect, it } from "vitest";
import { criteriaParseLabel, criteriaSourceLine, watchCriteriaSummary } from "./radar-criteria-provenance";

describe("criteriaParseLabel", () => {
  it("labels SERV with a real response id", () => {
    expect(criteriaParseLabel({ source: "serv", responseId: "chatcmpl-Eia7abc" })).toBe(
      "Parsed by SERV · response chatcmpl-Eia7abc",
    );
  });

  it("does not invent an id when SERV returned none", () => {
    expect(criteriaParseLabel({ source: "serv", responseId: null })).toBe("Parsed by SERV · no response id");
  });

  it("labels code and form honestly", () => {
    expect(criteriaParseLabel({ source: "code", responseId: null })).toBe("Parsed by code");
    expect(criteriaParseLabel({ source: "form", responseId: null })).toBe("Entered on the form");
  });
});

describe("criteriaSourceLine", () => {
  it("shows Find free text origin with parse label", () => {
    expect(
      criteriaSourceLine({
        parse: { source: "code", responseId: null },
        origin: "find",
        originSearchId: "ctx_abc",
        freeText: "sedan for commute",
      }),
    ).toBe("Find (free text) · search ctx_abc · Parsed by code");
  });
});

describe("watchCriteriaSummary", () => {
  it("summarizes a drive-it watch", () => {
    const text = watchCriteriaSummary(
      {
        priceMax: 18_000,
        zip: "94107",
        radiusMiles: 50,
        make: "Honda",
        model: "Civic",
        yearMin: 2018,
        freeText: "reliable commute under 18k",
      },
      "personal",
    );
    expect(text).toContain("94107");
    expect(text).toContain("Honda Civic");
    expect(text).toContain("reliable commute");
  });

  it("labels nationwide flip when radius is 0", () => {
    const text = watchCriteriaSummary({ priceMax: 12_000, zip: "", radiusMiles: 0 }, "flip");
    expect(text).toContain("nationwide");
  });
});
