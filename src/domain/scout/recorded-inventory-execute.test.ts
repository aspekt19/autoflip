import { describe, expect, it } from "vitest";
import { loadPlaceholderLedger, prepareCompareStep, applyLocalCompareAction } from "./serv-model-compare";
import { executeRecordedInventorySearch } from "./recorded-inventory-execute";

describe("executeRecordedInventorySearch", () => {
  it("applies immutable receipt when SERV echoes an allowlisted suggestion", () => {
    const ledger = loadPlaceholderLedger();
    const prepared = prepareCompareStep(ledger, ledger.compareSteps[0]!);
    const suggestion =
      prepared.plannerInput.evidenceContext.searchContinuation.suggestions[0];
    expect(suggestion).toBeTruthy();

    const executed = executeRecordedInventorySearch({
      action: {
        type: "run_tool",
        toolId: "inventory.search",
        vin: null,
        reason: suggestion!.why,
        servStepId: "exec:1",
        args: suggestion!.args,
      },
      mandate: prepared.plannerInput.mandate,
      searchContinuation: prepared.plannerInput.evidenceContext.searchContinuation,
      priorFingerprints: prepared.plannerInput.evidenceContext.searchHistory.map((s) => s.fingerprint),
      midLoopSearchesUsed: 0,
      existingPendingVins: prepared.plannerInput.pendingVins,
    });

    expect(executed.ok).toBe(true);
    if (!executed.ok) return;
    expect(executed.matchedSuggestion).toBe(true);
    expect(executed.outcome.toolId).toBe("inventory.search");
    expect(executed.outcome.ok).toBe(true);
    expect(executed.outcome.searchFingerprint).toBe(suggestion!.fingerprint);
    // No invented cars — default fresh empty (duplicates of pending).
    expect(executed.receipt.freshVins).toEqual([]);
    expect(executed.receipt.provenance).toMatch(/recorded_execute|immutable/i);
  });

  it("local apply with recorded-execute continues to Decision-2 (not requires_external_tool)", () => {
    const ledger = loadPlaceholderLedger();
    const prepared = prepareCompareStep(ledger, ledger.compareSteps[0]!);
    const suggestion =
      prepared.plannerInput.evidenceContext.searchContinuation.suggestions[0]!;

    const applied = applyLocalCompareAction({
      prepared,
      action: {
        type: "run_tool",
        toolId: "inventory.search",
        vin: null,
        reason: suggestion.why,
        servStepId: "exec:1",
        args: suggestion.args,
      },
      tools: { enableRecordedInventoryExecute: true },
    });

    expect(applied.stopReason).toBe("applied");
    expect(applied.continueToDecision2).toBe(true);
    expect(applied.recordedInventory?.matchedSuggestion).toBe(true);
    expect(applied.state.recentOutcomes.at(-1)?.toolId).toBe("inventory.search");
    expect(applied.state.recentOutcomes.at(-1)?.searchFingerprint).toBe(suggestion.fingerprint);
    // Pending unchanged when no fresh VINs — still progressed via tool receipt.
    expect(applied.state.pendingVins).toEqual(prepared.plannerInput.pendingVins);
  });

  it("without recorded-execute opt-in, inventory.search still stops external", () => {
    const ledger = loadPlaceholderLedger();
    const prepared = prepareCompareStep(ledger, ledger.compareSteps[0]!);
    const suggestion =
      prepared.plannerInput.evidenceContext.searchContinuation.suggestions[0]!;
    const stop = applyLocalCompareAction({
      prepared,
      action: {
        type: "run_tool",
        toolId: "inventory.search",
        vin: null,
        reason: suggestion.why,
        servStepId: "exec:1",
        args: suggestion.args,
      },
    });
    expect(stop.stopReason).toBe("requires_external_tool");
    expect(stop.continueToDecision2).toBe(false);
  });
});
