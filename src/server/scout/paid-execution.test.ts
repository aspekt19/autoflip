import { describe, expect, it } from "vitest";
import {
  authorizeLiveInventory,
  readPaidExecutionConfig,
  stripClientSpendClaims,
} from "./paid-execution";

describe("paid execution server gate", () => {
  it("defaults paid execution off", () => {
    const cfg = readPaidExecutionConfig({});
    expect(cfg.paidExecutionEnabled).toBe(false);
    const gate = authorizeLiveInventory(cfg);
    expect(gate.ok).toBe(false);
  });

  it("fail-closes when flag+key+ceiling set but verified reserve missing", () => {
    const gate = authorizeLiveInventory({
      paidExecutionEnabled: true,
      hasAutodevKey: true,
      hasServKey: true,
      maxProviderCallsHardCeiling: 3,
      verifiedBalanceUsd: null,
      spendHardCapUsd: null,
      storage: "upstash",
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.error).toBe("verified_reserve_unavailable");
  });

  it("fail-closes when reserve would breach $5", () => {
    const gate = authorizeLiveInventory({
      paidExecutionEnabled: true,
      hasAutodevKey: true,
      hasServKey: true,
      maxProviderCallsHardCeiling: 3,
      verifiedBalanceUsd: 6,
      spendHardCapUsd: 2,
      storage: "upstash",
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.error).toBe("insufficient_reserve");
  });

  it("fail-closes without distributed quota backend even with verified reserve", () => {
    const gate = authorizeLiveInventory({
      paidExecutionEnabled: true,
      hasAutodevKey: true,
      hasServKey: true,
      maxProviderCallsHardCeiling: 3,
      verifiedBalanceUsd: 20,
      spendHardCapUsd: 2,
      storage: "file",
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.error).toBe("quota_backend_not_distributed");
  });

  it("authorizes only with flag + key + ceiling + verified reserve + upstash", () => {
    const gate = authorizeLiveInventory({
      paidExecutionEnabled: true,
      hasAutodevKey: true,
      hasServKey: true,
      maxProviderCallsHardCeiling: 3,
      verifiedBalanceUsd: 20,
      spendHardCapUsd: 2,
      storage: "upstash",
    });
    expect(gate.ok).toBe(true);
  });

  it("strips client spend and budget expansion claims", () => {
    const cleaned = stripClientSpendClaims({
      mandate: { mode: "flip" },
      verifiedBalanceUsd: 99,
      budgets: { maxProviderCalls: 999 },
      maxProviderCalls: 50,
    });
    expect(cleaned.verifiedBalanceUsd).toBeUndefined();
    expect(cleaned.budgets).toBeUndefined();
    expect(cleaned.maxProviderCalls).toBeUndefined();
    expect(cleaned.mandate).toEqual({ mode: "flip" });
  });
});
