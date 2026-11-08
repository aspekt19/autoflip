import { describe, expect, it } from "vitest";
import { buildPlannerEvidenceContext } from "./planner-context";
import { buildScoutPlanUserMessage } from "@/server/scout/plan-user-message";
import { heuristicOfflinePlanner, sanitizeScoutPlanAction } from "./runner";
import {
  fingerprintSearchParams,
  mandateToSearchParams,
  validateScoutSearchParams,
} from "./search-params";
import {
  clampScoutPlanWithSearchContinuation,
  midLoopSearchesUsedFromHistory,
  proposeRevisedSearches,
} from "./search-revision";
import {
  buildPlaceholderCandidates,
  loadPlaceholderLedger,
  prepareCompareStep,
  scoreScoutPlanAction,
} from "./serv-model-compare";
import type { ScoutMandate } from "./types";

describe("search revision while provider budget remains (t317)", () => {
  it("clamp converts premature abstain to revised inventory.search (live+offline slice)", () => {
    const ledger = loadPlaceholderLedger();
    const step = prepareCompareStep(ledger, ledger.compareSteps[0]!);
    const cont = step.plannerInput.evidenceContext.searchContinuation;
    expect(cont.canReviseSearch).toBe(true);

    const clamped = clampScoutPlanWithSearchContinuation({
      action: {
        type: "abstain",
        reason: "Search already used once — cannot continue",
        servStepId: "exec:1",
      },
      searchContinuation: cont,
      allPendingAskingPricesUnusable: true,
      providerCallsRemaining: step.plannerInput.evidenceContext.budgetsRemaining.providerCalls,
      toolCallsRemaining: step.plannerInput.evidenceContext.budgetsRemaining.toolCalls,
    });
    expect(clamped.clamped).toBe(true);
    expect(clamped.clampReason).toBe("premature_abstain_to_revised_search");
    expect(clamped.action.type).toBe("run_tool");
    if (clamped.action.type !== "run_tool") return;
    expect(clamped.action.toolId).toBe("inventory.search");
    expect(clamped.action.servStepId).toBe("exec:1");
    expect(clamped.action.args).toEqual(cont.suggestions[0]!.args);
  });

  it("PR63 shape: providerUsed=1 maxProvider=3 → can revise; abstain-for-search-once is premature", () => {
    const ledger = loadPlaceholderLedger();
    expect(ledger.budgets.maxProviderCalls).toBe(3);
    expect(ledger.usageAtSelectEntry.providerCalls).toBe(1);

    const step = prepareCompareStep(ledger, ledger.compareSteps[0]!);
    const cont = step.plannerInput.evidenceContext.searchContinuation;
    expect(cont.providerCallsRemaining).toBe(2);
    expect(cont.canReviseSearch).toBe(true);
    expect(cont.suggestions.length).toBeGreaterThan(0);
    expect(cont.falseTerminalIfAbstainForPriorSearchOnly).toBe(true);
    expect(cont.honesty).toMatch(/does not exhaust|does not mean cannot continue|prior inventory/i);

    // Suggestions must validate as non-duplicate in-mandate searches.
    for (const s of cont.suggestions) {
      const v = validateScoutSearchParams(s.args, ledger.mandate, {
        priorFingerprints: cont.priorFingerprints,
        midLoopSearchCount: cont.midLoopSearchesUsed,
      });
      expect(v.ok).toBe(true);
      if (v.ok) expect(v.fingerprint).toBe(s.fingerprint);
      expect(cont.priorFingerprints.includes(s.fingerprint)).toBe(false);
    }

    const premature = scoreScoutPlanAction({
      action: {
        type: "abstain",
        reason: "Search already used once — cannot continue",
        servStepId: "t",
      },
      schemaValid: true,
      candidatesByVin: step.candidatesByVin,
      recentOutcomes: step.plannerInput.recentOutcomes,
      priorDeniedRejectFingerprint: "",
      canReviseSearch: cont.canReviseSearch,
    });
    expect(premature.recoveryClass).toBe("premature_abstain_with_budget");
    expect(premature.grounded).toBe(false);

    const revised = scoreScoutPlanAction({
      action: {
        type: "run_tool",
        toolId: "inventory.search",
        vin: null,
        reason: cont.suggestions[0]!.why,
        servStepId: "t",
        args: cont.suggestions[0]!.args,
      },
      schemaValid: true,
      candidatesByVin: step.candidatesByVin,
      recentOutcomes: step.plannerInput.recentOutcomes,
      priorDeniedRejectFingerprint: "",
      canReviseSearch: true,
    });
    expect(revised.recoveryClass).toBe("revised_inventory_search");
    expect(revised.grounded).toBe(true);

    const user = JSON.parse(buildScoutPlanUserMessage(step.plannerInput)) as {
      evidenceContext: { searchContinuation: { canReviseSearch: boolean } };
    };
    expect(user.evidenceContext.searchContinuation.canReviseSearch).toBe(true);
  });

  it("grounded reject of first placeholder VIN then revised search — offline heuristic", async () => {
    const ledger = loadPlaceholderLedger();
    const afterReject = prepareCompareStep(
      ledger,
      ledger.compareSteps.find((s) => s.id === "after_one_denied_reject") ?? ledger.compareSteps[1]!,
    );
    // Force all-unusable + budget-left continuation (ledger steps already do).
    expect(afterReject.plannerInput.evidenceContext.pendingAskSummary.allPendingAskingPricesUnusable).toBe(
      true,
    );
    expect(afterReject.plannerInput.evidenceContext.budgetsRemaining.providerCalls).toBeGreaterThan(0);

    const planner = heuristicOfflinePlanner();
    // Inject a successful reject outcome so heuristic takes post-reject revision path.
    const plan = await planner({
      ...afterReject.plannerInput,
      recentOutcomes: [
        ...afterReject.plannerInput.recentOutcomes,
        {
          toolId: "candidate.reject",
          vin: ledger.firstVin,
          ok: true,
          status: "success",
          capability: "supported_executed",
          capabilityGrounded: true,
          summary: "grounded missing_asking_price@price",
          acquiredVin: null,
          servStepId: "test",
        },
      ],
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.action.type).toBe("run_tool");
    if (plan.action.type !== "run_tool") return;
    expect(plan.action.toolId).toBe("inventory.search");
    expect(plan.action.reason).not.toMatch(/cannot continue|already used once/i);
    const sanitized = sanitizeScoutPlanAction({
      action: plan.action,
      candidates: Object.values(afterReject.candidatesByVin),
    });
    expect(sanitized.type).toBe("run_tool");
  });

  it("proposeRevisedSearches refuses inventing out-of-mandate makes", () => {
    const mandate: ScoutMandate = {
      mode: "personal",
      budgetUsd: 15_000,
      budgetKnown: true,
      targetProfitUsd: null,
      repairAbility: "unknown",
      preferredMakes: ["Honda"],
      openToOtherMakes: false,
      zip: "68114",
      maxDistanceMiles: 50,
      maxMiles: null,
      notes: null,
    };
    const base = mandateToSearchParams(mandate);
    const cont = proposeRevisedSearches({
      mandate,
      searchHistory: [{ fingerprint: fingerprintSearchParams(base), params: base }],
      pendingListings: [
        { make: "Honda", model: "CR-V", },
        { make: "Toyota", model: "RAV4" }, // observed but out of closed mandate — must not become search make
      ],
      midLoopSearchesUsed: midLoopSearchesUsedFromHistory(1),
      providerCallsRemaining: 2,
    });
    expect(cont.canReviseSearch).toBe(true);
    expect(cont.suggestions.every((s) => s.args.makes.every((m) => m.toLowerCase() === "honda"))).toBe(
      true,
    );
    expect(cont.suggestions.some((s) => s.args.models.includes("CR-V"))).toBe(true);
    expect(cont.suggestions.every((s) => !s.args.models.includes("RAV4"))).toBe(true);
  });

  it("provider exhausted → cannot revise; honest abstain ok", () => {
    const mandate: ScoutMandate = {
      mode: "personal",
      budgetUsd: 20_000,
      budgetKnown: true,
      targetProfitUsd: null,
      repairAbility: "unknown",
      preferredMakes: ["Toyota"],
      openToOtherMakes: false,
      zip: null,
      maxDistanceMiles: null,
      maxMiles: null,
      notes: null,
    };
    const base = mandateToSearchParams(mandate);
    const cont = proposeRevisedSearches({
      mandate,
      searchHistory: [{ fingerprint: fingerprintSearchParams(base), params: base }],
      pendingListings: [{ make: "Toyota", model: "Camry" }],
      midLoopSearchesUsed: 0,
      providerCallsRemaining: 0,
    });
    expect(cont.canReviseSearch).toBe(false);
    expect(cont.terminalReason).toBe("provider_budget_exhausted");
    expect(cont.falseTerminalIfAbstainForPriorSearchOnly).toBe(false);

    const pending = [...buildPlaceholderCandidates(loadPlaceholderLedger()).values()].slice(0, 1);
    const ctx = buildPlannerEvidenceContext({
      investigated: [],
      allPending: pending,
      searchHistory: [{ fingerprint: fingerprintSearchParams(base), params: base }],
      mandate,
      budgets: { maxServCalls: null, maxToolCalls: 40, maxProviderCalls: 1 },
      usage: { servCalls: 0, toolCalls: 1, providerCalls: 1 },
      recentOutcomes: [],
    });
    expect(ctx.budgetsRemaining.providerCalls).toBe(0);
    expect(ctx.searchContinuation.canReviseSearch).toBe(false);
    expect(ctx.policy.priorSearchIsNotHardStopWhileProviderBudgetRemains).toBe(true);
  });
});
