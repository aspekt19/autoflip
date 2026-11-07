/**
 * Full CLI invocation dispatch — regression for 66b151e ≤2 bound breach.
 *
 * Independent ACCEPT missed entrypoint composition: helper/sequential subsection
 * held 2/2 while CLI still ran normal 3 compare rows first (5 HTTP total).
 * These tests exercise the compiled dispatch path used by
 * eval/serv-scout-model-compare.ts with mock HTTP — TOTAL ≤2 across the
 * full invocation when SCOUT_COMPARE_SEQUENTIAL opt-in is set.
 */
import { describe, expect, it } from "vitest";
import {
  loadPlaceholderLedger,
  offlineFixtureGroundedReject,
} from "@/domain/scout/serv-model-compare";
import { profile } from "@/server/serv/profiles";
import {
  executeCompareCliPaidPath,
  resolveCompareCliDispatch,
  resolveCompareSourcePin,
} from "./compare-cli-dispatch";
import { runSequentialCompareProbe } from "./sequential-compare-probe";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function scoutPlanChoice(action: unknown, id: string) {
  return {
    id,
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
    usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
  };
}

describe("compare CLI dispatch XOR (normal OR sequential)", () => {
  it("sequential opt-in + live selects sequential_two_decision only (maxHttp=2)", () => {
    const d = resolveCompareCliDispatch({ live: true, sequentialOptIn: true });
    expect(d.path).toBe("sequential_two_decision");
    expect(d.runNormalCompare).toBe(false);
    expect(d.runSequentialLive).toBe(true);
    expect(d.maxHttpAttemptsTotal).toBe(2);
  });

  it("live without sequential selects normal_compare only", () => {
    const d = resolveCompareCliDispatch({ live: true, sequentialOptIn: false });
    expect(d.path).toBe("normal_compare");
    expect(d.runNormalCompare).toBe(true);
    expect(d.runSequentialLive).toBe(false);
  });

  it("non-live is dry_run even when sequential opt-in set", () => {
    const d = resolveCompareCliDispatch({ live: false, sequentialOptIn: true });
    expect(d.path).toBe("dry_run");
    expect(d.runNormalCompare).toBe(false);
    expect(d.runSequentialLive).toBe(false);
    expect(d.maxHttpAttemptsTotal).toBe(0);
  });

  it("sourcePin reads SCOUT_COMPARE_SOURCE_PIN JSON; absent/invalid → null", () => {
    expect(resolveCompareSourcePin({})).toBeNull();
    expect(resolveCompareSourcePin({ SCOUT_COMPARE_SOURCE_PIN: "" })).toBeNull();
    expect(resolveCompareSourcePin({ SCOUT_COMPARE_SOURCE_PIN: "not-json" })).toBeNull();
    expect(resolveCompareSourcePin({ SCOUT_COMPARE_SOURCE_PIN: "[1]" })).toBeNull();
    const pin = resolveCompareSourcePin({
      SCOUT_COMPARE_SOURCE_PIN: JSON.stringify({
        repo: "aspekt19/autoflip",
        head: "66b151ea812b37de28cad6603274456929146b30",
        tree: "396eb4930fb6c3cb93b449a966d71667948ef79d",
      }),
    });
    expect(pin).toEqual({
      repo: "aspekt19/autoflip",
      head: "66b151ea812b37de28cad6603274456929146b30",
      tree: "396eb4930fb6c3cb93b449a966d71667948ef79d",
    });
  });
});

