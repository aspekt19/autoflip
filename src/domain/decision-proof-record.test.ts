import { describe, expect, it } from "vitest";
import {
  assertServStepProof,
  buildDecisionProofRecord,
  DECISION_PROOF_SCHEMA,
  digestDecisionInputs,
  formatDecisionRecordLine,
  isDecisionProofRecord,
  NEED_PARSE_RUBRIC_ID,
  VERDICT_RUBRIC_ID,
} from "./decision-proof-record";
import { formatDecisionRecordConsumerLine } from "./decision-proof-view";

describe("decision proof record", () => {
  // Provenance: recorded id from eval/results/latest.json.
  it("builds an ok record with digest, rubric, and SERV response id", () => {
    const record = buildDecisionProofRecord({
      purpose: "verdict_decide",
      rubricId: VERDICT_RUBRIC_ID,
      status: "ok",
      responseId: "chatcmpl-EhAbWoRGDxTDAPz8Lvx93kv1cfycl",
      model: "gpt-5.4-mini",
      inputs: { fairValueUsd: 17_000, priceUsd: 14_900 },
      verdict: "negotiate",
      clamp: {
        servChoice: "negotiate",
        finalAction: "negotiate",
        overridden: false,
        overrideReasons: [],
      },
    });
    expect(record.schemaVersion).toBe(DECISION_PROOF_SCHEMA);
    expect(record.rubricId).toBe(VERDICT_RUBRIC_ID);
    expect(record.servResponseId).toBe("chatcmpl-EhAbWoRGDxTDAPz8Lvx93kv1cfycl");
    expect(record.inputsDigest).toBe(digestDecisionInputs({ fairValueUsd: 17_000, priceUsd: 14_900 }));
    expect(record.clampResult?.finalAction).toBe("negotiate");
    expect(isDecisionProofRecord(record)).toBe(true);
    expect(assertServStepProof([record], "verdict_decide").verdict).toBe("negotiate");
    expect(formatDecisionRecordLine(record)).toMatch(/response chatcmpl-EhAbWoRGDxTDAPz8Lvx93kv1cfycl/);
    expect(formatDecisionRecordConsumerLine(record)).toMatch(/first review/i);
    expect(formatDecisionRecordConsumerLine(record)).not.toMatch(/chatcmpl|gpt-5|need_guard|verdict_decide/);
  });

  it("maps error/skip aliases and never keeps an invented verdict", () => {
    const errored = buildDecisionProofRecord({
      purpose: "verdict_decide",
      rubricId: VERDICT_RUBRIC_ID,
      status: "error",
      responseId: "chatcmpl-EhAbWoRGDxTDAPz8Lvx93kv1cfycl",
      inputs: { vin: "x" },
      verdict: "buy",
      detail: "SERV HTTP 503",
    });
    expect(errored.status).toBe("failed");
    expect(errored.verdict).toBeNull();
    expect(errored.servResponseId).toBeNull();
    expect(errored.reason).toMatch(/503/);
    expect(formatDecisionRecordLine(errored)).toMatch(/failed · SERV HTTP 503/);

    const skipped = buildDecisionProofRecord({
      purpose: "need_extract",
      rubricId: NEED_PARSE_RUBRIC_ID,
      status: "skipped_no_evidence",
      inputs: { reason: "empty note" },
      verdict: "pass",
      detail: "No verified free-text need to parse.",
    });
    expect(skipped.status).toBe("skipped");
    expect(skipped.verdict).toBeNull();
    expect(() => assertServStepProof([skipped], "need_extract")).not.toThrow();
  });

  it("rejects a tidy ok record that lacks a SERV response id", () => {
    const record = buildDecisionProofRecord({
      purpose: "verdict_decide",
      rubricId: VERDICT_RUBRIC_ID,
      status: "ok",
      responseId: null,
      inputs: { a: 1 },
      verdict: "negotiate",
    });
    expect(() => assertServStepProof([record], "verdict_decide")).toThrow(/response id/);
  });
});
