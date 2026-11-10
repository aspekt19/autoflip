import { describe, expect, it } from "vitest";
import type { DecisionProofRecord } from "./decision-proof-view";
import { DECISION_PROOF_SCHEMA, VERDICT_RUBRIC_ID } from "./decision-proof-view";
import { findVerdictLineage } from "./find-verdict-lineage";

function proof(partial: Partial<DecisionProofRecord> & Pick<DecisionProofRecord, "purpose" | "status">): DecisionProofRecord {
  return {
    schemaVersion: DECISION_PROOF_SCHEMA,
    rubricId: VERDICT_RUBRIC_ID,
    servResponseId: "synthetic-test-1",
    model: "gpt-test",
    timestamp: "2026-11-10T12:00:00.000Z",
    inputsDigest: "a".repeat(64),
    verdict: null,
    clampResult: null,
    reason: null,
    searchId: null,
    ownerId: null,
    ...partial,
  };
}

describe("findVerdictLineage", () => {
  it("builds SERV pick → guardrail → final from clampResult only", () => {
    const lineage = findVerdictLineage(
      [
        proof({
          purpose: "verdict_decide",
          status: "ok",
          verdict: "buy",
          clampResult: {
            servChoice: "buy",
            finalAction: "negotiate",
            overridden: true,
            overrideReasons: ["price gate"],
          },
        }),
      ],
      "negotiate",
    );
    expect(lineage?.chain).toBe("SERV pick: buy → guardrail: negotiate → final: negotiate");
    expect(lineage?.servPick).toBe("buy");
    expect(lineage?.decide).toBeNull();
    expect(lineage?.guardrail).toBe("negotiate");
  });

  it("shows find_pick action separately from verdict_decide (buy vs needs_inspection)", () => {
    const lineage = findVerdictLineage(
      [
        proof({
          purpose: "find_pick",
          status: "ok",
          servResponseId: "synthetic-test-find-pick",
          verdict: "buy",
          inputsDigest: "b".repeat(64),
        }),
        proof({
          purpose: "verdict_decide",
          status: "ok",
          servResponseId: "synthetic-test-decide",
          verdict: "needs_inspection",
          clampResult: {
            servChoice: "needs_inspection",
            finalAction: "needs_inspection",
            overridden: false,
            overrideReasons: [],
          },
          inputsDigest: "c".repeat(64),
        }),
      ],
      "needs_inspection",
    );
    expect(lineage?.chain).toBe(
      "SERV pick: buy → decide: needs_inspection → final: needs_inspection",
    );
    expect(lineage?.servPick).toBe("buy");
    expect(lineage?.decide).toBe("needs_inspection");
    expect(lineage?.guardrail).toBeNull();
    expect(lineage?.finalVerdict).toBe("needs_inspection");
  });

  it("keeps find_pick action when decide is overridden by a guardrail", () => {
    const lineage = findVerdictLineage([
      proof({
        purpose: "find_pick",
        status: "ok",
        servResponseId: "synthetic-test-find-pick-2",
        verdict: "buy",
        inputsDigest: "d".repeat(64),
      }),
      proof({
        purpose: "verdict_decide",
        status: "ok",
        servResponseId: "synthetic-test-decide-2",
        verdict: "buy",
        clampResult: {
          servChoice: "buy",
          finalAction: "negotiate",
          overridden: true,
          overrideReasons: ["price gate"],
        },
        inputsDigest: "e".repeat(64),
      }),
    ]);
    expect(lineage?.chain).toBe("SERV pick: buy → decide: buy → guardrail: negotiate → final: negotiate");
    expect(lineage?.servPick).toBe("buy");
    expect(lineage?.decide).toBe("buy");
    expect(lineage?.guardrail).toBe("negotiate");
  });

  it("returns null when there is no ok verdict_decide proof", () => {
    expect(findVerdictLineage([])).toBeNull();
    expect(
      findVerdictLineage([
        proof({
          purpose: "verdict_decide",
          status: "skipped",
          servResponseId: null,
          model: null,
          verdict: null,
          clampResult: null,
          reason: "no evidence",
          inputsDigest: "b".repeat(64),
        }),
      ]),
    ).toBeNull();
  });
});
