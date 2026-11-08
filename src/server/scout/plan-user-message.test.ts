import { describe, expect, it } from "vitest";
import { loadPlaceholderLedger, prepareCompareStep } from "@/domain/scout/serv-model-compare";
import { buildScoutPlanUserPayload } from "./plan-user-message";

describe("buildScoutPlanUserPayload ablation", () => {
  it("hides ready-made suggestions when hideSearchSuggestions is set", () => {
    const ledger = loadPlaceholderLedger();
    const prepared = prepareCompareStep(ledger, ledger.compareSteps[0]!);
    expect(
      prepared.plannerInput.evidenceContext.searchContinuation.suggestions.length,
    ).toBeGreaterThan(0);

    const full = buildScoutPlanUserPayload(prepared.plannerInput);
    const cont = (full.evidenceContext as { searchContinuation: { suggestions: unknown[] } })
      .searchContinuation;
    expect(cont.suggestions.length).toBeGreaterThan(0);

    const ablated = buildScoutPlanUserPayload(prepared.plannerInput, {
      hideSearchSuggestions: true,
    });
    const ablatedCont = (
      ablated.evidenceContext as { searchContinuation: { suggestions: unknown[]; honesty: string } }
    ).searchContinuation;
    expect(ablatedCont.suggestions).toEqual([]);
    expect(ablatedCont.honesty).toMatch(/ABLATION/i);
  });
});
