import { describe, expect, it } from "vitest";
import {
  criteriaParseLabel,
  criteriaParseTechnicalLine,
  criteriaSourceLine,
  criteriaSourceTechnicalLine,
  watchCriteriaSummary,
} from "./radar-criteria-provenance";

describe("criteriaParseLabel", () => {
  // Provenance: recorded id from eval/results/latest.json.
  it("keeps the response id off the main line and records a real one in technical details", () => {
    const parse = { source: "serv" as const, responseId: "chatcmpl-EhAc8SECMAHC0ZDnpgxRUxFlLH7n3" };
    expect(criteriaParseLabel(parse)).toBe("Read from your note.");
    expect(criteriaParseTechnicalLine(parse)).toBe("Review response chatcmpl-EhAc8SECMAHC0ZDnpgxRUxFlLH7n3");
  });

  it("does not invent an id when the review returned none", () => {
    const parse = { source: "serv" as const, responseId: null };
    expect(criteriaParseLabel(parse)).toBe("Read from your note.");
    expect(criteriaParseTechnicalLine(parse)).toBe("Read from your note. No response id was recorded.");
  });

  it("labels built-in rules and the form honestly", () => {
    expect(criteriaParseLabel({ source: "code", responseId: null })).toBe("Read from your note.");
    expect(criteriaParseTechnicalLine({ source: "code", responseId: null })).toBe(
      "Read by built-in rules. No paid review ran.",
    );
    expect(criteriaParseLabel({ source: "form", responseId: null })).toBe("Typed in the form.");
    expect(criteriaParseTechnicalLine({ source: "form", responseId: null })).toBeNull();
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
    ).toBe("From Find, using your note. Read from your note.");
    expect(
      criteriaSourceTechnicalLine({
        parse: { source: "code", responseId: null },
        originSearchId: "ctx_abc",
      }),
    ).toBe("Read by built-in rules. No paid review ran. · Search ctx_abc");
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
