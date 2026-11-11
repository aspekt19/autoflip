import { describe, expect, it } from "vitest";
import { isProvenancedArm, loadProofPageData, type ProofRunArm } from "./proof-page-runs";

describe("proof-page-runs", () => {
  it("requires run id, model, and timestamp for a provenanced arm", () => {
    const incomplete: ProofRunArm = {
      arm: "plain_llm",
      status: "ran",
      runId: null,
      model: "synthetic-test-model",
      timestamp: "2026-11-11T00:00:00.000Z",
      rawResponse: null,
      costUsd: null,
      qualityNote: null,
    };
    expect(isProvenancedArm(incomplete)).toBe(false);
    expect(
      isProvenancedArm({
        ...incomplete,
        runId: "chatcmpl-synthetic-test-arm",
      }),
    ).toBe(true);
  });

  it("does not invent live comparison rows from fixture mode", () => {
    const data = loadProofPageData();
    // comparison-latest.json is fixture mode with hasLiveScores:false — table stays empty.
    expect(data.hasLiveComparisons).toBe(false);
    expect(data.cases).toEqual([]);
  });
});
