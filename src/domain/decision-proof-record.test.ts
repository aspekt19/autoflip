import { describe, expect, it } from "vitest";
import {
  assertServStepProof,
  buildDecisionProofRecord,
  DECISION_PROOF_SCHEMA,
  digestDecisionInputs,
  isDecisionProofRecord,
  NEED_PARSE_RUBRIC_ID,
  VERDICT_RUBRIC_ID,
} from "./decision-proof-record";

describe("decision proof record", () => {
  it("builds an ok record with digest, rubric, and response id", () => {
    const record = buildDecisionProofRecord({
      purpose: "verdict_decide",
      rubricId: VERDICT_RUBRIC_ID,
      status: "ok",
      responseId: "chatcmpl-Eia7abc",
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
    expect(record.responseId).toBe("chatcmpl-Eia7abc");
    expect(record.inputsDigest).toBe(digestDecisionInputs({ fairValueUsd: 17_000, priceUsd: 14_900 }));
    expect(isDecisionProofRecord(record)).toBe(true);
    expect(assertServStepProof([record], "verdict_decide").verdict).toBe("negotiate");
  });

  it("never keeps a invented verdict on error / no-evidence skips", () => {
    const errored = buildDecisionProofRecord({
      purpose: "verdict_decide",
      rubricId: VERDICT_RUBRIC_ID,
      status: "error",
      responseId: "chatcmpl-Eia7abc",
      inputs: { vin: "x" },
      verdict: "buy",
      detail: "SERV HTTP 503",
    });
    expect(errored.verdict).toBeNull();
    expect(errored.responseId).toBeNull();
    expect(errored.detail).toMatch(/503/);

    const skipped = buildDecisionProofRecord({
      purpose: "need_extract",
      rubricId: NEED_PARSE_RUBRIC_ID,
      status: "skipped_no_evidence",
      inputs: { reason: "empty note" },
      verdict: "pass",
      detail: "No verified free-text need to parse.",
    });
    expect(skipped.verdict).toBeNull();
    expect(() => assertServStepProof([skipped], "need_extract")).not.toThrow();
  });

  it("rejects a tidy ok record that lacks a response id", () => {
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
