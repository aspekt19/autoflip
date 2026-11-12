import { describe, expect, it } from "vitest";
import { callStep, classifyServStepFailure, PLAN_STOP_MESSAGE, SECOND_CHECK_MISSED } from "./call-step";
import type { ServResult } from "./run";

function failed(over: Partial<Extract<ServResult, { ok: false }>> = {}): ServResult {
  return {
    ok: false,
    error: "SERV structured refusal field (message_content_null_refusal_field).",
    status: 200,
    proof: { purpose: "find_plan" } as ServResult extends { proof: infer P } ? P : never,
    fallback: "deterministic_fallback",
    httpAttempts: 1,
    transportPolicy: "production",
    responseShape: null,
    failureDiag: { reasonCode: "message_content_null_refusal_field" } as NonNullable<ServResult["failureDiag"]>,
    ...over,
  };
}

function ok(text = "{\"ok\":true}"): ServResult {
  return {
    ok: true,
    text,
    model: "gpt-6.1-sol",
    shadowOutcome: "not_used",
    rawStatus: 200,
    proof: { purpose: "find_plan" } as ServResult extends { proof: infer P } ? P : never,
    httpAttempts: 1,
    transportPolicy: "production",
    failureDiag: null,
    responseShape: null,
  };
}

describe("callStep", () => {
  it("retries a refusal once on the bare model and then stops a critical step", async () => {
    const models: Array<string | undefined> = [];
    const bare: boolean[] = [];
    const outcome = await callStep({
      profileId: "find_plan",
      user: "first car",
      critical: true,
      run: async (_id, _input, deps) => {
        models.push(deps?.model);
        bare.push(Boolean(deps?.bareRetry));
        return failed();
      },
    });
    expect(models).toHaveLength(2);
    expect(bare).toEqual([false, true]);
    expect(models[1]).toBe("gpt-6.1-sol");
    expect(outcome.status).toBe("stopped");
    expect(outcome.message).toBe(PLAN_STOP_MESSAGE);
    expect(outcome.reasonCode).toBe("message_content_null_refusal_field");
  });

  it("retries a timeout once on the same profile", async () => {
    let calls = 0;
    const outcome = await callStep({
      profileId: "find_plan",
      user: "note",
      critical: true,
      remainingMs: 120_000,
      run: async () => {
        calls += 1;
        if (calls === 1) {
          return failed({
            error: "timed out",
            status: 0,
            transportErrorClass: "timeout",
            failureDiag: { reasonCode: "timeout" } as NonNullable<ServResult["failureDiag"]>,
          });
        }
        return ok();
      },
    });
    expect(calls).toBe(2);
    expect(outcome.status).toBe("ok");
  });

  it("labels a failed challenge and caps confidence at low", async () => {
    const outcome = await callStep({
      profileId: "find_challenge",
      user: "challenge",
      critical: false,
      run: async () =>
        failed({
          error: "timed out",
          status: 0,
          transportErrorClass: "timeout",
          failureDiag: { reasonCode: "timeout" } as NonNullable<ServResult["failureDiag"]>,
        }),
    });
    expect(outcome.status).toBe("degraded");
    expect(outcome.confidence).toBe("low");
    expect(outcome.message).toBe(SECOND_CHECK_MISSED);
    expect(outcome.retried).toBe(true);
  });

  it("does not retry a timeout when the remaining budget cannot cover another full wait", async () => {
    let calls = 0;
    await callStep({
      profileId: "find_plan",
      user: "note",
      critical: true,
      remainingMs: 1_000,
      run: async () => {
        calls += 1;
        return failed({ error: "timed out", status: 0, transportErrorClass: "timeout" });
      },
    });
    expect(calls).toBe(1);
  });
});

describe("classifyServStepFailure", () => {
  it("treats a content-null refusal as a refusal", () => {
    expect(classifyServStepFailure(failed())).toBe("refusal");
    expect(classifyServStepFailure(ok(), () => false)).toBe("refusal");
    expect(classifyServStepFailure(ok(), () => true)).toBe("ok");
  });
});
