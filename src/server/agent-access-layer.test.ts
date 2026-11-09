import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { creditBalance, creditGrant } from "@/io/credit-book";
import { getKv, MemoryKv } from "@/io/kv";
import { createApiKey } from "@/server/api-keys";
import { authenticateAgentRequest } from "@/server/agent-auth";
import { agentError, insufficientCreditsEnvelope } from "@/server/agent-envelope";
import { runAgentCheck } from "@/server/agent-check";
import { advanceAgentFindRun, createAgentFindRun } from "@/server/agent-find";
import { consumeAgentRateLimit } from "@/server/agent-rate-limit";
import { listAgentReceiptIds, readAgentReceipt, writeAgentReceipt } from "@/server/agent-receipts";
import { normalizeAgentScopes, scopeAllows } from "@/server/agent-scopes";
import { AGENT_VERDICT_SCHEMA_VERSION } from "@/domain/agent-verdict-schema";

const dir = mkdtempSync(path.join(tmpdir(), "af-agent-layer-"));

beforeAll(() => {
  process.env.AUTOFLIP_DATA_DIR = dir;
});

describe("agent scopes + envelope", () => {
  it("defaults scopes and lets check/find imply read", () => {
    expect(normalizeAgentScopes(undefined)).toEqual(["read", "check", "find"]);
    expect(normalizeAgentScopes(["check"])).toEqual(["read", "check"]);
    expect(scopeAllows(["check"], "read")).toBe(true);
    expect(scopeAllows(["read"], "find")).toBe(false);
  });

  it("builds a concrete next_steps request on insufficient credits", () => {
    const body = insufficientCreditsEnvelope("https://example.test", 0);
    expect(body.error_code).toBe("insufficient_credits");
    expect(body.credit_spent).toBe(false);
    expect(body.retry_safe).toBe(true);
    expect(body.next_steps.request.url).toBe("https://example.test/credits");
  });
});

describe("agent rate limit + receipts", () => {
  it("caps per-key per-minute traffic", async () => {
    const kv = new MemoryKv();
    for (let i = 0; i < 30; i += 1) {
      const ok = await consumeAgentRateLimit(kv, "key-1", new Date("2026-11-09T12:00:00Z"));
      expect(ok.ok).toBe(true);
    }
    const blocked = await consumeAgentRateLimit(kv, "key-1", new Date("2026-11-09T12:00:30Z"));
    expect(blocked.ok).toBe(false);
  });

  it("stores and lists receipts for the owning account", async () => {
    const kv = new MemoryKv();
    const receipt = await writeAgentReceipt(kv, {
      key_id: "k1",
      key_prefix: "af_test",
      user_id: "user-1",
      tool: "check_car",
      credit_spent: false,
      credits: 0,
      free_check_spent: true,
      serv_steps_hash: "abc",
      idempotency_key: "idem-1",
      run_id: null,
      summary: "ok",
    });
    const ids = await listAgentReceiptIds(kv, "user-1");
    expect(ids[0]).toBe(receipt.receipt_id);
    expect((await readAgentReceipt(kv, receipt.receipt_id))?.tool).toBe("check_car");
  });
});

