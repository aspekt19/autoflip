/**
 * PR B — validateFindDecide / validateFindChallenge / publishFindDecideConfidence fixtures.
 * synthetic-test-* only. No live SERV.
 */
import { describe, expect, it } from "vitest";
import {
  applyFindChallengeRevision,
  publishFindDecideConfidence,
  validateFindChallenge,
  validateFindDecide,
  type FindDecide,
} from "./find-decide";

const SHORTLIST = ["a", "b", "c", "d"];
const EVIDENCE = ["ev:price:a", "ev:recall:a", "ev:miles:b", "ev:comp:a"];

function baseDecide(over: Record<string, unknown> = {}) {
  return {
    pickKey: "a",
    action: "negotiate",
    confidence: "high",
    confidenceWhy: "Strong comps and clean history",
    reasons: [{ text: "Ask is under fair value", evidenceIds: ["ev:price:a", "ev:comp:a"] }],
    watchOuts: [{ text: "Confirm open recall repaired", evidenceIds: ["ev:recall:a"] }],
    askSeller: ["Ask for service records."],
    alternatives: [{ key: "b", whyNot: "Higher miles" }],
    offerUsd: 18_500,
    ...over,
  };
}

describe("validateFindDecide", () => {
  it("accepts a shortlist pick and drops invented evidence claims", () => {
    const result = validateFindDecide(
      baseDecide({
        reasons: [
          { text: "Ask is under fair value", evidenceIds: ["ev:price:a"] },
          { text: "Invented claim", evidenceIds: ["made_up"] },
        ],
        alternatives: [
          { key: "b", whyNot: "Higher miles" },
          { key: "ghost", whyNot: "not shortlisted" },
        ],
      }),
      { shortlistKeys: SHORTLIST, allowedEvidenceIds: EVIDENCE, askUsd: 19_000, fairValueUsd: 18_800 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decide.pickKey).toBe("a");
    expect(result.decide.reasons).toHaveLength(1);
    expect(result.decide.alternatives.map((row) => row.key)).toEqual(["b"]);
    expect(result.dropped.some((d) => d.includes("made_up") || d.includes("ghost"))).toBe(true);
  });

  it("rejects pickKey outside the shortlist", () => {
    const result = validateFindDecide(baseDecide({ pickKey: "ghost" }), {
      shortlistKeys: SHORTLIST,
      allowedEvidenceIds: EVIDENCE,
    });
    expect(result.ok).toBe(false);
  });

  it("nulls offerUsd above ask", () => {
    const result = validateFindDecide(baseDecide({ offerUsd: 25_000 }), {
      shortlistKeys: SHORTLIST,
      allowedEvidenceIds: EVIDENCE,
      askUsd: 19_000,
      fairValueUsd: 18_800,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decide.offerUsd).toBeNull();
    expect(result.dropped).toContain("offerUsd>ask");
  });
});

describe("validateFindChallenge", () => {
  it("applies a valid revision when disagreeing", () => {
    const result = validateFindChallenge(
      {
        agree: false,
        issues: [{ kind: "wrong_pick", text: "b has fewer miles", evidenceIds: ["ev:miles:b"] }],
        revised: { pickKey: "b", action: "buy", confidence: "medium" },
      },
      { shortlistKeys: SHORTLIST, allowedEvidenceIds: EVIDENCE },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.challenge.agree).toBe(false);
    expect(result.challenge.revised).toEqual({
      pickKey: "b",
      action: "buy",
      confidence: "medium",
    });
  });

  it("clears revised fields when agree is true", () => {
    const result = validateFindChallenge(
      {
        agree: true,
        issues: [],
        revised: { pickKey: "b", action: "pass", confidence: "low" },
      },
      { shortlistKeys: SHORTLIST, allowedEvidenceIds: EVIDENCE },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.challenge.revised).toEqual({ pickKey: null, action: null, confidence: null });
    expect(result.dropped).toContain("revised_while_agree");
  });

  it("drops issues with invented evidence ids", () => {
    const result = validateFindChallenge(
      {
        agree: false,
        issues: [{ kind: "missed_risk", text: "made up", evidenceIds: ["nope"] }],
        revised: { pickKey: null, action: null, confidence: "low" },
      },
      { shortlistKeys: SHORTLIST, allowedEvidenceIds: EVIDENCE },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.challenge.issues).toEqual([]);
    expect(result.challenge.revised.confidence).toBe("low");
  });
});

describe("publishFindDecideConfidence", () => {
  it("publishes min(C3, C4, guardrail caps)", () => {
    const published = publishFindDecideConfidence({
      c3: "high",
      c4Revised: "medium",
      action: "buy",
      hasStopRecall: false,
      recallsUnavailable: false,
      compCount: 5,
      evidenceSettled: true,
    });
    expect(published.confidence).toBe("medium");
    expect(published.capped).toBe(true);
  });

  it("caps High + stop recall to medium inspect_first", () => {
    const published = publishFindDecideConfidence({
      c3: "high",
      action: "buy",
      hasStopRecall: true,
      compCount: 8,
      evidenceSettled: true,
    });
    expect(published.confidence).toBe("medium");
    expect(published.action).toBe("inspect_first");
  });

  it("caps High when comps < 3 or recalls unavailable", () => {
    expect(
      publishFindDecideConfidence({
        c3: "high",
        action: "negotiate",
        compCount: 2,
        evidenceSettled: true,
      }).confidence,
    ).toBe("medium");
    expect(
      publishFindDecideConfidence({
        c3: "high",
        action: "negotiate",
        recallsUnavailable: true,
        compCount: 5,
        evidenceSettled: true,
      }).confidence,
    ).toBe("medium");
  });

  it("never publishes High next to inspect_first", () => {
    const published = publishFindDecideConfidence({
      c3: "high",
      action: "inspect_first",
      compCount: 6,
      evidenceSettled: true,
    });
    expect(published.confidence).toBe("medium");
  });
});

describe("applyFindChallengeRevision", () => {
  it("merges revised fields onto C3", () => {
    const decide: FindDecide = {
      pickKey: "a",
      action: "negotiate",
      confidence: "high",
      confidenceWhy: "synthetic-test",
      reasons: [],
      watchOuts: [],
      askSeller: [],
      alternatives: [],
      offerUsd: null,
    };
    const merged = applyFindChallengeRevision(decide, {
      agree: false,
      issues: [],
      revised: { pickKey: "b", action: "inspect_first", confidence: "low" },
    });
    expect(merged.pickKey).toBe("b");
    expect(merged.action).toBe("inspect_first");
    expect(merged.confidence).toBe("low");
  });
});
