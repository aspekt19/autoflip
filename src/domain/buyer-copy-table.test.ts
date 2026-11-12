import { describe, expect, it } from "vitest";
import { allBuyerCopySentences, failureCopy, journalStepCopy, verdictCopy } from "./buyer-copy-table";

const JARGON =
  /\b(find_plan|find_decide|serv_|providerQueriesUsed|inputs digest|NHTSA|vPIC|comps?\b|chatcmpl-|needs_inspection|Pool empty|idempotency|FIND_[A-Z_]+)\b/;

describe("buyer copy table", () => {
  it("names every verdict, failure, and journal step in plain English", () => {
    expect(verdictCopy("buy")).toBe("Buy");
    expect(verdictCopy("negotiate")).toBe("Fair price");
    expect(verdictCopy("pass")).toBe("Skip");
    expect(verdictCopy("needs_inspection")).toBe("Get it inspected first");
    expect(failureCopy("no_cars")).toMatch(/no verdict/i);
    expect(failureCopy("no_cars")).toMatch(/nothing was charged/i);
    expect(journalStepCopy("recalls", "ok").sentence).toBe("We checked the government recall database.");
    expect(journalStepCopy("similar_cars", "ok").sentence).toBe("We compared similar cars for sale nearby.");
    for (const sentence of allBuyerCopySentences()) {
      expect(sentence, sentence).not.toMatch(JARGON);
      expect(sentence).not.toMatch(/[a-z]+_[a-z]+/);
    }
  });
});
