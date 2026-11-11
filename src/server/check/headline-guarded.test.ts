import { describe, expect, it } from "vitest";
import { emptyAgentVerdict } from "@/domain/agent-verdict-schema";
import { headlineFromGuardedDecision } from "./run-check";

/**
 * Prod tip VIN 2HGFC3B33KH356212: price rating said Buy/High while SERV
 * decide+challenge settled on needs_inspection. Headline must follow the
 * final guarded decision.
 */
describe("headlineFromGuardedDecision", () => {
  it("uses needs_inspection from the final agent verdict, not Buy from price rating", () => {
    const agentVerdict = emptyAgentVerdict({
      verdict: "needs_inspection",
      confidence: "medium",
      no_serv_step: false,
      unknowns: ["Accident history is missing, so buy is forbidden until it is verified"],
      second_pass: {
        status: "agreed",
        action: "needs_inspection",
        objection: null,
        evidenceIds: ["check:history"],
        confidenceBefore: "medium",
        confidenceAfter: "medium",
      },
      serv_steps: [
        {
          decided: "Decide → needs_inspection",
          why: "Accident history is missing, so buy is forbidden until it is verified",
          changed: null,
          recordedAt: "2026-11-10T01:58:00.000Z",
        },
        {
          decided: "Challenge agreed",
          why: "agrees:true",
          changed: null,
          recordedAt: "2026-11-10T01:58:20.000Z",
        },
      ],
    });

    const headline = headlineFromGuardedDecision({
      screeningVerdict: "good_deal",
      screeningLabel: "Buy",
      screeningConfidence: "High",
      screeningConfidenceWhy: "Verdict confidence from 8 similar listings plus listing evidence.",
      agentVerdict,
    });

    expect(headline.verdictLabel).toBe("Needs inspection");
    expect(headline.verdictLabel).not.toBe("Buy");
    expect(headline.verdict).toBe("insufficient_data");
    expect(headline.confidence).toBe("Medium");
    expect(headline.confidenceWhy).toMatch(/guarded agent decision/i);
  });

  it("keeps screening headline when SERV did not run", () => {
    const headline = headlineFromGuardedDecision({
      screeningVerdict: "good_deal",
      screeningLabel: "Buy",
      screeningConfidence: "High",
      screeningConfidenceWhy: "comps",
      agentVerdict: emptyAgentVerdict({
        verdict: null,
        confidence: "high",
        no_serv_step: true,
      }),
    });
    expect(headline.verdictLabel).toBe("Buy");
    expect(headline.confidence).toBe("High");
  });

  it("labels why Medium when stop-flag cap lowered High (Check 3b)", () => {
    const agentVerdict = emptyAgentVerdict({
      verdict: "pass",
      confidence: "medium",
      no_serv_step: false,
      second_pass: {
        status: "agreed",
        action: "pass",
        objection: "Lowered from High: stop-level NHTSA park-it or park-outside guidance is open.",
        evidenceIds: [],
        confidenceBefore: "high",
        confidenceAfter: "medium",
      },
      serv_steps: [
        {
          decided: "Confidence capped high → medium",
          why: "Lowered from High: stop-level NHTSA park-it or park-outside guidance is open.",
          changed: "Published confidence high → medium",
          recordedAt: "2026-11-10T20:00:00.000Z",
        },
      ],
    });
    const headline = headlineFromGuardedDecision({
      screeningVerdict: "walk_away",
      screeningLabel: "Pass",
      screeningConfidence: "Medium",
      screeningConfidenceWhy:
        "Verdict confidence from 8 similar listings. Lowered from High: stop-level NHTSA park-it or park-outside guidance is open.",
      agentVerdict,
    });
    expect(headline.confidence).toBe("Medium");
    expect(headline.confidenceWhy).toMatch(/Lowered from High/i);
    expect(headline.confidenceWhy).toMatch(/park-it or park-outside/i);
  });
});
