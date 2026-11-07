/**
 * Four offline regressions for ec253d2 follow-up blockers:
 * (1) SERV grant maxCalls reserved before every HTTP
 * (2) maxSpendUsd fail-closed (no decorative dollar cap)
 * (3) signed session dies when underlying af_ key revoked
 * (4) Scout nav discovers SCOUT_UI_ENABLED at runtime (not build bake alone)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { UpstashKv } from "@/io/kv";
import {
  createApiKey,
  hashApiKeyToken,
  revokeApiKey,
} from "@/server/api-keys";
import { authorizeScoutStart } from "./access";
import { scoutCapabilities } from "./capabilities";
import { isScoutUiEnabled } from "./config";
import { executeScoutSafely } from "./safe-execute";
import {
  readGrantUsed,
  reserveGrantProviderCall,
  saveOwnerGrant,
  type ScoutOwnerGrant,
} from "./owner-grant";
import { mintScoutSessionToken } from "./signed-session";
import { clearScoutRunMemory } from "./store";

function upstashKv(store: Map<string, string> = new Map()) {
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const args = JSON.parse(String(init?.body ?? "[]")) as string[];
    if (args[0] === "GET") return Response.json({ result: store.get(args[1]!) ?? null });
    if (args[0] === "SET") {
      if (args.includes("NX") && store.has(args[1]!)) return Response.json({ result: null });
      store.set(args[1]!, String(args[2]));
      return Response.json({ result: "OK" });
    }
    if (args[0] === "INCR") {
      const next = Number(store.get(args[1]!) ?? "0") + 1;
      store.set(args[1]!, String(next));
      return Response.json({ result: next });
    }
    if (args[0] === "DECR") {
      const next = Number(store.get(args[1]!) ?? "0") - 1;
      store.set(args[1]!, String(next));
      return Response.json({ result: next });
    }
    return Response.json({ result: null });
  });
  return { kv: new UpstashKv("https://upstash.test", "tok", fetchImpl as typeof fetch), store };
}

const paidEnv = {
  SCOUT_ENABLED: "true",
  SCOUT_ALLOW_SERV_PLANNER: "true",
  SCOUT_PAID_EXECUTION: "true",
  AUTODEV_API_KEY: "test-autodev",
  SERV_API_KEY: "test-serv",
  SERV_BASE_URL: "https://serv-mock.test/v1",
  SCOUT_MAX_PROVIDER_CALLS_HARD_CEILING: "8",
  SCOUT_SESSION_SECRET: "test-session-secret-16+",
  UPSTASH_REDIS_REST_URL: "https://upstash.test",
  UPSTASH_REDIS_REST_TOKEN: "tok",
};

const flipMandate = {
  mode: "flip" as const,
  preferredMakes: ["Toyota"],
  openToOtherMakes: false,
  zip: "72712",
  maxDistanceMiles: 100,
  maxMiles: null,
  targetProfitUsd: 500,
  budgetUsd: null,
  budgetKnown: false,
  repairAbility: "unknown" as const,
  notes: null,
};

function servChoice(action: Record<string, unknown>) {
  return Response.json({
    choices: [{ message: { content: JSON.stringify(action) } }],
  });
}

describe("blocker (1): SERV grant maxCalls reserved before every HTTP", () => {
  it("maxCalls=1 → one stub HTTP then quota exhaustion; used=1 (not 0); serv_directed", async () => {
    clearScoutRunMemory();
    const { kv } = upstashKv();
    const ownerId = "owner-serv-cap";
    const { token } = await createApiKey(kv, ownerId, "serv-cap");
    const hash = hashApiKeyToken(token);
    const grant: ScoutOwnerGrant = {
      version: 1,
      id: "grant-serv-max1",
      ownerUserId: ownerId,
      apiKeyHash: hash,
      providers: {
        serv: { maxCalls: 1, maxSpendUsd: null, note: "call-count-only SERV series" },
      },
      expiresAt: null,
      provenance: "test:serv_maxCalls_1",
      createdAt: new Date().toISOString(),
    };
    expect((await saveOwnerGrant(kv, grant)).ok).toBe(true);

    let servHttp = 0;
    const servFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      servHttp += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ role: string; content: string }>;
      };
      const userMsg = body.messages?.find((m) => m.role === "user")?.content;
      const user = JSON.parse(userMsg ?? "{}") as { pendingVins?: string[] };
      const vin = user.pendingVins?.[0] ?? "4T1K61AK0MU423359";
      // First HTTP: tool/select. Second would finalize — maxCalls=1 blocks dispatch.
      if (servHttp === 1) {
        return servChoice({
          type: "select_candidate",
          vin,
          reason: "first (and only budgeted) SERV HTTP",
          servStepId: "t1",
        });
      }
      return servChoice({
        type: "finalize",
        reason: "should not be dispatched under maxCalls=1",
        servStepId: "f-blocked",
      });
    });

    const executed = await executeScoutSafely({
      req: {
        ownerId,
        apiKeyHash: hash,
        grantId: grant.id,
        mandate: flipMandate,
        planner: "serv",
        preferLive: false,
        channel: "test",
      },
      kv,
      env: paidEnv,
      servFetch: servFetch as typeof fetch,
    });

    expect(executed.ok).toBe(true);
    if (!executed.ok) return;
    expect(executed.result.autonomyClaim).toBe("serv_directed");
    // One reserved + dispatched HTTP; second planner attempt fails closed before HTTP.
    expect(servHttp).toBe(1);
    expect(await readGrantUsed(kv, grant.id, "serv")).toBe(1);
    // Honest stop — not a silent second finalize under exhausted grant.
    expect(executed.result.state).toBe("failed");
    expect(executed.result.failReason).toBe("serv_unavailable");
    expect(executed.result.message ?? "").toMatch(/grant|call cap|exhausted/i);
  });

  it("ambiguous SERV failure after reserve retains usage (no quiet refund)", async () => {
    clearScoutRunMemory();
    const { kv } = upstashKv();
    const ownerId = "owner-serv-ambig";
    const { token } = await createApiKey(kv, ownerId, "ambig");
    const hash = hashApiKeyToken(token);
    const grant: ScoutOwnerGrant = {
      version: 1,
      id: "grant-serv-ambig",
      ownerUserId: ownerId,
      apiKeyHash: hash,
      providers: {
        serv: { maxCalls: 3, maxSpendUsd: null, note: "retain on ambiguous" },
      },
      expiresAt: null,
      provenance: "test:ambiguous",
      createdAt: new Date().toISOString(),
    };
    expect((await saveOwnerGrant(kv, grant)).ok).toBe(true);

    const servFetch = vi.fn(async () => {
      throw new TypeError("network reset after dispatch");
    });

    const executed = await executeScoutSafely({
      req: {
        ownerId,
        apiKeyHash: hash,
        grantId: grant.id,
        mandate: flipMandate,
        planner: "serv",
        preferLive: false,
        channel: "test",
      },
      kv,
      env: paidEnv,
      servFetch: servFetch as typeof fetch,
    });
    expect(executed.ok).toBe(true);
    if (!executed.ok) return;
    expect(await readGrantUsed(kv, grant.id, "serv")).toBe(1);
    expect(servFetch).toHaveBeenCalled();
  });

  it("concurrent SERV reserves are atomic against maxCalls", async () => {
    const { kv } = upstashKv();
    const grant: ScoutOwnerGrant = {
      version: 1,
      id: "grant-atomic",
      ownerUserId: "o",
      apiKeyHash: "a".repeat(64),
      providers: { serv: { maxCalls: 1, maxSpendUsd: null, note: "atomic" } },
      expiresAt: null,
      provenance: "test",
      createdAt: new Date().toISOString(),
    };
    expect((await saveOwnerGrant(kv, grant)).ok).toBe(true);
    const [a, b] = await Promise.all([
      reserveGrantProviderCall(kv, grant, "serv"),
      reserveGrantProviderCall(kv, grant, "serv"),
    ]);
    const oks = [a, b].filter((r) => r.ok);
    const fails = [a, b].filter((r) => !r.ok);
    expect(oks).toHaveLength(1);
    expect(fails).toHaveLength(1);
    expect(await readGrantUsed(kv, grant.id, "serv")).toBe(1);
  });
});

describe("blocker (2): maxSpendUsd fail-closed (call-count-only supported)", () => {
  it("rejects grants that set maxSpendUsd (no decorative dollar guarantee)", async () => {
    const { kv } = upstashKv();
    const saved = await saveOwnerGrant(kv, {
      version: 1,
      id: "grant-usd",
      ownerUserId: "owner-usd",
      apiKeyHash: "b".repeat(64),
      providers: {
        serv: { maxCalls: 2, maxSpendUsd: 0.01, note: "decorative dollar" },
      },
      expiresAt: null,
      provenance: "test:usd",
      createdAt: new Date().toISOString(),
    });
    expect(saved.ok).toBe(false);
    if (!saved.ok) {
      expect(saved.message).toMatch(/maxSpendUsd is unsupported|call-count-only/i);
      expect(saved.message).not.toMatch(/invented rates accepted/i);
    }
  });

  it("call-count-only grants (maxSpendUsd null) save and resolve without dollar claim", async () => {
    const { kv } = upstashKv();
    const saved = await saveOwnerGrant(kv, {
      version: 1,
      id: "grant-calls",
      ownerUserId: "owner-calls",
      apiKeyHash: "c".repeat(64),
      providers: {
        serv: { maxCalls: 2, maxSpendUsd: null, note: "honest call-count-only" },
      },
      expiresAt: null,
      provenance: "test:calls",
      createdAt: new Date().toISOString(),
    });
    expect(saved.ok).toBe(true);
  });
});

describe("blocker (3): signed session dies when af_ key revoked", () => {
  it("session minted → revoke key → authorizeScoutStart denied; bearer also denied", async () => {
    const { kv } = upstashKv();
    const ownerId = "owner-sess-rev";
    const { token, record } = await createApiKey(kv, ownerId, "sess");
    const hash = hashApiKeyToken(token);
    await saveOwnerGrant(kv, {
      version: 1,
      id: "grant-sess",
      ownerUserId: ownerId,
      apiKeyHash: hash,
      providers: { serv: { maxCalls: 2, maxSpendUsd: null, note: "sess" } },
      expiresAt: null,
      provenance: "test:sess",
      createdAt: new Date().toISOString(),
    });

    const minted = mintScoutSessionToken(
      { userId: ownerId, grantId: "grant-sess", keyHashPrefix: hash },
      paidEnv,
    );
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    const before = await authorizeScoutStart(
      kv,
      { bearerToken: null, signedSession: minted.session },
      "http://localhost",
      { ...paidEnv, SCOUT_OWNER_USER_IDS: ownerId },
    );
    expect(before.ok).toBe(true);

    expect(await revokeApiKey(kv, ownerId, record.id)).toBe(true);

    const afterSession = await authorizeScoutStart(
      kv,
      { bearerToken: null, signedSession: minted.session },
      "http://localhost",
      { ...paidEnv, SCOUT_OWNER_USER_IDS: ownerId },
    );
    expect(afterSession.ok).toBe(false);
    if (!afterSession.ok) {
      expect(afterSession.body.error).toBe("scout_session_key_revoked");
    }

    const afterBearer = await authorizeScoutStart(
      kv,
      { bearerToken: token, signedSession: null },
      "http://localhost",
      { ...paidEnv, SCOUT_OWNER_USER_IDS: ownerId },
    );
    expect(afterBearer.ok).toBe(false);
    if (!afterBearer.ok) expect(afterBearer.status).toBe(401);
  });

  it("expired grant on session is denied", async () => {
    const { kv } = upstashKv();
    const ownerId = "owner-exp";
    const { token } = await createApiKey(kv, ownerId, "exp");
    const hash = hashApiKeyToken(token);
    await saveOwnerGrant(kv, {
      version: 1,
      id: "grant-exp",
      ownerUserId: ownerId,
      apiKeyHash: hash,
      providers: { serv: { maxCalls: 1, maxSpendUsd: null, note: "exp" } },
      expiresAt: "2000-01-01T00:00:00.000Z",
      provenance: "test:exp",
      createdAt: new Date().toISOString(),
    });
    // Persist expired grant by writing past saveOwnerGrant expiry filter in find —
    // save still stores; findActiveGrantsForKey skips; session path checks isGrantExpired.
    const minted = mintScoutSessionToken(
      { userId: ownerId, grantId: "grant-exp", keyHashPrefix: hash },
      paidEnv,
    );
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    const denied = await authorizeScoutStart(
      kv,
      { bearerToken: null, signedSession: minted.session },
      "http://localhost",
      { ...paidEnv, SCOUT_OWNER_USER_IDS: ownerId },
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.body.error).toMatch(/expired|invalid|revoked/i);
  });
});

describe("blocker (4): Scout nav matches runtime SCOUT_UI_ENABLED", () => {
  it("capabilities.uiEnabled follows runtime env (build-off / start-on model)", async () => {
    const off = await scoutCapabilities({ env: { SCOUT_UI_ENABLED: "false" } });
    expect(off.uiEnabled).toBe(false);
    expect(isScoutUiEnabled({ SCOUT_UI_ENABLED: "false" })).toBe(false);

    const on = await scoutCapabilities({ env: { SCOUT_UI_ENABLED: "true" } });
    expect(on.uiEnabled).toBe(true);
    expect(isScoutUiEnabled({ SCOUT_UI_ENABLED: "true" })).toBe(true);
  });

  it("Header discovers Scout via runtime GET /api/scout (not layout bake alone)", () => {
    const headerSrc = readFileSync(
      resolve(process.cwd(), "src/components/Header.tsx"),
      "utf8",
    );
    expect(headerSrc).toMatch(/fetch\(["']\/api\/scout["']\)/);
    expect(headerSrc).toMatch(/uiEnabled/);
    expect(headerSrc).toMatch(/scoutUiRuntime/);

    const layoutSrc = readFileSync(resolve(process.cwd(), "src/app/layout.tsx"), "utf8");
    // Layout may still pass a hint, but Header must not rely on it exclusively.
    expect(headerSrc).toMatch(/scoutUiRuntime \?\? scoutNavEnabled/);
    void layoutSrc;
  });
});
