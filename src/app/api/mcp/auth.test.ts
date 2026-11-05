import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { creditBalance, creditGrant } from "@/io/credit-book";
import { getKv } from "@/io/kv";
import { createApiKey, revokeApiKey } from "@/server/api-keys";

const dir = mkdtempSync(path.join(tmpdir(), "af-agent-"));

beforeAll(() => {
  process.env.AUTOFLIP_DATA_DIR = dir;
});

function call(token: string | null, methodBody: Record<string, unknown>) {
  return fetchHandler(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(methodBody),
    }),
  );
}

async function fetchHandler(request: Request) {
  const { POST } = await import("./route");
  return POST(request);
}

describe("MCP API key", () => {
  it("rejects a revoked key", async () => {
    const kv = getKv();
    const created = await createApiKey(kv, "agent-user", "Cursor");
    await revokeApiKey(kv, "agent-user", created.record.id);
    const response = await call(created.token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "deal_radar", arguments: { make: "Toyota", model: "Camry" } },
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { data: { error: string } } };
    expect(body.error.data.error).toBe("invalid_key");
  });

  it("returns a buy-credits link and does not run a report when the balance is zero", async () => {
    const kv = getKv();
    const created = await createApiKey(kv, "broke-user", "Claude");
    const response = await call(created.token, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "full_report", arguments: { mode: "personal", vin: "NOTAVIN" } },
    });
    expect(response.status).toBe(402);
    const body = (await response.json()) as { result: { structuredContent: { error: string; buyCreditsUrl: string } } };
    expect(body.result.structuredContent.error).toBe("insufficient_credits");
    expect(body.result.structuredContent.buyCreditsUrl).toContain("/credits");
    expect(await creditBalance(kv, "broke-user")).toBe(0);
  });

  it("keeps deal_radar free for a valid key", async () => {
    const kv = getKv();
    await creditGrant(kv, "scan-user", 2, "seed-scan");
    const created = await createApiKey(kv, "scan-user", "Scan");
    const response = await call(created.token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "deal_radar", arguments: { make: "Toyota", model: "Camry", mode: "personal" } },
    });
    expect(response.status).toBe(200);
    expect(await creditBalance(kv, "scan-user")).toBe(2);
  });

  it("does not charge a credit when the VIN cannot be analyzed", async () => {
    const kv = getKv();
    await creditGrant(kv, "miss-user", 2, "seed-miss");
    const created = await createApiKey(kv, "miss-user", "Miss");
    const response = await call(created.token, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "full_report", arguments: { mode: "personal", vin: "1HGCM82673A123456" } },
    });
    const body = (await response.json()) as { result: { structuredContent: { error: string } } };
    expect(body.result.structuredContent.error).toBe("not_in_sample");
    expect(await creditBalance(kv, "miss-user")).toBe(2);
  });

  it("asks for an API key when none is sent", async () => {
    const response = await call(null, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "full_report", arguments: { mode: "personal", vin: "4T1KZ1AK4MU060006" } },
    });
    expect(response.status).toBe(402);
    const body = (await response.json()) as { result: { structuredContent: { error: string; buyCreditsUrl: string } } };
    expect(body.result.structuredContent.error).toBe("api_key_required");
    expect(body.result.structuredContent.buyCreditsUrl).toContain("/credits");
  });
});
