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

  it("requires hard ceiling even when paid flag and key present", () => {
    const gate = authorizeLiveInventory({
      paidExecutionEnabled: true,
      hasAutodevKey: true,
      hasServKey: true,
      maxProviderCallsHardCeiling: null,
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.error).toBe("unverifiable_cap");
  });

  it("authorizes only with flag + key + positive ceiling", () => {
    const gate = authorizeLiveInventory({
      paidExecutionEnabled: true,
      hasAutodevKey: true,
      hasServKey: true,
      maxProviderCallsHardCeiling: 3,
    });
    expect(gate.ok).toBe(true);
    if (gate.ok) expect(gate.remainingProviderBudget).toBeGreaterThan(0);
  });

  it("strips client spend claims from bodies", () => {
    const cleaned = stripClientSpendClaims({
      mandate: { mode: "flip" },
      verifiedBalanceUsd: 99,
      hardCapUsd: 1,
      attestationId: "nope",
    });
    expect(cleaned.verifiedBalanceUsd).toBeUndefined();
    expect(cleaned.hardCapUsd).toBeUndefined();
    expect(cleaned.attestationId).toBeUndefined();
    expect(cleaned.mandate).toEqual({ mode: "flip" });
  });
});