describe("compare CLI full invocation (live entrypoint composition, mock HTTP)", () => {
  const scoutTimeout = profile("scout_plan").timeoutMs;

  it("FAILED→PASSED: sequential opt-in must not run normal compare; TOTAL HTTP ≤2", async () => {
    const ledger = loadPlaceholderLedger();
    const d1 = offlineFixtureGroundedReject(ledger.firstVin);
    const d2 = {
      type: "abstain",
      reason: "no verified options remain after reject",
      servStepId: "model-step-ignored",
    };
    let httpCalls = 0;
    let normalRunnerInvoked = false;

    // Simulate the pre-fix bug surface: if dispatch wrongly selected both,
    // normal would add 3 HTTP and sequential 2 → 5. XOR must prevent that.
    const dispatch = resolveCompareCliDispatch({ live: true, sequentialOptIn: true });
    expect(dispatch.runNormalCompare).toBe(false);

    const paid = await executeCompareCliPaidPath({
      dispatch,
      runNormalCompare: async () => {
        normalRunnerInvoked = true;
        // Would have been 1 model × 3 steps in the breached launch.
        httpCalls += 3;
        return { httpAttempts: 3 };
      },
      runSequentialLive: async () =>
        runSequentialCompareProbe({
          ledger,
          model: "mock-cli-dispatch",
          apiKey: "test-key",
          baseUrl: "https://serv-mock.test/v1",
          timeoutMsPerAttempt: scoutTimeout,
          outputTokenBound: 4096,
          fetch: async () => {
            httpCalls += 1;
            if (httpCalls === 1) {
              return jsonResponse(scoutPlanChoice(d1, "msg_mock_d1"));
            }
            if (httpCalls === 2) {
              return jsonResponse(scoutPlanChoice(d2, "msg_mock_d2"));
            }
            throw new Error(`unexpected HTTP #${httpCalls} — bound breach`);
          },
        }),
    });

    expect(normalRunnerInvoked).toBe(false);
    expect(httpCalls).toBe(2);
    expect(paid.normalHttpAttempts).toBe(0);
    expect(paid.sequentialHttpAttempts).toBe(2);
    expect(paid.httpAttemptsTotal).toBe(2);
    expect(paid.httpAttemptsTotal).toBeLessThanOrEqual(2);
    expect(paid.sequentialLive?.sequentialOrchestrationExecuted).toBe(true);
    expect(paid.sequentialLive?.decisions).toHaveLength(2);

    // Complete per-attempt telemetry on sequential path (was missing @ 66b151e).
    const [row1, row2] = paid.sequentialLive!.decisions;
    expect(row1!.rawStatus).toBe(200);
    expect(row1!.latencyMs).toBeTypeOf("number");
    expect(row1!.tokens?.total_tokens).toBe(33);
    expect(row1!.upstreamResponseId).toBe("msg_mock_d1");
    expect(row1!.finishReason).toBe("stop");
    expect(row1!.cost).toBe("unknown");
    expect(row1!.responseShape).toBeTruthy();
    expect(row1!.error).toBeNull();

    expect(row2!.rawStatus).toBe(200);
    expect(row2!.latencyMs).toBeTypeOf("number");
    expect(row2!.tokens?.total_tokens).toBe(33);
    expect(row2!.upstreamResponseId).toBe("msg_mock_d2");
    expect(row2!.cost).toBe("unknown");
  });

  it("normal_compare path never invokes sequential live runner", async () => {
    let sequentialInvoked = false;
    let normalHttp = 0;
    const paid = await executeCompareCliPaidPath({
      dispatch: resolveCompareCliDispatch({ live: true, sequentialOptIn: false }),
      runNormalCompare: async () => {
        normalHttp = 3;
        return { httpAttempts: 3 };
      },
      runSequentialLive: async () => {
        sequentialInvoked = true;
        throw new Error("sequential must not run on normal_compare dispatch");
      },
    });
    expect(sequentialInvoked).toBe(false);
    expect(paid.httpAttemptsTotal).toBe(3);
    expect(paid.sequentialLive).toBeNull();
    expect(normalHttp).toBe(3);
  });

  it("dry_run invokes neither paid runner (0 HTTP)", async () => {
    let called = false;
    const paid = await executeCompareCliPaidPath({
      dispatch: resolveCompareCliDispatch({ live: false, sequentialOptIn: true }),
      runNormalCompare: async () => {
        called = true;
        return { httpAttempts: 1 };
      },
      runSequentialLive: async () => {
        called = true;
        throw new Error("no live sequential on dry_run");
      },
    });
    expect(called).toBe(false);
    expect(paid.httpAttemptsTotal).toBe(0);
    expect(paid.sequentialLive).toBeNull();
  });
});
