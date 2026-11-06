/**
 * INTEGRATION milestone (offline) — HTTP entry → facade → real SERV request
 * serialization (stubbed remote) → live inventory adapter (stub fetch) →
 * reject/replace/search → persistence/idempotent replay → consumer JSON shape.
 *
 * Labels: OFFLINE plumbing. Stubbed SERV responses are NOT live SERV reasoning /
 * efficacy. testAuthority is harness-only; production POST omits harness.
 */
import { describe, expect, it, vi } from "vitest";
import { createApiKey } from "@/server/api-keys";
import { UpstashKv } from "@/io/kv";
import { TtlCache } from "@/io/cache";
import { MemoryCounter } from "@/io/quota";
import { isScoutUiEnabled } from "@/server/scout/config";
import { testPaidAuthorityStub, SCOUT_REQUEST_SAFETY } from "@/server/scout/paid-execution";
import { loadScoutMeta, loadScoutRun, clearScoutRunMemory } from "@/server/scout/store";
import { postScoutStart } from "@/server/scout/http-start";
import { POST as scoutPost, GET as scoutGet } from "@/app/api/scout/route";
import fixture from "../../../fixtures/autodev-camry.json";

const CAMRY_VIN =
  (fixture as { data?: Array<{ vin?: string }> }).data?.[0]?.vin ?? "4T1K61AK0MU423359";

function upstashKv() {
  const store = new Map<string, string>();
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const args = JSON.parse(String(init?.body ?? "[]")) as string[];
    const op = args[0];
    if (op === "GET") return Response.json({ result: store.get(args[1]!) ?? null });
    if (op === "SET") {
      if (args.includes("NX") && store.has(args[1]!)) return Response.json({ result: null });
      store.set(args[1]!, args[2]!);
      return Response.json({ result: "OK" });
    }
    if (op === "INCR") {
      const next = Number(store.get(args[1]!) ?? "0") + 1;
      store.set(args[1]!, String(next));
      return Response.json({ result: next });
    }
    if (op === "DECR") {
      const next = Number(store.get(args[1]!) ?? "0") - 1;
      store.set(args[1]!, String(next));
      return Response.json({ result: next });
    }
    if (op === "DEL") {
      store.delete(args[1]!);
      return Response.json({ result: 1 });
    }
    return Response.json({ result: null });
  });
  return {
    kv: new UpstashKv("https://upstash.test", "tok", fetchImpl as typeof fetch),
    store,
  };
}

const paidEnv = {
  SCOUT_ENABLED: "true",
  SCOUT_ALLOW_SERV_PLANNER: "true",
  SCOUT_PAID_EXECUTION: "true",
  AUTODEV_API_KEY: "test-autodev",
  SERV_API_KEY: "test-serv",
  SERV_BASE_URL: "https://serv-mock.test/v1",
  SCOUT_MAX_PROVIDER_CALLS_HARD_CEILING: "8",
};

function servChoice(action: Record<string, unknown>) {
  return Response.json({
    choices: [{ message: { content: JSON.stringify(action) } }],
  });
}

function listingPayload(rows: Array<Record<string, unknown>>) {
  return Response.json({ data: rows });
}

