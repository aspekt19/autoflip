import { describe, expect, it } from "vitest";
import { capConfidenceForHonesty, verdictNeedsInspection } from "./confidence-cap";

describe("capConfidenceForHonesty", () => {
  it("caps High when verdict is Needs inspection", () => {
    const capped = capConfidenceForHonesty({
      confidence: "High",
      verdict: "needs_inspection",
      evidenceSettled: true,
    });
    expect(capped.confidence).toBe("Medium");
    expect(capped.capped).toBe(true);
    expect(capped.reason).toMatch(/Needs inspection/i);
  });

  it("caps high when evidence is not settled / ranking may change", () => {
    const capped = capConfidenceForHonesty({
      confidence: "high",
      evidenceSettled: false,
      rankingMayChange: true,
    });
    expect(capped.confidence).toBe("medium");
    expect(capped.capped).toBe(true);
    expect(capped.reason).toMatch(/ranking may change|still open/i);
  });

  it("leaves Medium alone", () => {
    const capped = capConfidenceForHonesty({
      confidence: "Medium",
      verdict: "needs_inspection",
    });
    expect(capped.confidence).toBe("Medium");
    expect(capped.capped).toBe(false);
  });

  it("detects Needs inspection labels", () => {
    expect(verdictNeedsInspection("Needs inspection")).toBe(true);
    expect(verdictNeedsInspection("insufficient_data")).toBe(true);
    expect(verdictNeedsInspection("buy")).toBe(false);
  });
});
