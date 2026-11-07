import { describe, expect, it, vi } from "vitest";
import { UpstashKv } from "@/io/kv";
import { createApiKey, hashApiKeyToken } from "@/server/api-keys";
import { authorizeScoutStart } from "./access";
import { saveOwnerGrant } from "./owner-grant";
import { resolveOwnerSpendAuthority } from "./owner-authority";
import { mintScoutSessionToken, verifyScoutSessionToken } from "./signed-session";

function upstashKv(store: Map<string, string> = new Map()) {
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const args = JSON.parse(String(init?.body)) as string[];
    if (args[0] === "GET") return Response.json({ result: store.get(args[1]!) ?? null });
    if (args[0] === "SET") {
      store.set(args[1]!, args[2]!);
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
  return new UpstashKv("https://upstash.test", "tok", fetchImpl as typeof fetch);
}

describe("security negatives: unsigned af_uid cannot inherit owner privileges", () => {
  it("forged allowlisted UUID + freshly minted af_ key cannot open live authority", async () => {
    const kv = upstashKv();
    const forgedOwner = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    // Attacker mints a key as if unsigned af_uid == allowlisted UUID
    const { token } = await createApiKey(kv, forgedOwner, "forged");
    const hash = hashApiKeyToken(token);

    // Real grant exists for the same userId but a DIFFERENT key hash (operator-bound)
    await saveOwnerGrant(kv, {
      version: 1,
      id: "real-grant",
      ownerUserId: forgedOwner,
      apiKeyHash: "d".repeat(64),
      providers: { serv: { maxCalls: 3, maxSpendUsd: null, note: "real" } },
      expiresAt: null,
      provenance: "admin:real",
      createdAt: new Date().toISOString(),
    });

    const env = {
      SCOUT_ENABLED: "true",
      SCOUT_PAID_EXECUTION: "true",
      AUTODEV_API_KEY: "k",
      SERV_API_KEY: "s",
      SCOUT_MAX_PROVIDER_CALLS_HARD_CEILING: "5",
      SCOUT_OWNER_USER_IDS: forgedOwner,
    };

    const access = await authorizeScoutStart(kv, { bearerToken: token }, "http://localhost", env);
    expect(access.ok).toBe(true); // start fixture may be allowed for allowlisted user

    const live = await resolveOwnerSpendAuthority({
      kv,
      ownerId: forgedOwner,
      apiKeyHash: hash,
      provider: "serv",
      env,
    });
    expect(live.ok).toBe(false);
    if (!live.ok) expect(live.reason).toMatch(/No active owner grant bound to this af_ key/i);
  });

  it("HMAC session rejects tampered payload", () => {
    const env = { SCOUT_SESSION_SECRET: "test-secret-at-least-16" };
    const minted = mintScoutSessionToken(
      { userId: "u1", grantId: "g1", keyHashPrefix: "abcd" },
      env,
    );
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    const [payload, sig] = minted.token.split(".");
    const tampered = `${payload!.slice(0, -2)}xx.${sig}`;
    const verified = verifyScoutSessionToken(tampered, env);
    expect(verified.ok).toBe(false);
  });

  it("scout start without bearer or signed session is denied (unsigned cookie irrelevant)", async () => {
    const kv = upstashKv();
    const denied = await authorizeScoutStart(
      kv,
      { bearerToken: null, signedSession: null },
      "http://localhost",
      { SCOUT_ENABLED: "true" },
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.body.error).toBe("scout_auth_required");
  });
});
