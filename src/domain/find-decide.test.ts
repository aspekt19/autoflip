/**
 * PR B — validateFindDecide / validateFindChallenge / publishFindDecideConfidence fixtures.
 * synthetic-test-* only. No live SERV.
 */
import { describe, expect, it } from "vitest";
import {
  applyFindChallengeRevision,
  publishFindDecideConfidence,
  resolveShortlistPickKey,
  validateFindChallenge,
  validateFindDecide,
  type FindDecide,
} from "./find-decide";
import { extractServJson } from "./serv-json";

const SHORTLIST = ["a", "b", "c", "d"];
const EVIDENCE = ["ev:price:a", "ev:recall:a", "ev:miles:b", "ev:comp:a", "car:a", "car:b"];
const SHORTLIST_META = [
  { key: "a", vin: "1HGCM82633A004352" },
  { key: "b", vin: "2T1BURHE0JC000001" },
  { key: "c", vin: null },
  { key: "d", vin: null },
];

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
  it("accepts a shortlist pick and soft-attaches car evidence for invented claims", () => {
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
    expect(result.decide.reasons).toHaveLength(2);
    expect(result.decide.reasons[1]?.evidenceIds).toEqual(["car:a"]);
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

  it("accepts needs_inspection alias and Medium confidence", () => {
    const result = validateFindDecide(
      baseDecide({ action: "needs_inspection", confidence: "Medium", offerUsd: null }),
      { shortlistKeys: SHORTLIST, allowedEvidenceIds: EVIDENCE },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decide.action).toBe("inspect_first");
    expect(result.decide.confidence).toBe("medium");
  });

  it("coerces string offerUsd", () => {
    const result = validateFindDecide(baseDecide({ offerUsd: "18,500" }), {
      shortlistKeys: SHORTLIST,
      allowedEvidenceIds: EVIDENCE,
      askUsd: 19_000,
      fairValueUsd: 18_800,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decide.offerUsd).toBe(18_500);
  });

  it("resolves pickKey from VIN / car: prefix / index", () => {
    const byVin = validateFindDecide(baseDecide({ pickKey: "1HGCM82633A004352" }), {
      shortlistKeys: SHORTLIST,
      allowedEvidenceIds: EVIDENCE,
      shortlist: SHORTLIST_META,
    });
    expect(byVin.ok).toBe(true);
    if (byVin.ok) expect(byVin.decide.pickKey).toBe("a");

    const byPrefix = validateFindDecide(baseDecide({ pickKey: "car:a" }), {
      shortlistKeys: SHORTLIST,
      allowedEvidenceIds: EVIDENCE,
      shortlist: SHORTLIST_META,
    });
    expect(byPrefix.ok).toBe(true);
    if (byPrefix.ok) expect(byPrefix.decide.pickKey).toBe("a");

    const byIndex = validateFindDecide(baseDecide({ pickKey: "#2" }), {
      shortlistKeys: SHORTLIST,
      allowedEvidenceIds: EVIDENCE,
      shortlist: SHORTLIST_META,
    });
    expect(byIndex.ok).toBe(true);
    if (byIndex.ok) expect(byIndex.decide.pickKey).toBe("b");
  });

  it("soft-attaches car:pickKey when reasons lose all evidence ids", () => {
    const result = validateFindDecide(
      baseDecide({
        reasons: [{ text: "Fits the budget", evidenceIds: ["made_up"] }],
      }),
      { shortlistKeys: SHORTLIST, allowedEvidenceIds: EVIDENCE },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decide.reasons).toHaveLength(1);
    expect(result.decide.reasons[0]?.evidenceIds).toEqual(["car:a"]);
  });

  it("yields a verdict from fenced + prose messy SERV answers", () => {
    const fenced = `\`\`\`json
${JSON.stringify(baseDecide({ action: "Buy", confidence: "Medium", offerUsd: "18500" }))}
\`\`\``;
    const fromFence = validateFindDecide(extractServJson(fenced), {
      shortlistKeys: SHORTLIST,
      allowedEvidenceIds: EVIDENCE,
      askUsd: 19_000,
      fairValueUsd: 18_800,
      shortlist: SHORTLIST_META,
    });
    expect(fromFence.ok).toBe(true);
    if (fromFence.ok) {
      expect(fromFence.decide.action).toBe("buy");
      expect(fromFence.decide.confidence).toBe("medium");
      expect(fromFence.decide.offerUsd).toBe(18_500);
    }

    const prose = `I recommend this car.\n${JSON.stringify(
      baseDecide({ pickKey: "vin:1HGCM82633A004352", action: "needs_inspection", confidence: "MEDIUM", offerUsd: null }),
    )}\nEnd.`;
    const fromProse = validateFindDecide(extractServJson(prose), {
      shortlistKeys: SHORTLIST,
      allowedEvidenceIds: EVIDENCE,
      shortlist: SHORTLIST_META,
    });
    expect(fromProse.ok).toBe(true);
    if (fromProse.ok) {
      expect(fromProse.decide.pickKey).toBe("a");
      expect(fromProse.decide.action).toBe("inspect_first");
    }
  });
});

describe("resolveShortlistPickKey", () => {
  it("matches case-insensitively and by first", () => {
    expect(resolveShortlistPickKey("A", SHORTLIST)).toBe("a");
    expect(resolveShortlistPickKey("first", SHORTLIST, SHORTLIST_META)).toBe("a");
    expect(resolveShortlistPickKey("0", SHORTLIST, SHORTLIST_META)).toBe("a");
  });
});

describe("messy golden decide fixtures", () => {
  it("every messy fixture yields a validated decide", async () => {
    const {
      ALL_MESSY_DECIDE_ANSWERS,
      MESSY_EVIDENCE_IDS,
      MESSY_SHORTLIST_KEYS,
      MESSY_SHORTLIST_META,
    } = await import("../../test/golden/messy-decide-fixtures");
    for (const row of ALL_MESSY_DECIDE_ANSWERS) {
      const payload = extractServJson(row.text);
      const result = validateFindDecide(payload, {
        shortlistKeys: [...MESSY_SHORTLIST_KEYS],
        allowedEvidenceIds: [...MESSY_EVIDENCE_IDS],
        askUsd: 17_000,
        fairValueUsd: 16_800,
        shortlist: [...MESSY_SHORTLIST_META],
      });
      expect(result.ok, row.id).toBe(true);
      if (result.ok) expect(result.decide.pickKey).toBe("synth-a");
    }
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

  it("resolves revised pickKey aliases case-insensitively", () => {
    const result = validateFindChallenge(
      {
        agree: false,
        issues: [{ kind: "Wrong_Pick", text: "b is safer", evidenceIds: ["ev:miles:b"] }],
        revised: { pickKey: "car:b", action: "Needs_Inspection", confidence: "Medium" },
      },
      { shortlistKeys: SHORTLIST, allowedEvidenceIds: EVIDENCE, shortlist: SHORTLIST_META },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.challenge.revised).toEqual({
      pickKey: "b",
      action: "inspect_first",
      confidence: "medium",
    });
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

  it("keeps a missing price comparison at Medium when the second check ran", () => {
    const published = publishFindDecideConfidence({
      c3: "low",
      action: "inspect_first",
      compCount: 6,
      fairValueUsd: null,
      evidenceSettled: true,
      secondCheckMissed: false,
    });
    expect(published.confidence).toBe("medium");
    expect(published.reasons.join(" ")).toMatch(/enough similar cars/i);
  });

  it("stays Low when the second check did not run", () => {
    const published = publishFindDecideConfidence({
      c3: "medium",
      action: "negotiate",
      compCount: 6,
      fairValueUsd: null,
      evidenceSettled: true,
      secondCheckMissed: true,
    });
    expect(published.confidence).toBe("low");
    expect(published.capped).toBe(true);
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
