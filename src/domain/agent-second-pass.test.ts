import { describe, expect, it } from "vitest";
import { applyAgentSecondPass, parseAgentSecondPassPayload } from "./agent-second-pass";

const allowed = new Set(["ev_price_gap", "ev_recall_open", "ev_comp_count"]);

describe("agent second pass", () => {
  it("parses agree payloads", () => {
    const parsed = parseAgentSecondPassPayload(
      JSON.stringify({
        agrees: true,
        action: "negotiate",
        objection: null,
        evidenceIds: ["ev_price_gap"],
      }),
    );
    expect(parsed).toEqual({
      agrees: true,
      action: "negotiate",
      objection: null,
      evidenceIds: ["ev_price_gap"],
    });
  });

  it("keeps confidence when the challenger agrees", () => {
    const result = applyAgentSecondPass({
      primaryAction: "negotiate",
      confidence: "high",
      rawText: JSON.stringify({
        agrees: true,
        action: "negotiate",
        objection: null,
        evidenceIds: ["ev_price_gap"],
      }),
      allowedEvidenceIds: allowed,
    });
    expect(result.status).toBe("agreed");
    expect(result.confidenceAfter).toBe("high");
    expect(result.objection).toBeNull();
  });

  it("lowers confidence one level when disagreeing with evidence", () => {
    const result = applyAgentSecondPass({
      primaryAction: "buy",
      confidence: "high",
      rawText: JSON.stringify({
        agrees: false,
        action: "pass",
        objection: "An open park-it recall remains on this model year.",
        evidenceIds: ["ev_recall_open"],
      }),
      allowedEvidenceIds: allowed,
    });
    expect(result.status).toBe("disagreed");
    expect(result.action).toBe("pass");
    expect(result.confidenceBefore).toBe("high");
    expect(result.confidenceAfter).toBe("medium");
    expect(result.objection).toMatch(/park-it recall/i);
    expect(result.evidenceIds).toEqual(["ev_recall_open"]);
  });

  it("ignores disagreement that cites no real evidence ids", () => {
    const result = applyAgentSecondPass({
      primaryAction: "buy",
      confidence: "medium",
      rawText: JSON.stringify({
        agrees: false,
        action: "pass",
        objection: "I feel the title is branded.",
        evidenceIds: ["invented_title_brand"],
      }),
      allowedEvidenceIds: allowed,
    });
    expect(result.status).toBe("ignored_no_evidence");
    expect(result.confidenceAfter).toBe("medium");
    expect(result.objection).toBeNull();
  });

  it("ignores malformed payloads", () => {
    const result = applyAgentSecondPass({
      primaryAction: "negotiate",
      confidence: "low",
      rawText: "{not-json",
      allowedEvidenceIds: allowed,
    });
    expect(result.status).toBe("ignored_malformed");
    expect(result.confidenceAfter).toBe("low");
  });

  it("records a skip when no budget remains", () => {
    const result = applyAgentSecondPass({
      primaryAction: "negotiate",
      confidence: "high",
      rawText: null,
      allowedEvidenceIds: allowed,
      statusIfNoBudget: "skipped_no_budget",
    });
    expect(result.status).toBe("skipped_no_budget");
    expect(result.objection).toMatch(/second check skipped/i);
  });
});