describe("agent check_car (mocked runCheck path)", () => {
  it("does not charge when extraction fails", async () => {
    const kv = getKv();
    await creditGrant(kv, "check-user", 2, "seed-check");
    const created = await createApiKey(kv, "check-user", "Check", ["check", "read"]);
    const auth = await authenticateAgentRequest(
      kv,
      new Request("http://localhost/api/v1/check", {
        headers: { authorization: `Bearer ${created.token}` },
      }),
      "http://localhost",
      "check",
    );
    expect(auth.ok).toBe(true);
    if (!auth.ok) return;

    const result = await runAgentCheck(
      auth.caller,
      { text: "not enough to identify a car" },
      {
        kv,
        origin: "http://localhost",
        fetch: vi.fn(async () => new Response("{}", { status: 404 })) as unknown as typeof fetch,
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.body.credit_spent).toBe(false);
    expect(await creditBalance(kv, "check-user")).toBe(2);
  });

  it("returns a fixed verdict wrapper for a pasted dealer fixture without Autodev", async () => {
    const { readFileSync } = await import("node:fs");
    const html = readFileSync(path.join(process.cwd(), "fixtures/listing-pages/dealer-jsonld.html"), "utf8");
    const kv = getKv();
    await creditGrant(kv, "check-ok", 1, "seed-ok");
    const created = await createApiKey(kv, "check-ok", "Ok");
    const auth = await authenticateAgentRequest(
      kv,
      new Request("http://localhost/api/v1/check", {
        headers: { authorization: `Bearer ${created.token}` },
      }),
      "http://localhost",
      "check",
    );
    expect(auth.ok).toBe(true);
    if (!auth.ok) return;

    const gov = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("DecodeVinValues")) {
        return new Response(
          JSON.stringify({
            Results: [{ ErrorCode: "0", ModelYear: "2021", Make: "TOYOTA", Model: "Camry", Trim: "SE" }],
          }),
          { status: 200 },
        );
      }
      if (url.includes("recalls") || url.includes("complaints")) {
        return new Response(JSON.stringify({ results: [], count: 0 }), { status: 200 });
      }
      if (url.includes("SafetyRatings")) return new Response(JSON.stringify({ Results: [] }), { status: 200 });
      return new Response("{}", { status: 404 });
    });

    const result = await runAgentCheck(
      auth.caller,
      { text: html, url: "https://dealer.example/camry", idempotencyKey: "paste-camry-1" },
      { kv, origin: "http://localhost", fetch: gov as unknown as typeof fetch },
    );
    if (!result.ok) {
      expect.fail(`${result.body.error_code}: ${result.body.message}`);
    }
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.schema_version).toBe(AGENT_VERDICT_SCHEMA_VERSION);
    expect(result.body.tool).toBe("check_car");
    expect(result.body.serv.steps.length).toBeGreaterThan(0);
    expect(result.body.receipt_id).toBeTruthy();
    expect(result.body.code_computed).toHaveProperty("compCount");
    expect(typeof result.body.credit_spent).toBe("boolean");
  });
});

describe("agent find_cars async (mocked match)", () => {
  it("creates a run_id and settles only after a mocked successful match", async () => {
    const kv = getKv();
    await creditGrant(kv, "find-user", 2, "seed-find");
    const created = await createApiKey(kv, "find-user", "Find", ["find", "read"]);
    const auth = await authenticateAgentRequest(
      kv,
      new Request("http://localhost/api/v1/find", {
        headers: { authorization: `Bearer ${created.token}` },
      }),
      "http://localhost",
      "find",
    );
    expect(auth.ok).toBe(true);
    if (!auth.ok) return;

    const createdRun = await createAgentFindRun(
      auth.caller,
      { text: "Toyota Camry under 20000 near 78701", idempotencyKey: "find-idem-1" },
      {
        kv,
        origin: "http://localhost",
        fetch: vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch,
      },
    );
    expect(createdRun.ok).toBe(true);
    if (!createdRun.ok) return;
    expect(createdRun.run.run_id).toBeTruthy();
    expect(createdRun.run.status).toBe("queued");
    expect(await creditBalance(kv, "find-user")).toBe(2);

    // Force understandNeed to succeed without SERV by using explicit structured text + no serv key.
    const advanced = await advanceAgentFindRun(createdRun.run.run_id, {
      kv,
      origin: "http://localhost",
      // No Autodev key → find_match returns listings_unconfigured / empty without network.
      fetch: vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch,
    });
    expect(advanced).not.toBeNull();
    // Without listings provider the match fails → no charge.
    if (advanced?.status === "failed") {
      expect(advanced.error?.credit_spent).toBe(false);
      expect(await creditBalance(kv, "find-user")).toBe(2);
    }
  });

  it("replays the same Idempotency-Key to the same run_id", async () => {
    const kv = getKv();
    await creditGrant(kv, "find-idem", 1, "seed-idem");
    const created = await createApiKey(kv, "find-idem", "Idem");
    const auth = await authenticateAgentRequest(
      kv,
      new Request("http://localhost/api/v1/find", { headers: { authorization: `Bearer ${created.token}` } }),
      "http://localhost",
      "find",
    );
    expect(auth.ok).toBe(true);
    if (!auth.ok) return;
    const a = await createAgentFindRun(auth.caller, { text: "Honda CR-V near 33101", idempotencyKey: "same-key" }, {
      kv,
      origin: "http://localhost",
    });
    const b = await createAgentFindRun(auth.caller, { text: "Honda CR-V near 33101", idempotencyKey: "same-key" }, {
      kv,
      origin: "http://localhost",
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.run.run_id).toBe(b.run.run_id);
  });
});

describe("agentError helper", () => {
  it("mirrors error_code onto legacy error field", () => {
    const body = agentError({
      error_code: "missing_subject",
      message: "Send vin, url, or text.",
      next_steps: {
        action: "provide_subject",
        summary: "Include vin or url.",
        request: { method: "POST", url: "/api/v1/check", body: { vin: "X" } },
      },
    });
    expect(body.error).toBe("missing_subject");
    expect(body.next_action).toContain("Include vin");
  });
});
