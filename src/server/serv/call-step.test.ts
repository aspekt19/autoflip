import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildValidationRepairUser,
  callStep,
  classifyServStepFailure,
  logRejectedServAnswer,
  PLAN_STOP_MESSAGE,
  SECOND_CHECK_MISSED,
} from "./call-step";
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

afterEach(() => {
  vi.restoreAllMocks();
});

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
    expect(outcome.repaired).toBe(false);
    expect(outcome.validationIssues).toBeNull();
  });

  it("retries a timeout once on the same profile", async () => {
    let calls = 0;
    const outcome = await callStep({
      profileId: "find_plan",
      user: "note",
      critical: true,
      remainingMs: 300_000,
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
    expect(outcome.repaired).toBe(false);
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

  it("validation fail → repair → ok", async () => {
    const users: string[] = [];
    let calls = 0;
    const outcome = await callStep({
      profileId: "find_decide",
      user: JSON.stringify({ facts: { shortlistKeys: ["a"] } }),
      critical: true,
      validate: (text) => {
        if (text.includes("\"pickKey\"")) return { ok: true };
        return { ok: false, issues: [{ field: "pickKey", message: "missing pickKey" }] };
      },
      run: async (_id, input) => {
        calls += 1;
        users.push(input.user);
        if (calls === 1) return ok("{\"action\":\"buy\"}");
        return ok("{\"pickKey\":\"a\",\"action\":\"buy\"}");
      },
    });
    expect(calls).toBe(2);
    expect(outcome.status).toBe("ok");
    expect(outcome.repaired).toBe(true);
    expect(outcome.validationIssues).toBeNull();
    const repairBody = JSON.parse(users[1]!);
    expect(repairBody.validationError.issues).toEqual([
      { field: "pickKey", message: "missing pickKey" },
    ]);
    expect(repairBody.facts.shortlistKeys).toEqual(["a"]);
  });

  it("validation fail twice → stopped for critical", async () => {
    let calls = 0;
    const outcome = await callStep({
      profileId: "find_plan",
      user: JSON.stringify({ note: "suv" }),
      critical: true,
      validate: () => ({
        ok: false,
        issues: [{ field: "bodyStyles", message: "unknown body" }],
      }),
      run: async () => {
        calls += 1;
        return ok("{\"bodyStyles\":[\"spaceship\"]}");
      },
    });
    expect(calls).toBe(2);
    expect(outcome.status).toBe("stopped");
    expect(outcome.repaired).toBe(true);
    expect(outcome.validationIssues).toEqual([{ field: "bodyStyles", message: "unknown body" }]);
    expect(outcome.rejectedSample).toContain("spaceship");
    expect(outcome.message).toBe(PLAN_STOP_MESSAGE);
  });

  it("logs rejected answer on validation failure", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await callStep({
      profileId: "find_triage",
      user: "{}",
      critical: false,
      validate: () => ({
        ok: false,
        issues: [{ field: "shortlist", message: "too few" }],
      }),
      run: async () => ok("BAD_TRIAGE_PAYLOAD_FULL_TEXT"),
    });
    const joined = err.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(joined).toContain("BAD_TRIAGE_PAYLOAD_FULL_TEXT");
    expect(joined).toContain("too few");
    expect(joined).toContain("find_triage");
  });
});

describe("logRejectedServAnswer", () => {
  it("prints the sample and issues JSON", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    logRejectedServAnswer("find_decide", "{\"x\":1}", [{ field: "x", message: "bad" }]);
    expect(err).toHaveBeenCalledTimes(2);
    expect(String(err.mock.calls[0]![0])).toContain("{\"x\":1}");
    expect(String(err.mock.calls[1]![0])).toContain("\"field\":\"x\"");
  });
});

describe("buildValidationRepairUser", () => {
  it("merges validationError into JSON user bodies", () => {
    const out = JSON.parse(
      buildValidationRepairUser({
        user: JSON.stringify({ facts: { a: 1 } }),
        issues: [{ field: "f", message: "m" }],
      }),
    );
    expect(out.facts.a).toBe(1);
    expect(out.validationError.issues[0].field).toBe("f");
  });
});

describe("classifyServStepFailure", () => {
  it("treats a content-null refusal as a refusal", () => {
    expect(classifyServStepFailure(failed())).toBe("refusal");
    expect(classifyServStepFailure(ok(), () => false)).toBe("refusal");
    expect(classifyServStepFailure(ok(), () => true)).toBe("ok");
  });
});
