import { describe, expect, it } from "vitest";
import { validateFindDecide } from "./find-decide";
import { parseFindDecideGraphOutput } from "./find-decide-graph-output";

const A = "3N1AB8CVXSY210038";
const reason =
  "This Sentra has 58,185 miles and no reported accidents, though that does not confirm a clean history; compared with the lower-mileage alternative 2025 Nissan Sentra ($14,750, 9,354 mi), its accident and owner counts are known only as “0 reported” and 1 owner, while that alternative still needs a history report before a buy.";

describe("graph reason length (prod check 6)", () => {
  it("stores the full graph reason instead of cutting mid-word at 280 characters", () => {
    expect(reason.length).toBeGreaterThan(280);
    const text = [
      `Pick: ${A}`,
      "Action: negotiate",
      "Confidence: low",
      "Review: kept",
      reason,
    ].join("\n");
    const out = parseFindDecideGraphOutput(text)!;
    const decide = out.decide as { confidenceWhy: string; reasons: Array<{ text: string }> };
    expect(decide.confidenceWhy).toBe(reason);
    expect(decide.reasons[0]?.text).toBe(reason);
    expect(decide.confidenceWhy).not.toMatch(/alternati\.$/);
    const validated = validateFindDecide(decide, {
      shortlistKeys: [A],
      allowedEvidenceIds: [`car:${A}`],
      askUsd: 14_216,
      fairValueUsd: 14_098,
      fairValueLowUsd: null,
      fairValueHighUsd: null,
    });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.decide.confidenceWhy).toBe(reason);
  });
});
