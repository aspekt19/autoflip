import { describe, expect, it } from "vitest";
import { emptyAgentVerdict } from "./agent-verdict-schema";
import type { DecisionProofRecord } from "./decision-proof-view";
import { DECISION_PROOF_SCHEMA, VERDICT_RUBRIC_ID } from "./decision-proof-view";
import {
  buildServDecisionJournal,
  stepFromDecisionProof,
  summarizeSecondCheck,
} from "./serv-decision-step";

const digest = "a".repeat(64);

function proof(partial: Partial<DecisionProofRecord> & Pick<DecisionProofRecord, "purpose" | "status">): DecisionProofRecord {
  return {
    schemaVersion: DECISION_PROOF_SCHEMA,
    rubricId: VERDICT_RUBRIC_ID,
    servResponseId: partial.status === "ok" ? "chatcmpl-synthetic-test-ok" : null,
    model: partial.status === "ok" ? "synthetic-test-model" : null,
    timestamp: "2026-11-11T00:00:00.000Z",
    inputsDigest: digest,
    verdict: partial.status === "ok" ? "negotiate" : null,
    clampResult: null,
    reason: partial.status === "ok" ? null : "gates withheld",
    ...partial,
  };
}

describe("serv-decision-step", () => {
  it("maps ok proof rows to SERV ran steps with response id", () => {
    const step = stepFromDecisionProof(proof({ purpose: "verdict_decide", status: "ok" }));
    expect(step.by).toBe("SERV");
    expect(step.status).toBe("ran");
    expect(step.runId).toBe("chatcmpl-synthetic-test-ok");
    expect(step.costUsd).toBeNull();
  });

  it("maps skipped proof rows without inventing a run id", () => {
    const step = stepFromDecisionProof(proof({ purpose: "verdict_decide", status: "skipped" }));
    expect(step.status).toBe("skipped");
    expect(step.runId).toBeNull();
    expect(step.output).toMatch(/gates withheld/i);
  });

  it("builds a journal and reports second-check disagreement plainly", () => {
    const journal = buildServDecisionJournal({
      proofRecords: [proof({ purpose: "verdict_decide", status: "ok" })],
      agentVerdict: emptyAgentVerdict({
        no_serv_step: false,
        second_pass: {
          status: "disagreed",
          action: "pass",
          objection: "Risk evidence was under-weighted.",
          evidenceIds: ["ev_1"],
          confidenceBefore: "medium",
          confidenceAfter: "low",
          responseId: "chatcmpl-synthetic-test-challenge",
        },
      }),
    });
    expect(journal.title).toBe("How this decision was made");
    expect(journal.steps).toHaveLength(1);
    expect(journal.secondCheck.answersAgree).toBe(false);
    expect(journal.secondCheck.detail).toMatch(/did not agree/i);
    expect(journal.secondCheck.detail).toMatch(/confidence/i);
  });

  it("says second check did not run when missing", () => {
    const summary = summarizeSecondCheck(null);
    expect(summary.status).toBe("missing");
    expect(summary.detail).toMatch(/did not run/i);
  });
});
