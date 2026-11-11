import { describe, expect, it } from "vitest";
import {
  describeServCallFailure,
  describeServPayloadRejection,
  isServTimeout,
  journalWhyFromServAttempt,
} from "./resale-serv-call";
import { BASE_MODEL, modelFor, type ServResult } from "@/server/serv";

function failedResult(partial: {
  error: string;
  status: number;
  latencyMs: number;
}): ServResult {
  const multipath = modelFor("resale_plan_search", BASE_MODEL);
  return {
    ok: false,
    error: partial.error,
    status: partial.status,
    proof: {
      purpose: "resale_plan_search",
      modelRequested: multipath,
      modelReported: multipath,
      latencyMs: partial.latencyMs,
      ok: false,
      status: partial.status,
      fallbackUsed: true,
      tools: [],
      features: [],
      promptGuard: "not_used",
      shadowOutcome: "not_exposed",
      shadowMaxIterations: null,
      openserv: null,
      recordedAt: new Date().toISOString(),
    } as unknown as ServResult["proof"],
    fallback: "deterministic_plan",
    upstream: null,
    httpAttempts: 1,
    transportPolicy: "production",
    responseShape: null,
  };
}

describe("resale SERV failure labeling", () => {
  it("labels a client timeout with measured latency — never as a payload rejection", () => {
    const result = failedResult({
      error: "SERV did not respond.",
      status: 0,
      latencyMs: 38_012,
    });
    expect(isServTimeout(result)).toBe(true);
    const fail = describeServCallFailure(result);
    expect(fail.isTimeout).toBe(true);
    expect(fail.why).toBe("SERV timed out after 38s");
    expect(fail.rejected).toBe("timeout");
    expect(fail.latencyMs).toBe(38_012);

    const journal = journalWhyFromServAttempt({
      result,
      validation: { ok: true },
      missingPayloadFallback: "Plan payload missing allowlisted direction ids.",
    });
    expect(journal.why).toBe("SERV timed out after 38s");
    expect(journal.why).not.toMatch(/payload missing|allowlisted/i);
    expect(journal.rejected).toBe("timeout");
  });

  it("labels HTTP errors separately from validation rejects", () => {
    const result = failedResult({
      error: "upstream unavailable",
      status: 503,
      latencyMs: 1_200,
    });
    expect(isServTimeout(result)).toBe(false);
    const fail = describeServCallFailure(result);
    expect(fail.why).toBe("SERV HTTP 503: upstream unavailable");
    expect(fail.rejected).toBe("http_error");
  });

  it("does not label model-allowlist / status-0 local failures as timeouts", () => {
    const result = failedResult({
      error: "Unsupported model test-model for profile resale_pick.",
      status: 0,
      latencyMs: 0,
    });
    expect(isServTimeout(result)).toBe(false);
    const fail = describeServCallFailure(result);
    expect(fail.isTimeout).toBe(false);
    expect(fail.why).toMatch(/SERV call failed:/);
    expect(fail.rejected).toBe("call_failed");
  });

  it("labels validation rejects with an explicit payload prefix", () => {
    const rej = describeServPayloadRejection("Evidence id \"made_up\" was not in the evidence bundle.");
    expect(rej.why).toBe(
      'SERV payload rejected: Evidence id "made_up" was not in the evidence bundle.',
    );
    expect(rej.rejected).toBe("rejected: unsupported reference");
  });

  it("journals a received-but-rejected payload as rejected: unsupported reference (not timeout)", () => {
    const okResult = {
      ...failedResult({ error: "x", status: 200, latencyMs: 900 }),
      ok: true as const,
      text: "{}",
      model: BASE_MODEL,
      shadowOutcome: "not_exposed",
      rawStatus: 200,
      failureDiag: null,
    };
    const journal = journalWhyFromServAttempt({
      result: okResult,
      payload: { pickVin: "1HGCM82633A999999", action: "buy", note: "x", evidenceIds: [] },
      validation: {
        ok: false,
        reason: "rejected: unsupported reference",
        detail: 'VIN "1HGCM82633A999999" is not in the allowlist.',
      },
      missingPayloadFallback: "Pick payload missing allowlisted VIN.",
    });
    expect(journal.rejected).toBe("rejected: unsupported reference");
    expect(journal.why).toMatch(/^SERV payload rejected:/);
    expect(journal.why).not.toMatch(/timed out/i);
  });
});
