import { describe, expect, it } from "vitest";
import { isReportHardRefusal, reportRefusalUserMessage } from "./report-refusal-ui";

describe("report refusal UI", () => {
  it("treats fee/unusable ask 422 as hard refusal (no fake completion)", () => {
    expect(isReportHardRefusal({ status: 422, error: "unusable_purchase_ask" })).toBe(true);
    expect(reportRefusalUserMessage({
      error: "unusable_purchase_ask",
      message: "The listing feed did not provide a usable vehicle purchase ask. No credit was charged.",
    })).toMatch(/No credit was charged/i);
  });

  it("treats find_context_invalid as hard refusal", () => {
    expect(isReportHardRefusal({ status: 400, error: "find_context_invalid" })).toBe(true);
    expect(reportRefusalUserMessage({ error: "find_context_invalid" })).toMatch(/No credit was charged/i);
  });

  it("does not treat a successful report id response as refusal", () => {
    expect(isReportHardRefusal({ status: 200, error: undefined })).toBe(false);
  });
});
