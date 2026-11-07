import { describe, expect, it } from "vitest";
import { authorizeScoutSpend, spendAuthFromEnv, serverPaidExecutionStatus } from "./spend-gate";

describe("scout spend gate (attestation rejected)", () => {
  it("rejects any client attestation object", () => {
    const result = authorizeScoutSpend({
      verifiedBalanceUsd: 100,
      hardCapUsd: 1,
      minReserveUsd: 5,
      attestationId: "should-not-work",
      attestedAt: "2026-11-06T20:00:00Z",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("client_attestation_rejected");
  });

  it("never reads balance attestation from env", () => {
    expect(
      spendAuthFromEnv({
        SCOUT_VERIFIED_BALANCE_USD: "100",
        SCOUT_SPEND_HARD_CAP_USD: "2",
        SCOUT_SPEND_ATTESTATION_ID: "x",
        SCOUT_SPEND_ATTESTED_AT: "2026-11-06T20:00:00Z",
      }),
    ).toBeNull();
  });

  it("reports paid execution disabled by default", () => {
    const status = serverPaidExecutionStatus({});
    expect(status.ok).toBe(false);
    if (!status.ok) expect(status.error).toBe("paid_execution_disabled");
  });
});
