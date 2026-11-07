import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildScoutPlanUserMessage } from "@/server/scout/plan-user-message";
import {
  parseScoutPlanText,
  sanitizePlannerParseEcho,
} from "@/server/scout/plan-parse";
import { profile } from "@/server/serv/profiles";
import { REPEATED_IDENTICAL_ACTION_LIMIT } from "./budgets";
import {
  applyLocalCompareAction,
  loadPlaceholderLedger,
  offlineFixtureGroundedReject,
  prepareCompareStep,
  prepareOfflineReplayAfterLocalApply,
  retainScoutPlanAction,
  RETAINED_ACTION_REASON_MAX_CHARS,
  runOfflineSequentialTwoDecision,
  scoreHistoricalLedgerActions,
  scoreScoutPlanAction,
  OFFLINE_REPLAY_PROVENANCE_NOTE,
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

  it("retainAction keeps citedEvidence on parse-ok reject; refuses over-bound reason; redacts secrets", () => {
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
    const retained = retainScoutPlanAction(parsed.action);
    expect(retained).not.toBeNull();
    expect(retained!.type).toBe("reject");
    expect(retained!.citedEvidence).toEqual([
      { kind: "missing_asking_price", gateId: "price" },
    ]);
    expect(retained!.reason.length).toBeLessThanOrEqual(RETAINED_ACTION_REASON_MAX_CHARS);
    expect(retained!.reason).not.toMatch(/sk-|af_|api[_-]?key/i);

    const withSecret = retainScoutPlanAction({
      ...parsed.action,
      reason: "leak sk-ant-api-key-ABCDEFGHIJKLMNOP and continue",
    });
    expect(withSecret).not.toBeNull();
    expect(withSecret!.reason).toContain("[redacted]");
    expect(withSecret!.reason).not.toMatch(/sk-ant-api-key-ABCDEFGHIJKLMNOP/);
    expect(withSecret!.secretsRedacted).toBe(true);

    const tooLong = retainScoutPlanAction({
      ...parsed.action,
      reason: "x".repeat(RETAINED_ACTION_REASON_MAX_CHARS + 1),
    });
    expect(tooLong).toBeNull();

    const echo = sanitizePlannerParseEcho(text);
    expect(JSON.stringify(echo)).not.toContain("placeholder ask");
    expect(echo.stringLengths.reason).toBeGreaterThan(0);

    const fail = parseScoutPlanText("I can't share that.");
    expect(fail.ok).toBe(false);
    expect(retainScoutPlanAction(null)).toBeNull();
    const failEcho = sanitizePlannerParseEcho("I can't share that.");
    expect(failEcho.looksLikeRefusalProse).toBe(true);
  });

  it("local apply: grounded first reject removes VIN; denied ungrounded keeps VIN; run_tool stops", () => {
    const ledger = loadPlaceholderLedger();
    const first = prepareCompareStep(ledger, ledger.compareSteps[0]!);

    const grounded = applyLocalCompareAction({
      prepared: first,
      action: offlineFixtureGroundedReject(ledger.firstVin),
    });
    expect(grounded.stopReason).toBe("applied");
    expect(grounded.continueToDecision2).toBe(true);
    expect(grounded.dispositionOk).toBe(true);
    expect(grounded.state.pendingVins).not.toContain(ledger.firstVin);
    expect(grounded.state.rejected.some((c) => c.vin === ledger.firstVin)).toBe(true);
    const lastOk = grounded.state.recentOutcomes.at(-1)!;
    expect(lastOk.toolId).toBe("candidate.reject");
    expect(lastOk.ok).toBe(true);

    const replay = prepareOfflineReplayAfterLocalApply({
      ledger,
      decision1: first,
      applyResult: grounded,
    });
    expect(replay.stateKind).toBe("offline_replay_after_local_apply");
    expect(replay.provenanceNote).toContain("NOT a live tool result");
    expect(replay.plannerInput.pendingVins).not.toContain(ledger.firstVin);
    expect(replay.inputDiff.pendingRemoved).toContain(ledger.firstVin);

    const ungrounded = applyLocalCompareAction({
      prepared: first,
      action: {
        type: "reject",
        vin: ledger.firstVin,
        reason: "car is bad because vibes",
        servStepId: "exec:step-1",
        rationaleKind: "adverse_evidence",
        citedEvidence: [{ kind: "bad_title_brand", gateId: "title" }],
      },
    });
    expect(ungrounded.stopReason).toBe("applied_denied");
    expect(ungrounded.continueToDecision2).toBe(true);
    expect(ungrounded.dispositionOk).toBe(false);
    expect(ungrounded.state.pendingVins).toContain(ledger.firstVin);
    expect(ungrounded.state.recentOutcomes.at(-1)!.ok).toBe(false);

    const searchStop = applyLocalCompareAction({
      prepared: first,
      action: {
        type: "run_tool",
        toolId: "inventory.search",
        vin: null,
        reason: "seek usable asks",
        servStepId: "exec:step-1",
        args: { makes: ["Toyota"] },
      },
    });
    expect(searchStop.stopReason).toBe("requires_external_tool");
    expect(searchStop.continueToDecision2).toBe(false);
    expect(searchStop.state.pendingVins).toEqual(first.plannerInput.pendingVins);
    expect(searchStop.state.recentOutcomes).toHaveLength(
      first.plannerInput.recentOutcomes.length,
    );
  });

  it("local apply: third identical denied reject hits production no-progress streak (Fix D)", () => {
    const ledger = loadPlaceholderLedger();
    const afterTwo = prepareCompareStep(ledger, ledger.compareSteps[2]!);
    expect(afterTwo.priorIdenticalStreak).toBe(2);
    expect(REPEATED_IDENTICAL_ACTION_LIMIT).toBe(3);

    const blocked = applyLocalCompareAction({
      prepared: afterTwo,
      action: offlineFixtureGroundedReject(ledger.firstVin, "exec:step-3"),
    });
    expect(blocked.stopReason).toBe("no_progress_streak");
    expect(blocked.continueToDecision2).toBe(false);
    // No invented progress — pending unchanged.
    expect(blocked.state.pendingVins).toContain(ledger.firstVin);
  });

  it("sequential offline harness: reject → Decision-2 offline_replay; abstain skips Decision-2; zero HTTP", () => {
    const ledger = loadPlaceholderLedger();
    const d1 = offlineFixtureGroundedReject(ledger.firstVin);
    const seq = runOfflineSequentialTwoDecision({
      ledger,
      decision1Action: d1,
      decision1SchemaValid: true,
      decision2Action: {
        type: "abstain",
        reason: "no verified options remain after reject",
        servStepId: "exec:step-2",
      },
      decision2SchemaValid: true,
    });
    expect(seq.httpAttemptsTotal).toBe(0);
    expect(seq.maxHttpAttemptsTotal).toBe(2);
    expect(seq.timeoutMsPerAttempt).toBe(45_000);
    expect(seq.outputTokenBound).toBe(4096);
    expect(seq.stoppedBeforeDecision2).toBe(false);
    expect(seq.decisions).toHaveLength(2);
    expect(seq.decisions[0]!.stateKind).toBe("ledger_prepared");
    expect(seq.decisions[0]!.retainedAction?.citedEvidence?.[0]?.kind).toBe(
      "missing_asking_price",
    );
    expect(seq.decisions[1]!.stateKind).toBe("offline_replay_after_local_apply");
    expect(seq.decisions[1]!.provenanceNote).toBe(OFFLINE_REPLAY_PROVENANCE_NOTE);
    expect(seq.apply?.stopReason).toBe("applied");
    expect(seq.offlineReplay?.plannerInput.pendingVins).not.toContain(ledger.firstVin);

    const terminal = runOfflineSequentialTwoDecision({
      ledger,
      decision1Action: {
        type: "abstain",
        reason: "cannot verify",
        servStepId: "exec:step-1",
      },
      decision1SchemaValid: true,
    });
    expect(terminal.stoppedBeforeDecision2).toBe(true);
    expect(terminal.decisions).toHaveLength(1);
    expect(terminal.apply?.stopReason).toBe("terminal_abstain");
    expect(terminal.httpAttemptsTotal).toBe(0);
  });

  it("Decision-1 system/schema/user pins unchanged vs 70844ae; Decision-2 user bytes differ after apply", () => {
    const ledger = loadPlaceholderLedger();
    const first = prepareCompareStep(
      ledger,
      ledger.compareSteps.find((s) => s.id === "after_inventory_before_reject")!,
    );
    const user1 = buildScoutPlanUserMessage(first.plannerInput);
    expect(Buffer.byteLength(user1, "utf8")).toBe(8533);
    expect(createHash("sha256").update(user1).digest("hex")).toBe(
      "998083beee1f575ac076a3b6ea2638789ec5cfaec3f18c7f786f12d026954246",
    );
    const scout = profile("scout_plan");
    expect(createHash("sha256").update(scout.system).digest("hex")).toBe(
      "55ad9c0012154ce003eb64319cf3e147f7a350a95754e9d3e8d7d28090632e61",
    );
    expect(
      createHash("sha256").update(JSON.stringify(scout.jsonSchema?.schema ?? null)).digest("hex"),
    ).toBe("8dbcbc35378520e738935bdabb49af353ae32b9834aa8258436e7e7eb47ccbe6");

    const apply = applyLocalCompareAction({
      prepared: first,
      action: offlineFixtureGroundedReject(ledger.firstVin),
    });
    const replay = prepareOfflineReplayAfterLocalApply({
      ledger,
      decision1: first,
      applyResult: apply,
    });
    const user2 = buildScoutPlanUserMessage(replay.plannerInput);
    expect(user2).not.toBe(user1);
    expect(createHash("sha256").update(user2).digest("hex")).not.toBe(
      "998083beee1f575ac076a3b6ea2638789ec5cfaec3f18c7f786f12d026954246",
    );
    expect(replay.inputDiff.pendingRemoved).toContain(ledger.firstVin);
  });
});
