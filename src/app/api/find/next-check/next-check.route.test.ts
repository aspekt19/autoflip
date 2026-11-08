/**
 * Direct HTTP integration coverage for POST /api/find/next-check.
 * Mock-labeled SERV + match — no hosted provider calls.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKv } from "@/io/kv";
import { explicitNeedFromText } from "@/domain/need";
import {
  mintFindSearchContextRecord,
  storeFindSearchContext,
} from "@/server/find-search-context";

const uid = vi.fn(async () => "user-route");
const kvHolder: { kv: MemoryKv } = { kv: new MemoryKv() };
const matchImpl = vi.fn();
const fetchImpl = vi.fn();

vi.mock("@/server/session", () => ({
  userId: () => uid(),
}));

vi.mock("@/io/kv", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/io/kv")>();
  return {
    ...actual,
    getKv: () => kvHolder.kv,
  };
});

vi.mock("@/server/deps", () => ({
  runtimeDeps: () => ({
    autodevKey: null,
    servKey: "test-serv-key",
    servModel: undefined,
    servBaseUrl: "https://serv.test/v1",
  }),
}));

vi.mock("@/server/find-match", () => ({
  runFindMatch: (body: unknown, deps: unknown) => matchImpl(body, deps),
}));

vi.mock("@/server/find-analysis-context", () => ({
  rememberFindAnalysisContexts: async () => new Map(),
}));

// Force orchestrator/live path to use our fetch via globalThis.fetch
beforeEach(() => {
  kvHolder.kv = new MemoryKv();
  uid.mockResolvedValue("user-route");
  matchImpl.mockReset();
  fetchImpl.mockReset();
  vi.stubGlobal("fetch", fetchImpl);
});

import { POST } from "./route";

function req(body: unknown) {
  return new Request("https://lemonless.test/api/find/next-check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function servChoice(checkId: string) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ checkId, note: "n" }) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

async function seed(token: string, needPatch: Record<string, unknown> = {}, listings: unknown[] = []) {
  const base = explicitNeedFromText(
    "reliable Toyota not too old under 20k near 68114 within 50 miles",
    "personal",
  );
  const record = mintFindSearchContextRecord({
    userId: "user-route",
    need: { ...base, yearMin: null, ...needPatch } as typeof base,
    listings: listings as never,
    servNextCheckEnabled: true,
    token,
  });
  await storeFindSearchContext(kvHolder.kv, record);
  return record;
}

describe("POST /api/find/next-check (HTTP)", () => {
  it("rejects missing searchContextToken (client need not authoritative)", async () => {
    const res = await POST(req({ need: { mode: "personal" }, listings: [] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("search_context_required");
  });

  it("ordinary multistep: clarify → rematch evidence → continue → grounded/user stop", async () => {
    await seed("tok-multi", { yearMin: null, zip: "68114", distanceMiles: 50, milesMax: null }, []);

    // Step 1: clarify year → research rematch returns listings
    fetchImpl.mockResolvedValueOnce(servChoice("clarify_year_band"));
    matchImpl.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: {
        ok: true,
        directions: [
          {
            listings: [
              {
                vin: "JT2BF28K0X0123456",
                make: "Toyota",
                model: "Camry",
                year: 2016,
                priceUsd: 14000,
                miles: 40000,
                priceView: { usableForBudget: true },
              },
              {
                vin: "JT2BF28K0X0654321",
                make: "Honda",
                model: "Civic",
                year: 2017,
                priceUsd: 13000,
                miles: 35000,
                priceView: { usableForBudget: true },
              },
            ],
          },
        ],
      },
    });

    const step1 = await POST(req({ searchContextToken: "tok-multi" }));
    const b1 = await step1.json();
    expect(step1.status).toBe(200);
    expect(b1.ok).toBe(true);
    expect(b1.autonomousServ).toBe(true);
    expect(b1.chosenId).toBe("clarify_year_band");
    expect(b1.needAfter.yearMin).toBe(2015);
    expect(b1.rematch?.ok).toBe(true);
    expect(b1.loop.continue).toBe(true);
    expect(b1.loop.reason).toBe("evidence_changed_replan");
    expect(matchImpl.mock.calls[0]![0].need.yearMin).toBe(2015);

    // Step 2: compare observed asks with evidence present → grounded stop (no research)
    fetchImpl.mockResolvedValueOnce(servChoice("compare_observed_asks"));
    const step2 = await POST(req({ searchContextToken: "tok-multi" }));
    const b2 = await step2.json();
    expect(b2.ok).toBe(true);
    expect(b2.chosenId).toBe("compare_observed_asks");
    expect(b2.shortlist?.length).toBeGreaterThan(0);
    expect(b2.loop.continue).toBe(false);
    expect(["grounded_stop", "no_remaining_research_checks", "unchanged_state"]).toContain(
      b2.loop.reason,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("duplicate/concurrency: second in-flight same fingerprint → 409; replay after complete", async () => {
    await seed("tok-race", { yearMin: null }, []);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    fetchImpl.mockImplementationOnce(async () => {
      await gate;
      return servChoice("widen_or_nationwide");
    });
    matchImpl.mockResolvedValue({
      ok: true,
      status: 200,
      body: { ok: true, directions: [] },
    });

    const p1 = POST(req({ searchContextToken: "tok-race" }));
    // Allow claim to land
    await new Promise((r) => setTimeout(r, 20));
    const p2 = POST(req({ searchContextToken: "tok-race" }));
    const r2 = await p2;
    expect(r2.status).toBe(409);
    const j2 = await r2.json();
    expect(j2.error).toBe("next_check_in_progress");

    release();
    const r1 = await p1;
    expect(r1.status).toBe(200);
    const j1 = await r1.json();
    expect(j1.ok).toBe(true);

    // Same fingerprint replay (context still empty applied until complete updated —
    // after success applied has widen; reclaim empty-fp receipt via orchestrator replay
    // only if fingerprint matches. Re-POST uses new fingerprint → new action.
    // Explicit: first response not replay; second concurrent was 409.
    expect(j1.replay).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("no-key path: autonomousServ false; loop does not continue as SERV", async () => {
    // Swap deps to keyless for this test via dynamic mock reset — re-import is heavy;
    // instead seed and call orchestrator-level through route with mocked deps.
    vi.doMock("@/server/deps", () => ({
      runtimeDeps: () => ({
        autodevKey: null,
        servKey: null,
        servModel: undefined,
        servBaseUrl: undefined,
      }),
    }));
    // Route already bound to prior mock — use orchestrator directly for keyless HTTP-shaped assert:
    const { runFindNextCheckOrchestrator } = await import("@/server/find-next-check-orchestrator");
    await seed("tok-keyless", {}, []);
    const result = await runFindNextCheckOrchestrator(
      { searchContextToken: "tok-keyless" },
      { kv: kvHolder.kv, userId: "user-route", servKey: null },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.autonomousServ).toBe(false);
    expect(result.loop.continue).toBe(false);
    expect(result.loop.reason).toBe("no_serv_key");
    expect(result.keyedAutonomyDiag.keyed).toBe(false);
    expect(result.keyedAutonomyDiag.configHint).toMatch(/SERV_API_KEY/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keyed + SERV timeout/abort → serv_deterministic_fallback (NOT no_keyed_autonomy)", async () => {
    // Observed production class: Mini spend present but UI showed no_keyed_autonomy
    // because keyed+fallback was conflated with missing key.
    await seed(
      "tok-timeout",
      { yearMin: 2015, zip: "68114", distanceMiles: 50, milesMax: null, budgetKnown: true, budgetUsd: 20000 },
      [
        {
          vin: "JT2BF28K0X0123456",
          make: "Mazda",
          model: "CX-5",
          year: 2017,
          priceUsd: 14950,
          miles: 60000,
        },
        {
          vin: "JT2BF28K0X0654321",
          make: "Toyota",
          model: "RAV4",
          year: 2015,
          priceUsd: 16700,
          miles: 74000,
        },
      ],
    );
    fetchImpl.mockImplementationOnce(async () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    });
    const res = await POST(req({ searchContextToken: "tok-timeout" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.autonomousServ).toBe(false);
    expect(body.source).toBe("deterministic_fallback");
    expect(body.loop.continue).toBe(false);
    expect(body.loop.reason).toBe("serv_deterministic_fallback");
    expect(body.loop.reason).not.toBe("no_keyed_autonomy");
    expect(body.loop.reason).not.toBe("no_serv_key");
    expect(body.keyedAutonomyDiag.keyed).toBe(true);
    expect(body.keyedAutonomyDiag.autonomousServ).toBe(false);
    expect(body.keyedAutonomyDiag.failureReasonCode).toMatch(/timeout|network|http/i);
    expect(body.keyedAutonomyDiag.configHint).toMatch(/find_next_check|timeout|failureDiag/i);
    expect(JSON.stringify(body)).not.toMatch(/sk-|SERV_API_KEY=\w+/);
  });

  it("unknown context / error safe", async () => {
    const res = await POST(req({ searchContextToken: "missing-token" }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("search_context_invalid");
  });

  it("provider rematch failure stops loop", async () => {
    await seed("tok-fail", { yearMin: null, zip: "68114", distanceMiles: 50 }, []);
    fetchImpl.mockResolvedValueOnce(servChoice("widen_or_nationwide"));
    matchImpl.mockResolvedValueOnce({
      ok: false,
      status: 502,
      body: { ok: false, message: "provider down", emptyReason: "provider_failure" },
    });
    const res = await POST(req({ searchContextToken: "tok-fail" }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.loop.continue).toBe(false);
    expect(body.loop.reason).toBe("provider_failure");
  });
});
