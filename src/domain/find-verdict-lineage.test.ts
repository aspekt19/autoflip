import { describe, expect, it } from "vitest";
import { DECISION_PROOF_SCHEMA, VERDICT_RUBRIC_ID } from "./decision-proof-view";
import { findVerdictLineage } from "./find-verdict-lineage";

describe("findVerdictLineage", () => {
  it("builds SERV pick → guardrail → final from clampResult only", () => {
    const lineage = findVerdictLineage(
      [
        {
          schemaVersion: DECISION_PROOF_SCHEMA,
          purpose: "verdict_decide",
          rubricId: VERDICT_RUBRIC_ID,
          status: "ok",
          servResponseId: "synthetic-test-1",
          model: "gpt-test",
          timestamp: "2026-11-10T12:00:00.000Z",
          inputsDigest: "a".repeat(64),
          verdict: "buy",
          clampResult: {
            servChoice: "buy",
            finalAction: "negotiate",
            overridden: true,
            overrideReasons: ["price gate"],
          },
          reason: null,
          searchId: null,
          ownerId: null,
        },
      ],
      "negotiate",
    );
    expect(lineage?.chain).toBe("SERV pick: buy → guardrail: negotiate → final: negotiate");
    expect(lineage?.servPick).toBe("buy");
    expect(lineage?.guardrail).toBe("negotiate");
  });

  it("returns null when there is no ok verdict_decide proof", () => {
    expect(findVerdictLineage([])).toBeNull();
    expect(
      findVerdictLineage([
        {
          schemaVersion: DECISION_PROOF_SCHEMA,
          purpose: "verdict_decide",
          rubricId: VERDICT_RUBRIC_ID,
          status: "skipped",
          servResponseId: null,
          model: null,
          timestamp: "2026-11-10T12:00:00.000Z",
          inputsDigest: "b".repeat(64),
          verdict: null,
          clampResult: null,
          reason: "no evidence",
          searchId: null,
          ownerId: null,
        },
      ]),
    ).toBeNull();
  });
});
