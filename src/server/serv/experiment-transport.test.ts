/**
 * Offline experiment/compare transport bounds (owner t292/t294/t295/t296).
 *
 * Asserts `experiment_single_attempt` never silently re-POSTs on timeout /
 * empty / HTTP error / refusal, while default production recovery stays intact.
 * No arbitrary SERV run quota — only transport attempt counting + honest bounds.
 */
import { describe, expect, it } from "vitest";
import {
  SERV_OUTPUT_TOKEN_DEFAULT,
  experimentServDeps,
  profile,
  requestFor,
  runServ,
  resolveServOutputTokenBound,
} from "./index";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("experiment_single_attempt transport (compare / eval only)", () => {
  const scoutTimeout = profile("scout_plan").timeoutMs;

  it("exposes honest deadline + output-token bounds without inventing a SERV run quota", () => {
    expect(scoutTimeout).toBe(45_000);
    const bound = resolveServOutputTokenBound({});
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    expect(bound.tokens).toBe(SERV_OUTPUT_TOKEN_DEFAULT);
    expect(bound.source).toBe("default");
    // requestFor serializes the bound; no hidden batch/multi-call wrapper.
    const req = requestFor("scout_plan", "{}", undefined, {});
    expect(req).toMatchObject({ max_completion_tokens: SERV_OUTPUT_TOKEN_DEFAULT });
  });

  it("records empty 200 with exactly one HTTP — no silent postProse retry", async () => {
    let calls = 0;
    const result = await runServ(
      "scout_plan",
      { user: "{}" },
      experimentServDeps({
        apiKey: "test-key",
        baseUrl: "https://serv-mock.test/v1",
        timeoutMs: scoutTimeout,
        fetch: async () => {
          calls += 1;
          return jsonResponse({
            choices: [{ finish_reason: "stop", message: { content: "", refusal: null } }],
          });
        },
      }),
    );
    expect(calls).toBe(1);
    expect(result.httpAttempts).toBe(1);
    expect(result.transportPolicy).toBe("experiment_single_attempt");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/empty/i);
      expect(result.status).toBe(200);
    }
  });

  it("records HTTP error with exactly one attempt — no hidden batch/retry", async () => {
    let calls = 0;
    const result = await runServ(
      "scout_plan",
      { user: "{}" },
      experimentServDeps({
        apiKey: "test-key",
        baseUrl: "https://serv-mock.test/v1",
        fetch: async () => {
          calls += 1;
          return jsonResponse({ error: { message: "upstream boom", type: "server_error" } }, 503);
        },
      }),
    );
    expect(calls).toBe(1);
    expect(result.httpAttempts).toBe(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
      expect(result.error).toMatch(/error/i);
      expect(result.upstream).toContain("boom");
    }
  });

  it("records refusal text as the single attempt outcome (no silent repeat)", async () => {
    let calls = 0;
    const refusal = "I cannot assist with that request.";
    const result = await runServ(
      "scout_plan",
      { user: "{}" },
      experimentServDeps({
        apiKey: "test-key",
        baseUrl: "https://serv-mock.test/v1",
        fetch: async () => {
          calls += 1;
          return jsonResponse({
            choices: [
              {
                finish_reason: "stop",
                message: { content: null, refusal },
              },
            ],
          });
        },
      }),
    );
    expect(calls).toBe(1);
    expect(result.httpAttempts).toBe(1);
    // t317: structured content-null + refusal field fails closed (no prose leak, no silent repeat).
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureDiag?.category).toBe("content_null_refusal_field");
    expect(result.error).toMatch(/refusal field/i);
    expect(JSON.stringify(result)).not.toContain(refusal);
  });

  it("does not timeout-retry under experiment even for personal_alert_review", async () => {
    let calls = 0;
    const result = await runServ(
      "personal_alert_review",
      { user: "alert" },
      experimentServDeps({
        apiKey: "test-key",
        baseUrl: "https://serv-mock.test/v1",
        timeoutMs: 3_000,
        fetch: async (_url, init) => {
          calls += 1;
          await new Promise((_resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("should have aborted")), 5_000);
            init?.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new DOMException("The operation was aborted.", "TimeoutError"));
            });
          });
          return jsonResponse({ choices: [{ message: { content: "never" } }] });
        },
      }),
    );
    expect(calls).toBe(1);
    expect(result.httpAttempts).toBe(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/timed out waiting for a response|did not respond/i);
  });

  it("counts every beforeHttp reservation exactly once per upstream attempt", async () => {
    const reservations: number[] = [];
    let calls = 0;
    const result = await runServ(
      "scout_plan",
      { user: "{}" },
      experimentServDeps({
        apiKey: "test-key",
        baseUrl: "https://serv-mock.test/v1",
        beforeHttp: async () => {
          reservations.push(1);
          return { ok: true };
        },
        fetch: async () => {
          calls += 1;
          return jsonResponse({ choices: [{ message: { content: "" } }] });
        },
      }),
    );
    expect(calls).toBe(1);
    expect(reservations).toEqual([1]);
    expect(result.httpAttempts).toBe(1);
    expect(result.ok).toBe(false);
  });
});

describe("production transport recovery remains unchanged (default policy)", () => {
  it("still empty-retries flip_judge under production default", async () => {
    let calls = 0;
    const result = await runServ(
      "flip_judge",
      { user: "{}" },
      {
        apiKey: "test",
        fetch: async () => {
          calls += 1;
          if (calls === 1) return jsonResponse({ choices: [{ message: { content: "" } }] });
          return jsonResponse({ choices: [{ message: { content: '{"decisions":[]}' } }] });
        },
      },
    );
    expect(result.transportPolicy).toBe("production");
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
    expect(result.httpAttempts).toBe(2);
  });

  it("still timeout-retries personal_alert_review under production default", async () => {
    let reviewCalls = 0;
    const recovered = await runServ(
      "personal_alert_review",
      { user: "alert" },
      {
        apiKey: "test",
        timeoutMs: 3_000,
        fetch: async (_url, init) => {
          reviewCalls += 1;
          if (reviewCalls === 1) {
            await new Promise((_resolve, reject) => {
              const timer = setTimeout(() => reject(new Error("should have aborted")), 5_000);
              init?.signal?.addEventListener("abort", () => {
                clearTimeout(timer);
                reject(new DOMException("The operation was aborted.", "TimeoutError"));
              });
            });
          }
          return jsonResponse({
            choices: [{ message: { content: "The price is already in the facts." } }],
          });
        },
      },
    );
    expect(recovered.ok).toBe(true);
    expect(reviewCalls).toBe(2);
    expect(recovered.httpAttempts).toBe(2);
    expect(recovered.transportPolicy).toBe("production");
  });
});

describe("experimentServDeps helper", () => {
  it("sets experiment policy without mutating production callers", () => {
    const base = { apiKey: "k", timeoutMs: 1_000 };
    const exp = experimentServDeps(base);
    expect(exp.transportPolicy).toBe("experiment_single_attempt");
    expect(base).not.toHaveProperty("transportPolicy");
    expect(exp.apiKey).toBe("k");
  });
});
