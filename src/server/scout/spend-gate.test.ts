import { describe, expect, it } from "vitest";
import { authorizeScoutSpend, spendAuthFromEnv } from "./spend-gate";

describe("scout spend gate", () => {
  it("blocks when authorization is missing", () => {
    const result = authorizeScoutSpend(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("spend_not_authorized");
  });

  it("blocks when hard cap would breach $5 reserve", () => {
    const result = authorizeScoutSpend({
      verifiedBalanceUsd: 8,
      hardCapUsd: 4,
      minReserveUsd: 5,
      attestationId: "parent-test-1",
      attestedAt: "2026-11-06T20:00:00Z",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("insufficient_reserve");
  });

  it("allows when verified balance leaves reserve after hard cap", () => {
    const result = authorizeScoutSpend({
      verifiedBalanceUsd: 12,
      hardCapUsd: 2,
      minReserveUsd: 5,
      attestationId: "parent-test-2",
      attestedAt: "2026-11-06T20:00:00Z",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.authorizedSpendUsd).toBe(2);
  });

  it("rejects minReserve below $5", () => {
    const result = authorizeScoutSpend({
      verifiedBalanceUsd: 100,
      hardCapUsd: 1,
      minReserveUsd: 4,
      attestationId: "x",
      attestedAt: "2026-11-06T20:00:00Z",
    });
    expect(result.ok).toBe(false);
  });

  it("reads nothing from empty env", () => {
    expect(spendAuthFromEnv({})).toBeNull();
  });
});
