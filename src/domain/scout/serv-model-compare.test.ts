import { describe, expect, it } from "vitest";
import { buildScoutPlanUserMessage } from "@/server/scout/plan-user-message";
import { parseScoutPlanText } from "@/server/scout/plan-parse";
import {
  loadPlaceholderLedger,
  prepareCompareStep,
  scoreHistoricalLedgerActions,
  scoreScoutPlanAction,
} from "./serv-model-compare";

describe("SERV model compare harness (offline / no paid calls)", () => {
  it("loads sanitized PR63 ledger and prepares SAME-input steps", () => {
    const ledger = loadPlaceholderLedger();
    expect(ledger.runId).toBe("ff52a261-7ac0-4bd1-8433-36532eea2a54");
    expect(ledger.observedPrices).toHaveLength(20);
    expect(ledger.mandate.budgetUsd).toBe(20_000);

    const first = prepareCompareStep(ledger, ledger.compareSteps[0]!);
    expect(first.plannerInput.pendingVins).toHaveLength(20);
    expect(first.plannerInput.evidenceContext.pendingAskSummary.allPendingAskingPricesUnusable).toBe(
      true,
    );
    expect(first.plannerInput.evidenceContext.pendingAskSummary.usableAskingPriceCount).toBe(0);

    const user = buildScoutPlanUserMessage(first.plannerInput);
    const parsed = JSON.parse(user) as { task: string; pendingVins: string[] };
    expect(parsed.task).toBe("lemonless_scout_plan");
    expect(parsed.pendingVins[0]).toBe(ledger.firstVin);

    const afterDenied = prepareCompareStep(ledger, ledger.compareSteps[1]!);
    expect(
      afterDenied.plannerInput.recentOutcomes.filter((o) => o.toolId === "candidate.reject"),
    ).toHaveLength(1);
  });

  it("scores historical labeled reject under current grounding (post-recovery)", () => {
    const ledger = loadPlaceholderLedger();
    const hist = scoreHistoricalLedgerActions(ledger);
    expect(hist.length).toBeGreaterThanOrEqual(2);
    expect(hist[0]!.score.schemaValid).toBe(true);
    expect(hist[0]!.score.recoveryClass).toBe("grounded_reject_unusable_ask");
    expect(hist[0]!.observedOutcomeOk).toBe(false);
  });

  it("scores honest abstain / inventory.search as recovery", () => {
    const ledger = loadPlaceholderLedger();
    const prepared = prepareCompareStep(ledger, ledger.compareSteps[2]!);

    const abstain = scoreScoutPlanAction({
      action: { type: "abstain", reason: "no verified options", servStepId: "a1" },
      schemaValid: true,
      candidatesByVin: prepared.candidatesByVin,
      recentOutcomes: prepared.plannerInput.recentOutcomes,
      priorDeniedRejectFingerprint: prepared.priorDeniedRejectFingerprint,
      priorIdenticalStreak: prepared.priorIdenticalStreak,
    });
    expect(abstain.recoveryClass).toBe("honest_abstain");
    expect(abstain.antiLoopSafe).toBe(true);
    expect(abstain.grounded).toBe(true);

    const search = scoreScoutPlanAction({
      action: {
        type: "run_tool",
        toolId: "inventory.search",
        vin: null,
        reason: "seek usable asks",
        servStepId: "s1",
        args: { makes: ["Toyota"], maxPriceUsd: 20_000 },
      },
      schemaValid: true,
      candidatesByVin: prepared.candidatesByVin,
      recentOutcomes: prepared.plannerInput.recentOutcomes,
      priorDeniedRejectFingerprint: prepared.priorDeniedRejectFingerprint,
      priorIdenticalStreak: prepared.priorIdenticalStreak,
    });
    expect(search.recoveryClass).toBe("inventory_search");
    expect(search.antiLoopSafe).toBe(true);
  });

  it("strict schema parse accepts grounded missing_asking_price@price reject JSON", () => {
    const text = JSON.stringify({
      type: "reject",
      reason: "placeholder ask cannot unlock investigation",
      servStepId: "step-1",
      vin: "4TAWM72N3WZ162673",
      toolId: null,
      args: null,
      rationaleKind: "adverse_evidence",
      citedEvidence: [{ kind: "missing_asking_price", gateId: "price" }],
      assumptionsDisclosed: false,
    });
    const parsed = parseScoutPlanText(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const ledger = loadPlaceholderLedger();
    const prepared = prepareCompareStep(ledger, ledger.compareSteps[0]!);
    const score = scoreScoutPlanAction({
      action: parsed.action,
      schemaValid: true,
      candidatesByVin: prepared.candidatesByVin,
      recentOutcomes: prepared.plannerInput.recentOutcomes,
      priorDeniedRejectFingerprint: prepared.priorDeniedRejectFingerprint,
      priorIdenticalStreak: prepared.priorIdenticalStreak,
    });
    expect(score.grounded).toBe(true);
    expect(score.recoveryClass).toBe("grounded_reject_unusable_ask");
  });

  it("first grounded reject on after_inventory_before_reject is anti-loop safe (no prior duplicate)", () => {
    const ledger = loadPlaceholderLedger();
    const first = prepareCompareStep(ledger, ledger.compareSteps[0]!);
    expect(first.priorIdenticalStreak).toBe(0);
    expect(first.priorDeniedRejectFingerprint).toBe("");
    expect(
      first.plannerInput.recentOutcomes.filter((o) => o.toolId === "candidate.reject"),
    ).toHaveLength(0);

    const score = scoreScoutPlanAction({
      action: {
        type: "reject",
        vin: ledger.firstVin,
        reason: "placeholder ask cannot unlock investigation",
        servStepId: "exec:step-1",
        rationaleKind: "adverse_evidence",
        citedEvidence: [{ kind: "missing_asking_price", gateId: "price" }],
      },
      schemaValid: true,
      candidatesByVin: first.candidatesByVin,
      recentOutcomes: first.plannerInput.recentOutcomes,
      priorDeniedRejectFingerprint: first.priorDeniedRejectFingerprint,
      priorIdenticalStreak: first.priorIdenticalStreak,
    });
    expect(score.grounded).toBe(true);
    expect(score.recoveryClass).toBe("grounded_reject_unusable_ask");
    expect(score.actionFingerprint).toBe(`reject:${ledger.firstVin}:adverse_evidence`);
    // Production no-progress needs 3 identical fingerprints; streak would become 1.
    expect(score.antiLoopSafe).toBe(true);
  });

  it("same reject fingerprint is unsafe only when it would trip the no-progress streak limit", () => {
    const ledger = loadPlaceholderLedger();
    const action = {
      type: "reject" as const,
      vin: ledger.firstVin,
      reason: "placeholder ask cannot unlock investigation",
      servStepId: "exec:step-n",
      rationaleKind: "adverse_evidence" as const,
      citedEvidence: [{ kind: "missing_asking_price" as const, gateId: "price" }],
    };

    const afterOne = prepareCompareStep(ledger, ledger.compareSteps[1]!);
    expect(afterOne.priorIdenticalStreak).toBe(1);
    const scoreAfterOne = scoreScoutPlanAction({
      action,
      schemaValid: true,
      candidatesByVin: afterOne.candidatesByVin,
      recentOutcomes: afterOne.plannerInput.recentOutcomes,
      priorDeniedRejectFingerprint: afterOne.priorDeniedRejectFingerprint,
      priorIdenticalStreak: afterOne.priorIdenticalStreak,
    });
    // Streak would become 2 (< 3) — still allowed; grounded reject removes VIN (progress).
    expect(scoreAfterOne.antiLoopSafe).toBe(true);
    expect(scoreAfterOne.grounded).toBe(true);

    const afterTwo = prepareCompareStep(ledger, ledger.compareSteps[2]!);
    expect(afterTwo.priorIdenticalStreak).toBe(2);
    const scoreAfterTwo = scoreScoutPlanAction({
      action,
      schemaValid: true,
      candidatesByVin: afterTwo.candidatesByVin,
      recentOutcomes: afterTwo.plannerInput.recentOutcomes,
      priorDeniedRejectFingerprint: afterTwo.priorDeniedRejectFingerprint,
      priorIdenticalStreak: afterTwo.priorIdenticalStreak,
    });
    // Streak would become 3 → production no-progress stop before disposition.
    expect(scoreAfterTwo.antiLoopSafe).toBe(false);
    expect(scoreAfterTwo.grounded).toBe(true);
  });
});
