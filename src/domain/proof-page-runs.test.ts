import { describe, expect, it } from "vitest";
import {
  isProvenancedArm,
  loadProofPageData,
  type ProofRunArm,
} from "./proof-page-runs";

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

  it("loads the committed Denver comparison with full answers and a fourth Perplexity column", () => {
    const data = loadProofPageData();
    expect(data.examples).toHaveLength(1);
    expect(data.servCompare).not.toBeNull();
    const compare = data.examples[0]!;
    expect(compare).toEqual(data.servCompare);
    expect(compare.title).toContain("Denver");
    expect(compare.query).toContain("Denver 80202");
    expect(compare.seed).toBe(926041385);
    expect(compare.variantOrder).toEqual([
      "plain_llm",
      "features_off",
      "features_on",
      "perplexity",
    ]);
    expect(compare.variants.features_on.runId).toBe("run_bfdb7995ccf7407f97b9");
    expect(compare.variants.features_off.runId).toBe("run_92e6facff18941b28355");
    expect(compare.variants.plain_llm.responseId).toMatch(/^chatcmpl-/);
    expect(compare.variants.perplexity.label).toBe("Perplexity (as captured)");
    expect(compare.variants.perplexity.sourceUrl).toContain("perplexity.ai/search/");

    const plain = compare.answers.plain_llm!;
    expect(plain.verbatim).toContain("I can’t check live inventory here");
    expect(plain.verbatim).toContain("$17,500");

    const off = compare.answers.features_off!;
    expect(off.pick).toContain("2024 Subaru Forester");
    expect(off.recommendation).toContain("$17,000");
    expect(off.whyThisCar).toContain("Zara Auto");
    expect(off.whyThisOffer).toContain("asking prices, not sold prices");
    expect(off.checked.length).toBeGreaterThan(3);
    expect(off.unknown.join(" ")).toContain("no dealer listing URL");
    expect(off.rejected).toContain("does not invent the names");

    const on = compare.answers.features_on!;
    expect(on.pick).toContain("2019 Subaru Forester Sport");
    expect(on.recommendation).toContain("$19,000");
    expect(on.whyThisCar).toContain("South Colorado Motors");
    expect(on.whyThisCar).toContain("1.38 gallons");
    expect(on.rejected).toContain("$600–$799");

    const captured = compare.answers.perplexity!;
    expect(captured.verbatim).toContain("I couldn’t verify a qualifying live listing");
    expect(captured.verbatim).toContain("$20,000 out the door");
    expect(captured.verbatim).toContain("not an appraisal supported by local comparable listings");
    expect(captured.sourceUrl).toContain("perplexity.ai/search/");

    expect(compare.criteria).toHaveLength(9);
    for (const criterion of compare.criteria) {
      for (const key of compare.variantOrder) {
        const cell = criterion.cells[key];
        expect(cell.summary.length).toBeGreaterThan(20);
        expect(cell.links.length).toBeGreaterThan(0);
        for (const link of cell.links) {
          expect(link.href.startsWith("http")).toBe(true);
        }
      }
      expect(criterion.winnerLabel.length).toBeGreaterThan(0);
    }
    const budget = compare.criteria.find((row) => row.id === "all_in_budget");
    expect(budget?.winnerLabel).toContain("Perplexity");
    const honesty = compare.criteria.find((row) => row.id === "risks_honest");
    expect(honesty?.winnerLabel).toContain("Perplexity");
    const listing = compare.criteria.find((row) => row.id === "real_listing");
    expect(listing?.winner).toBe("features_on");
    expect(compare.servFeaturesAdd.differences.length).toBeGreaterThan(0);
    expect(compare.plainLlmFabrication.findings.some((f) => f.verdict === "none_present")).toBe(
      true,
    );
    expect(compare.perplexityCapture).toBeTruthy();
    expect(compare.perplexityCapture!.findings.some((f) => f.verdict === "none_present")).toBe(
      true,
    );
    expect(compare.perplexityCapture!.findings.some((f) => f.verdict === "not_computed")).toBe(
      true,
    );
    expect(compare.perplexityCapture!.findings.some((f) => f.verdict === "cited_unread_here")).toBe(
      true,
    );
  });
  it("loads the live frozen-snapshot SERV A/B result without treating it as a full vehicle verification", () => {
    const data = loadProofPageData();
    const snapshot = data.snapshotComparison;
    expect(snapshot).not.toBeNull();
    expect(snapshot!.metadata.runId).toBe(43488440689);
    expect(snapshot!.metadata.candidateCount).toBe(12);
    expect(snapshot!.snapshot.candidates).toHaveLength(12);
    expect(snapshot!.arms.features_off.pick.vin).toBe("3GNAXUEG8RL339688");
    expect(snapshot!.arms.features_on.pick.vin).toBe("3GNAXSEV4LS557854");
    expect(snapshot!.criteria).toHaveLength(3);
    expect(snapshot!.criteria.every((row) => row.winner === "Tie")).toBe(true);
    expect(snapshot!.snapshot.dataCaveats.join(" ")).toContain("AWD was requested but not verified");
    expect(snapshot!.metadata.providersNotCalled).toContain("NHTSA VIN decode");
    expect(snapshot!.result.conclusion).toContain("not statistically significant");
    expect(snapshot!.result.totalCompletedRuns).toBe(4);
    expect(snapshot!.result.totalListingSearches).toBe(4);
    expect(snapshot!.result.totalServCalls).toBe(8);
    expect(snapshot!.result.completedRunsHarnessEstimateUsd).toBe(0.24);
    expect(snapshot!.additionalRuns).toHaveLength(2);
    expect(snapshot!.result.repeatability).toContain("same 12 VINs");
  });

});
