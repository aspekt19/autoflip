import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKv } from "@/io/kv";
import {
  createApiKey,
  hashApiKeyToken,
  listApiKeyBindings,
  resolveActiveApiKeyByHash,
  revokeApiKey,
} from "@/server/api-keys";

const kvBox: { current: MemoryKv } = { current: new MemoryKv() };

vi.mock("@/io/kv", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/io/kv")>();
  return {
    ...actual,
    getKv: () => kvBox.current,
    isDistributedQuotaBackend: () => true,
  };
});

import { POST as postOwnerGrant } from "@/app/api/scout/owner-grant/route";
import { GET as getBinding } from "@/app/api/scout/binding/route";

describe("owner binding metadata + grant verification", () => {
  const admin = "test-admin-token-32chars-min";

  beforeEach(() => {
    process.env.SCOUT_OWNER_GRANT_ADMIN_TOKEN = admin;
    kvBox.current = new MemoryKv();
  });

  afterEach(() => {
    delete process.env.SCOUT_OWNER_GRANT_ADMIN_TOKEN;
  });

  it("createApiKey returns non-secret binding without embedding af_ token", async () => {
    const kv = kvBox.current;
    const created = await createApiKey(kv, "owner-uuid-1", "Scout");
    expect(created.token.startsWith("af_")).toBe(true);
    expect(created.binding.userId).toBe("owner-uuid-1");
    expect(created.binding.apiKeyHash).toBe(hashApiKeyToken(created.token));
    expect(created.binding.apiKeyHash).not.toContain(created.token);
    expect(JSON.stringify(created.binding)).not.toContain(created.token);

    const listed = await listApiKeyBindings(kv, "owner-uuid-1");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.apiKeyHash).toBe(created.binding.apiKeyHash);
  });

  it("GET /api/scout/binding with Bearer returns binding without grant and without token", async () => {
    const created = await createApiKey(kvBox.current, "owner-uuid-2", "Scout");
    const res = await getBinding(
      new Request("http://localhost/api/scout/binding", {
        headers: { Authorization: `Bearer ${created.token}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { binding: { userId: string; apiKeyHash: string } };
    expect(body.binding.userId).toBe("owner-uuid-2");
    expect(body.binding.apiKeyHash).toBe(created.binding.apiKeyHash);
    const text = JSON.stringify(body);
    expect(text).not.toContain(created.token);
    expect(text).not.toMatch(/"token"/);
  });

  it("grant issuance verifies active key and matching ownerUserId", async () => {
    const created = await createApiKey(kvBox.current, "owner-uuid-3", "Scout");

    const badHash = await postOwnerGrant(
      new Request("http://localhost/api/scout/owner-grant", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-scout-grant-admin": admin,
        },
        body: JSON.stringify({
          ownerUserId: "owner-uuid-3",
          apiKeyHash: "f".repeat(64),
          providers: { serv: { maxCalls: 2 } },
        }),
      }),
    );
    expect(badHash.status).toBe(400);
    expect(((await badHash.json()) as { error: string }).error).toBe("key_inactive");

    const mismatch = await postOwnerGrant(
      new Request("http://localhost/api/scout/owner-grant", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-scout-grant-admin": admin,
        },
        body: JSON.stringify({
          ownerUserId: "someone-else",
          apiKeyHash: created.binding.apiKeyHash,
          providers: { serv: { maxCalls: 2 } },
        }),
      }),
    );
    expect(mismatch.status).toBe(400);
    expect(((await mismatch.json()) as { error: string }).error).toBe("owner_mismatch");

    const ok = await postOwnerGrant(
      new Request("http://localhost/api/scout/owner-grant", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-scout-grant-admin": admin,
        },
        body: JSON.stringify({
          ownerUserId: "owner-uuid-3",
          apiKeyHash: created.binding.apiKeyHash,
          providers: { serv: { maxCalls: 3 }, autodev: { maxCalls: 1 } },
        }),
      }),
    );
    expect(ok.status).toBe(200);
    const granted = (await ok.json()) as {
      ok: boolean;
      grant: { bindingVerified: boolean; ownerUserId: string };
      operatorTrust: string;
    };
    expect(granted.ok).toBe(true);
    expect(granted.grant.bindingVerified).toBe(true);
    expect(granted.grant.ownerUserId).toBe("owner-uuid-3");
    expect(granted.operatorTrust).toMatch(/out-of-band/i);
  });

  it("revoked key fails resolveActiveApiKeyByHash and blocks grant", async () => {
    const kv = kvBox.current;
    const created = await createApiKey(kv, "owner-uuid-4", "Scout");
    await revokeApiKey(kv, "owner-uuid-4", created.record.id);
    expect(await resolveActiveApiKeyByHash(kv, created.binding.apiKeyHash)).toBeNull();

    const res = await postOwnerGrant(
      new Request("http://localhost/api/scout/owner-grant", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-scout-grant-admin": admin,
        },
        body: JSON.stringify({
          ownerUserId: "owner-uuid-4",
          apiKeyHash: created.binding.apiKeyHash,
          providers: { serv: { maxCalls: 1 } },
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("key_inactive");
  });
});
