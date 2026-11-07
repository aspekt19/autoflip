/**
 * Live entrypoint sequential probe — mock HTTP through runSequentialCompareProbe
 * (same path CLI uses when SCOUT_COMPARE_SEQUENTIAL=1). Default CI: zero real network.
 */
import { describe, expect, it } from "vitest";
import {
  loadPlaceholderLedger,
  offlineFixtureGroundedReject,
  OFFLINE_REPLAY_PROVENANCE_NOTE,
} from "@/domain/scout/serv-model-compare";
import { profile } from "@/server/serv/profiles";
import { runSequentialCompareProbe } from "./sequential-compare-probe";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function scoutPlanChoice(action: unknown) {
  return {
    id: "chatcmpl-mock-sequential",
    model: "mock-model",
    choices: [
      {
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: JSON.stringify(action),
          refusal: null,
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
}

describe("runSequentialCompareProbe (live entrypoint, mock HTTP)", () => {
  const scoutTimeout = profile("scout_plan").timeoutMs;

  it("D1 grounded reject → local apply → D2 abstain with exactly 2 experiment_single_attempt HTTP", async () => {
    const ledger = loadPlaceholderLedger();
    const d1 = offlineFixtureGroundedReject(ledger.firstVin);
    const d2 = {
      type: "abstain",
      reason: "no verified options remain after reject",
      servStepId: "model-step-ignored",
    };
    let calls = 0;
    const users: string[] = [];

    const result = await runSequentialCompareProbe({
      ledger,
      model: "mock-sequential",
      apiKey: "test-key",
      baseUrl: "https://serv-mock.test/v1",
      timeoutMsPerAttempt: scoutTimeout,
      outputTokenBound: 4096,
      fetch: async (_url, init) => {
        calls += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          messages?: Array<{ role: string; content: string }>;
        };
        const user = body.messages?.find((m) => m.role === "user")?.content ?? "";
        users.push(user);
        if (calls === 1) return jsonResponse(scoutPlanChoice(d1));
        if (calls === 2) return jsonResponse(scoutPlanChoice(d2));
        throw new Error(`unexpected HTTP #${calls}`);
      },
    });

    expect(scoutTimeout).toBe(45_000);
    expect(calls).toBe(2);
    expect(result.httpAttemptsTotal).toBe(2);
    expect(result.maxHttpAttemptsTotal).toBe(2);
    expect(result.timeoutMsPerAttempt).toBe(45_000);
    expect(result.outputTokenBound).toBe(4096);
    expect(result.mode).toBe("live_parent");
    expect(result.sequentialOrchestrationExecuted).toBe(true);
    expect(result.stoppedBeforeDecision2).toBe(false);
    expect(result.decisions).toHaveLength(2);
    expect(result.decisions[0]!.stateKind).toBe("ledger_prepared");
    expect(result.decisions[0]!.schemaValid).toBe(true);
    expect(result.decisions[0]!.retainedAction?.type).toBe("reject");
    expect(result.decisions[0]!.retainedAction?.citedEvidence?.[0]?.kind).toBe(
      "missing_asking_price",
    );
    expect(result.decisions[0]!.httpAttempts).toBe(1);
    expect(result.decisions[0]!.transportPolicy).toBe("experiment_single_attempt");
    expect(result.decisions[0]!.rawStatus).toBe(200);
    expect(result.decisions[0]!.latencyMs).toBeTypeOf("number");
    expect(result.decisions[0]!.tokens?.total_tokens).toBe(30);
    expect(result.decisions[0]!.upstreamResponseId).toBe("chatcmpl-mock-sequential");
    expect(result.decisions[0]!.finishReason).toBe("stop");
    expect(result.decisions[0]!.cost).toBe("unknown");
    expect(result.decisions[0]!.error).toBeNull();
    expect(result.apply?.stopReason).toBe("applied");
    expect(result.apply?.continueToDecision2).toBe(true);
    expect(result.offlineReplay?.stateKind).toBe("offline_replay_after_local_apply");
    expect(result.offlineReplay?.provenanceNote).toBe(OFFLINE_REPLAY_PROVENANCE_NOTE);
    expect(result.offlineReplay?.plannerInput.pendingVins).not.toContain(ledger.firstVin);
    expect(result.decisions[1]!.stateKind).toBe("offline_replay_after_local_apply");
    expect(result.decisions[1]!.schemaValid).toBe(true);
    expect(result.decisions[1]!.retainedAction?.type).toBe("abstain");
    expect(result.decisions[1]!.httpAttempts).toBe(1);
    // Decision-2 user message must differ from Decision-1 (pending VIN removed).
    expect(users).toHaveLength(2);
    expect(users[0]).not.toBe(users[1]);
    expect(users[0]).toContain(ledger.firstVin);
  });

  it("ungrounded D1 records denied and stops before D2 (only 1 HTTP)", async () => {
    const ledger = loadPlaceholderLedger();
    let calls = 0;
    const result = await runSequentialCompareProbe({
      ledger,
      model: "mock-sequential",
      apiKey: "test-key",
      baseUrl: "https://serv-mock.test/v1",
      fetch: async () => {
        calls += 1;
        return jsonResponse(
          scoutPlanChoice({
            type: "reject",
            vin: ledger.firstVin,
            reason: "car is bad because vibes",
            servStepId: "x",
            rationaleKind: "adverse_evidence",
            citedEvidence: [{ kind: "bad_title_brand", gateId: "title" }],
            assumptionsDisclosed: false,
          }),
        );
      },
    });
    expect(calls).toBe(1);
    expect(result.httpAttemptsTotal).toBe(1);
    expect(result.stoppedBeforeDecision2).toBe(true);
    expect(result.decisions).toHaveLength(1);
    expect(result.apply?.stopReason).toBe("applied_denied");
    expect(result.apply?.continueToDecision2).toBe(false);
    expect(result.offlineReplay).toBeNull();
  });

  it("re-reject after successful apply is invalid_transition when applied from retained state", async () => {
    const ledger = loadPlaceholderLedger();
    const d1 = offlineFixtureGroundedReject(ledger.firstVin);
    let calls = 0;
    const first = await runSequentialCompareProbe({
      ledger,
      model: "mock-sequential",
      apiKey: "test-key",
      baseUrl: "https://serv-mock.test/v1",
      fetch: async () => {
        calls += 1;
        // Only D1 succeeds; D2 abstain so probe completes.
        if (calls === 1) return jsonResponse(scoutPlanChoice(d1));
        return jsonResponse(
          scoutPlanChoice({
            type: "abstain",
            reason: "done",
            servStepId: "s2",
          }),
        );
      },
    });
    expect(first.apply?.stopReason).toBe("applied");
    expect(first.apply?.state.rejected.filter((c) => c.vin === ledger.firstVin)).toHaveLength(1);

    // Direct local reapply on post-apply state (transition comparability).
    const { applyLocalCompareAction, prepareCompareStep } = await import(
      "@/domain/scout/serv-model-compare"
    );
    const prepared = prepareCompareStep(ledger, ledger.compareSteps[0]!);
    const blocked = applyLocalCompareAction({
      prepared,
      action: d1,
      fromState: first.apply!.state,
    });
    expect(blocked.stopReason).toBe("invalid_transition");
    expect(blocked.dispositionCode).toBe("already_processed");
    expect(blocked.state.rejected.filter((c) => c.vin === ledger.firstVin)).toHaveLength(1);
  });
});
