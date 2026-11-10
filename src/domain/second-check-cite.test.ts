import { describe, expect, it } from "vitest";
import { applyAgentSecondPass } from "./agent-second-pass";

describe("second check citation", () => {
  it("carries profile and responseId on agreed results", () => {
    const result = applyAgentSecondPass({
      primaryAction: "negotiate",
      confidence: "medium",
      rawText: JSON.stringify({
        agrees: true,
        action: "negotiate",
        objection: null,
        evidenceIds: ["e1"],
      }),
      allowedEvidenceIds: new Set(["e1"]),
      profile: "resale_challenge",
      responseId: "synthetic-test-second-1",
    });
    expect(result.status).toBe("agreed");
    expect(result.profile).toBe("resale_challenge");
    expect(result.responseId).toBe("synthetic-test-second-1");
  });
});
