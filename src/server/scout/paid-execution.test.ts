import { describe, expect, it } from "vitest";
import { MemoryKv, UpstashKv } from "@/io/kv";
import {
  authorizeLiveInventory,
  readPaidExecutionConfig,
  stripClientSpendClaims,
  testPaidAuthorityStub,
} from "./paid-execution";

describe("paid execution server gate (Stage1)", () => {
  it("defaults paid execution off", () => {
    const cfg = readPaidExecutionConfig({});
    expect(cfg.paidExecutionEnabled).toBe(false);
    const gate = authorizeLiveInventory({ config: cfg, kv: new MemoryKv() });
    expect(gate.ok).toBe(false);
  });

  it("all flags + env fake balances + Upstash still cannot pay without non-env authority", async () => {
    const fetchImpl = async () => Response.json({ result: "OK" });
    const kv = new UpstashKv("https://upstash.test", "tok", fetchImpl as typeof fetch);
    const cfg = readPaidExecutionConfig({
      SCOUT_PAID_EXECUTION: "true",
      AUTODEV_API_KEY: "key",
      SERV_API_KEY: "serv",
      SCOUT_MAX_PROVIDER_CALLS_HARD_CEILING: "10",
      SCOUT_SERVER_VERIFIED_BALANCE_USD: "999",
      SCOUT_SERVER_SPEND_HARD_CAP_USD: "10",
      UPSTASH_REDIS_REST_URL: "https://upstash.test",
      UPSTASH_REDIS_REST_TOKEN: "tok",
    });
    expect(cfg.ignoredEnvBalanceUsd).toBe(999);
    expect(cfg.ignoredEnvSpendHardCapUsd).toBe(10);
    const gate = authorizeLiveInventory({ config: cfg, kv });
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.error).toBe("verified_reserve_unavailable");
      expect(gate.message).toMatch(/not a grant|owner_grant|unsigned af_uid|apiKeyHash/i);
      // Must not claim a reserve/spend guarantee while deliberately disabled.
      expect(gate.message).not.toMatch(/guarantee|authorizedSpend|live_authorized/i);
    }
  });

  it("Memory/File backend fails closed even with testAuthority (not distributed)", () => {
    const gate = authorizeLiveInventory({
      config: readPaidExecutionConfig({
        SCOUT_PAID_EXECUTION: "true",
        AUTODEV_API_KEY: "key",
        SCOUT_MAX_PROVIDER_CALLS_HARD_CEILING: "3",
      }),
      kv: new MemoryKv(),
      testAuthority: testPaidAuthorityStub(),
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.error).toBe("quota_backend_not_distributed");
  });

  it("testAuthority + Upstash backend can authorize (code injection only — not env)", async () => {
    const fetchImpl = async () => Response.json({ result: null });
    const kv = new UpstashKv("https://upstash.test", "tok", fetchImpl as typeof fetch);
    expect(kv.backend).toBe("upstash");
    const gate = authorizeLiveInventory({
      config: {
        paidExecutionEnabled: true,
        hasAutodevKey: true,
        hasServKey: true,
        maxProviderCallsHardCeiling: 3,
        storage: "upstash",
        ignoredEnvBalanceUsd: 999,
        ignoredEnvSpendHardCapUsd: 10,
      },
      kv,
      testAuthority: testPaidAuthorityStub({ remainingProviderBudget: 2, authorizedSpendUsd: 1 }),
    });
    expect(gate.ok).toBe(true);
    if (gate.ok) {
      expect(gate.remainingProviderBudget).toBe(2);
      expect(gate.authorizedSpendUsd).toBe(1);
    }
  });

  it("strips client spend, budget, and testAuthority fields", () => {
    const cleaned = stripClientSpendClaims({
      mandate: { mode: "flip" },
      verifiedBalanceUsd: 99,
      budgets: { maxProviderCalls: 999 },
      maxProviderCalls: 50,
      testAuthority: { kind: "test_stub" },
      SCOUT_SERVER_VERIFIED_BALANCE_USD: "100",
    });
    expect(cleaned.verifiedBalanceUsd).toBeUndefined();
    expect(cleaned.budgets).toBeUndefined();
    expect(cleaned.maxProviderCalls).toBeUndefined();
    expect(cleaned.testAuthority).toBeUndefined();
    expect(cleaned.SCOUT_SERVER_VERIFIED_BALANCE_USD).toBeUndefined();
    expect(cleaned.mandate).toEqual({ mode: "flip" });
  });
});