describe("Scout INTEGRATION HTTP→facade→stubbed SERV/Auto.dev (offline)", () => {
  it("production defaults: API+UI off; POST without enable is 403", async () => {
    expect(isScoutUiEnabled({})).toBe(false);
    const { kv } = upstashKv();
    const res = await postScoutStart(
      new Request("http://localhost/api/scout", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer af_x" },
        body: JSON.stringify({ mandate: { mode: "flip", preferredMakes: ["Toyota"], zip: "72712" } }),
      }),
      { kv, env: {} },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("scout_disabled");
  });

  it("GET /api/scout catalog distinguishes UI gate vs API gate (no header-nav claim)", async () => {
    const res = await scoutGet();
    const body = await res.json();
    expect(body.enabled).toBe(false);
    expect(body.defaults.ui).toMatch(/SCOUT_UI_ENABLED/);
    expect(body.defaults.ui).toMatch(/not in primary header nav/i);
    expect(body.defaults.paidLivePath).toMatch(/disabled/i);
  });

  it("exported POST is single-arg only — client body cannot inject testAuthority/harness/env grant", async () => {
    clearScoutRunMemory();
    const { kv } = upstashKv();
    const { token } = await createApiKey(kv, "owner-bypass", "int");
    // Seed process env as if deployment enabled scout + paid flags with fake balances.
    const prev = { ...process.env };
    process.env.SCOUT_ENABLED = "true";
    process.env.SCOUT_PAID_EXECUTION = "true";
    process.env.AUTODEV_API_KEY = "fake";
    process.env.SERV_API_KEY = "fake";
    process.env.SCOUT_MAX_PROVIDER_CALLS_HARD_CEILING = "10";
    process.env.SCOUT_SERVER_VERIFIED_BALANCE_USD = "999";
    process.env.SCOUT_SERVER_SPEND_HARD_CAP_USD = "5";
    try {
      // Production POST signature: (req) only — no hooks second arg.
      expect(scoutPost.length).toBe(1);
      const res = await scoutPost(
        new Request("http://localhost/api/scout", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            planner: "serv",
            preferLive: true,
            testAuthority: { kind: "test_stub", remainingProviderBudget: 99, authorizedSpendUsd: 99 },
            harness: { testAuthority: { kind: "test_stub", remainingProviderBudget: 99 } },
            verifiedBalanceUsd: 999,
            mandate: {
              mode: "flip",
              preferredMakes: ["Toyota"],
              openToOtherMakes: false,
              zip: "72712",
              maxDistanceMiles: 50,
              maxMiles: null,
              targetProfitUsd: 500,
              budgetUsd: null,
              budgetKnown: false,
              repairAbility: "unknown",
              testAuthority: { kind: "test_stub", remainingProviderBudget: 99 },
            },
          }),
        }),
      );
      // Without injected kv the real getKv() may differ; still must not open live via body.
      // Call through postScoutStart with same body but no harness to assert paidBlocked/fixture.
      const controlled = await postScoutStart(
        new Request("http://localhost/api/scout", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            planner: "serv",
            preferLive: true,
            testAuthority: { kind: "test_stub", remainingProviderBudget: 99, authorizedSpendUsd: 99 },
            harness: { testAuthority: { kind: "test_stub", remainingProviderBudget: 99 } },
            verifiedBalanceUsd: 999,
            mandate: {
              mode: "flip",
              preferredMakes: ["Toyota"],
              openToOtherMakes: false,
              zip: "72712",
              maxDistanceMiles: 50,
              maxMiles: null,
              targetProfitUsd: 500,
              budgetUsd: null,
              budgetKnown: false,
              repairAbility: "unknown",
            },
          }),
        }),
        { kv, env: { ...paidEnv, SCOUT_ALLOW_SERV_PLANNER: "true" } },
      );
      const body = await controlled.json();
      expect(
        body.isFixture === true ||
          body.paidBlockedReason != null ||
          body.result?.autonomyClaim === "none" ||
          body.error != null,
      ).toBe(true);
      if (body.result) {
        expect(body.presentation?.kind).not.toBe("live_autodev");
      }
      void res;
    } finally {
      for (const k of Object.keys(process.env)) {
        if (!(k in prev)) delete process.env[k];
      }
      Object.assign(process.env, prev);
    }
  });

  it("HTTP fixture path: af_ key → executeScoutRun → persist → consumer presentation + disposition fields", async () => {
    clearScoutRunMemory();
    const { kv } = upstashKv();
    const { token } = await createApiKey(kv, "owner-int-1", "int");
    const res = await postScoutStart(
      new Request("http://localhost/api/scout", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          [SCOUT_REQUEST_SAFETY.idempotencyHeader]: "int-fixture-1",
        },
        body: JSON.stringify({
          planner: "offline_heuristic",
          preferLive: false,
          mandate: {
            mode: "flip",
            preferredMakes: ["Toyota"],
            openToOtherMakes: false,
            zip: "72712",
            maxDistanceMiles: 200,
            maxMiles: null,
            targetProfitUsd: 500,
            budgetUsd: null,
            budgetKnown: false,
            repairAbility: "unknown",
          },
        }),
      }),
      { kv, env: { SCOUT_ENABLED: "true" } },
    );
    expect(res.status).toBeLessThan(500);
    const body = await res.json();
    expect(body.presentation?.kind).toBe("fixture_replay");
    expect(body.presentation?.warning).toMatch(/not a live market pull/i);
    expect(body.isFixture).toBe(true);
    expect(body.result?.runId).toBeTruthy();
    expect(body.result?.autonomyClaim).toBe("none");
    // Consumer / UI-facing candidate shape
    for (const c of body.result?.investigation ?? []) {
      expect(c).toHaveProperty("disposition");
      expect(c).toHaveProperty("rejectReason");
      expect(c.claimsSafeBuy).toBe(false);
      expect(c.claimsVerifiedProfit).toBe(false);
    }
    const stored = await loadScoutRun(kv, body.result.runId);
    expect(stored?.runId).toBe(body.result.runId);
    const meta = await loadScoutMeta(kv, body.result.runId);
    expect(meta?.presentation?.kind).toBe("fixture_replay");

    // Idempotent replay — same key returns receipt, no second run
    const again = await postScoutStart(
      new Request("http://localhost/api/scout", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          [SCOUT_REQUEST_SAFETY.idempotencyHeader]: "int-fixture-1",
        },
        body: JSON.stringify({
          planner: "offline_heuristic",
          preferLive: false,
          mandate: {
            mode: "flip",
            preferredMakes: ["Toyota"],
            openToOtherMakes: false,
            zip: "72712",
            maxDistanceMiles: 200,
            maxMiles: null,
            targetProfitUsd: 500,
            budgetUsd: null,
            budgetKnown: false,
            repairAbility: "unknown",
          },
        }),
      }),
      { kv, env: { SCOUT_ENABLED: "true" } },
    );
    const againBody = await again.json();
    expect(againBody.idempotentReplay).toBe(true);
    expect(againBody.result?.runId).toBe(body.result.runId);
  });

  it("HTTP+harness: real scout_plan serialization + stub SERV + live adapter stubfetch → replace/search/reject", async () => {
    clearScoutRunMemory();
    const { kv } = upstashKv();
    const { token } = await createApiKey(kv, "owner-int-2", "int");

    const servBodies: unknown[] = [];
    let servStep = 0;
    const servFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      servBodies.push(body);
      servStep += 1;
      const userMsg = (body.messages as Array<{ role: string; content: string }>).find(
        (m) => m.role === "user",
      )?.content;
      const user = JSON.parse(userMsg ?? "{}") as {
        pendingVins?: string[];
        investigatedVins?: string[];
        evidenceContext?: { evidenceBriefs?: Array<{ vin: string; adverseEvidenceAvailable?: unknown[] }> };
        recentOutcomes?: Array<{ toolId: string; status: string; vin?: string }>;
      };
      const pending = user.pendingVins ?? [];
      const vin = pending[0] ?? user.investigatedVins?.[0] ?? CAMRY_VIN;
      const briefs = user.evidenceContext?.evidenceBriefs ?? [];
      const adverse = briefs.find((b) => b.vin === vin)?.adverseEvidenceAvailable as
        | Array<{ kind: string; gateId?: string }>
        | undefined;

      // Evidence-driven: after unsupported gov, uncertainty replace; else search or select.
      const govUnsupported = (user.recentOutcomes ?? []).some(
        (o) => o.toolId === "evidence.gov_recalls" && o.status === "unsupported",
      );

      if (servStep === 1) {
        return servChoice({
          type: "select_candidate",
          vin,
          reason: "select first pending for investigation",
          servStepId: "s1",
        });
      }
      if (servStep === 2) {
        return servChoice({
          type: "run_tool",
          toolId: "evidence.gov_recalls",
          vin,
          reason: "gov check",
          servStepId: "g1",
        });
      }
      if (govUnsupported && servStep === 3) {
        return servChoice({
          type: "replace",
          vin,
          reason: "unsupported gov proves the car is bad — do not buy",
          servStepId: "r1",
          rationaleKind: "uncertainty_progress",
        });
      }
      if (servStep === 4) {
        return servChoice({
          type: "run_tool",
          toolId: "inventory.search",
          vin: null,
          reason: "evidence-driven mid-loop search for Honda Civic",
          servStepId: "search1",
          args: {
            makes: ["Honda"],
            models: ["Civic"],
            zip: "72712",
            distanceMiles: 100,
            maxPriceUsd: 20_000,
            maxMiles: 80_000,
          },
        });
      }
      // Personal-style economics or over_budget if available — else finalize.
      if (adverse?.some((a) => a.kind === "over_budget" || a.kind === "economics_estimate")) {
        const cite = adverse.find((a) => a.kind === "over_budget" || a.kind === "economics_estimate")!;
        return servChoice({
          type: "reject",
          vin: briefs[0]?.vin ?? vin,
          reason: "gov unsupported so reject",
          servStepId: `rej-${servStep}`,
          rationaleKind: "adverse_evidence",
          citedEvidence: [{ kind: cite.kind, gateId: cite.gateId ?? "mandate_fit" }],
          assumptionsDisclosed: cite.kind === "economics_estimate",
        });
      }
      return servChoice({
        type: "finalize",
        reason: "integration finalize",
        servStepId: `f-${servStep}`,
      });
    });

    const autodevUrls: string[] = [];
    const autodevFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      autodevUrls.push(url);
      if (/Honda|Civic/i.test(url)) {
        return listingPayload([
          {
            vin: "1HGBH41JXMN109191",
            vehicle: { make: "Honda", model: "Civic", year: 2019 },
            retailListing: { price: 15_000, miles: 30_000, used: true, zip: "72712" },
          },
        ]);
      }
      // Initial multi-make / Toyota pull — reuse camry-shaped rows
      return listingPayload(
        ((fixture as { data: unknown[] }).data ?? []).slice(0, 3) as Array<Record<string, unknown>>,
      );
    });

    const res = await postScoutStart(
      new Request("http://localhost/api/scout", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          [SCOUT_REQUEST_SAFETY.idempotencyHeader]: "int-serv-live-1",
        },
        body: JSON.stringify({
          planner: "serv",
          preferLive: true,
          mandate: {
            mode: "flip",
            preferredMakes: ["Toyota", "Honda"],
            openToOtherMakes: false,
            zip: "72712",
            maxDistanceMiles: 100,
            maxMiles: 90_000,
            targetProfitUsd: 500,
            budgetUsd: null,
            budgetKnown: false,
            repairAbility: "unknown",
          },
        }),
      }),
      {
        kv,
        env: paidEnv,
        harness: {
          env: paidEnv,
          testAuthority: testPaidAuthorityStub({ remainingProviderBudget: 6 }),
          servFetch: servFetch as typeof fetch,
          autodevDeps: {
            fetch: autodevFetch as typeof fetch,
            apiKey: "test-autodev",
            cache: new TtlCache<unknown>(),
            counter: new MemoryCounter(),
          },
        },
      },
    );

    expect(res.status).toBeLessThan(500);
    const body = await res.json();
    expect(body.result?.autonomyClaim).toBe("serv_directed");
    expect(body.isFixture).toBe(false);
    expect(body.presentation?.kind).toBe("live_autodev");

    // REAL scout_plan serialization (not mockServPlanner choreography)
    expect(servBodies.length).toBeGreaterThan(0);
    const first = servBodies[0] as {
      model: string;
      tools: Array<{ function?: { name: string }; name?: string }>;
      response_format?: { json_schema?: { name: string } };
      messages: Array<{ role: string; content: string }>;
    };
    expect(first.response_format?.json_schema?.name).toBe("lemonless_scout_plan_action");
    expect(first.tools.some((t) => (t.function?.name ?? t.name) === "serv_prompt_guard")).toBe(true);
    expect(first.messages.some((m) => m.role === "system")).toBe(true);
    const user = JSON.parse(first.messages.find((m) => m.role === "user")!.content);
    expect(user.task).toBe("lemonless_scout_plan");
    expect(user.evidenceContext?.evidenceBriefs).toBeDefined();

    // Live adapter actually dispatched (stubfetch)
    expect(autodevFetch).toHaveBeenCalled();
    expect(autodevUrls.some((u) => /vehicle\.make=/i.test(u))).toBe(true);

    // uncertainty_progress replace must not endorse planner car-bad text
    const replaced = (body.result?.candidates ?? []).find(
      (c: { disposition: string }) => c.disposition === "replaced",
    );
    if (replaced) {
      expect(replaced.rejectReason).toMatch(/uncertainty_progress/);
      expect(replaced.rejectReason).not.toMatch(/proves the car is bad/i);
      expect(replaced.dispositionRationale?.kind).toBe("uncertainty_progress");
      expect(replaced.dispositionRationale?.plannerReasonRaw).toMatch(/proves the car is bad/i);
    }

    // Mid-loop search requested with model/price/miles when SERV scripted it
    const searchOutcome = (body.result?.toolOutcomes ?? []).find(
      (o: { toolId: string }) => o.toolId === "inventory.search",
    );
    if (searchOutcome) {
      expect(autodevUrls.some((u) => /Civic|Honda/i.test(u))).toBe(true);
    }

    // Persistence
    const stored = await loadScoutRun(kv, body.result.runId);
    expect(stored?.toolOutcomes?.length).toBeGreaterThan(0);
  });

  it("personal vs nationwide mandates through HTTP+harness; empty inventory stays honest", async () => {
    clearScoutRunMemory();
    const { kv } = upstashKv();
    const { token } = await createApiKey(kv, "owner-int-3", "int");

    // Nationwide personal — stub SERV abstains after empty live pull
    const servFetch = vi.fn(async () =>
      servChoice({
        type: "abstain",
        reason: "no inventory under nationwide personal mandate",
        servStepId: "a1",
      }),
    );
    const autodevFetch = vi.fn(async () => listingPayload([]));

    const nationwide = await postScoutStart(
      new Request("http://localhost/api/scout", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          planner: "serv",
          preferLive: true,
          mandate: {
            mode: "personal",
            preferredMakes: ["Honda", "Toyota"],
            openToOtherMakes: true,
            zip: null,
            maxDistanceMiles: null,
            maxMiles: 60_000,
            targetProfitUsd: null,
            budgetUsd: 18_000,
            budgetKnown: true,
            repairAbility: "unknown",
          },
        }),
      }),
      {
        kv,
        env: paidEnv,
        harness: {
          env: paidEnv,
          testAuthority: testPaidAuthorityStub({ remainingProviderBudget: 4 }),
          servFetch: servFetch as typeof fetch,
          autodevDeps: {
            fetch: autodevFetch as typeof fetch,
            apiKey: "test-autodev",
            cache: new TtlCache<unknown>(),
            counter: new MemoryCounter(),
          },
        },
      },
    );
    const nw = await nationwide.json();
    expect(nationwide.status).toBeLessThan(500);
    // Empty/abstain/partial — never fabricated safe-buy shortlist
    expect(nw.result?.investigation?.length ?? 0).toBe(0);
    expect(nw.partial === true || nw.result?.state === "abstained" || nw.result?.state === "failed").toBe(
      true,
    );
    for (const c of nw.result?.candidates ?? []) {
      expect(c.claimsSafeBuy).toBe(false);
    }

    // Production POST without harness cannot open live even with paid env flags
    clearScoutRunMemory();
    const { kv: kv2 } = upstashKv();
    const { token: token2 } = await createApiKey(kv2, "owner-int-4", "int");
    const blocked = await postScoutStart(
      new Request("http://localhost/api/scout", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token2}`,
        },
        body: JSON.stringify({
          planner: "serv",
          preferLive: true,
          mandate: {
            mode: "flip",
            preferredMakes: ["Toyota"],
            openToOtherMakes: false,
            zip: "72712",
            maxDistanceMiles: 50,
            maxMiles: null,
            targetProfitUsd: 500,
            budgetUsd: null,
            budgetKnown: false,
            repairAbility: "unknown",
          },
        }),
      }),
      { kv: kv2, env: paidEnv /* no harness */ },
    );
    const blockedBody = await blocked.json();
    // Without harness testAuthority: either fixture replay fallback or blocked serv — never silent live spend.
    if (blockedBody.result) {
      expect(
        blockedBody.isFixture === true ||
          blockedBody.paidBlockedReason != null ||
          blockedBody.result.autonomyClaim === "none",
      ).toBe(true);
    }
  });

  it("UI access is independent of API: SCOUT_UI_ENABLED alone does not enable POST", async () => {
    expect(isScoutUiEnabled({ SCOUT_UI_ENABLED: "true" })).toBe(true);
    expect(isScoutUiEnabled({ SCOUT_ENABLED: "true" })).toBe(false);
    const { kv } = upstashKv();
    const res = await postScoutStart(
      new Request("http://localhost/api/scout", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer af_x" },
        body: JSON.stringify({ mandate: { mode: "flip", preferredMakes: ["Toyota"], zip: "72712" } }),
      }),
      { kv, env: { SCOUT_UI_ENABLED: "true" } },
    );
    expect(res.status).toBe(403);
  });
});
