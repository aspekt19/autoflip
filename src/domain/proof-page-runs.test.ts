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
    // comparison-latest.json is fixture mode with hasLiveScores:false — old table stays empty.
    expect(data.hasLiveComparisons).toBe(false);
    expect(data.cases).toEqual([]);
  });

  it("loads the committed 3-variant SERV comparison with links in every cell", () => {
    const data = loadProofPageData();
    expect(data.servCompare).not.toBeNull();
    const compare = data.servCompare!;
    expect(compare.query).toContain("Denver 80202");
    expect(compare.seed).toBe(926041385);
    expect(Object.keys(compare.variants).sort()).toEqual(
      ["features_off", "features_on", "plain_llm"].sort(),
    );
    expect(compare.variants.features_on.runId).toBe("run_bfdb7995ccf7407f97b9");
    expect(compare.variants.features_off.runId).toBe("run_92e6facff18941b28355");
    expect(compare.variants.plain_llm.responseId).toMatch(/^chatcmpl-/);
    expect(compare.criteria).toHaveLength(9);
    for (const criterion of compare.criteria) {
      for (const key of ["plain_llm", "features_off", "features_on"] as const) {
        const cell = criterion.cells[key];
        expect(cell.summary.length).toBeGreaterThan(20);
        expect(cell.links.length).toBeGreaterThan(0);
        for (const link of cell.links) {
          expect(link.href.startsWith("http")).toBe(true);
        }
      }
      expect(criterion.winnerLabel.length).toBeGreaterThan(0);
    }
    expect(compare.servFeaturesAdd.differences.length).toBeGreaterThan(0);
    expect(compare.plainLlmFabrication.findings.some((f) => f.verdict === "none_present")).toBe(
      true,
    );
  });
});
