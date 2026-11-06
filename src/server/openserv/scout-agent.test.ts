import { describe, expect, it } from "vitest";
import {
  OPENSERV_REMOTE_PREREQUISITES,
  buildLemonlessScoutAgent,
  scoutCapabilityNames,
} from "./scout-agent";
import { executeScoutSafely } from "@/server/scout/safe-execute";

describe("OpenServ scout agent adapter (local)", () => {
  it("registers safety-checked capability names without starting HTTP server", () => {
    const agent = buildLemonlessScoutAgent({ apiKey: "test-local-only" });
    expect(scoutCapabilityNames()).toEqual([
      "scout_validate_mandate",
      "scout_run_bounded",
      "scout_describe_allowlist",
    ]);
    expect(agent).toBeTruthy();
    expect(OPENSERV_REMOTE_PREREQUISITES.length).toBeGreaterThan(0);
  });

  it("capability path uses shared safe-execute gates (disabled without SCOUT_ENABLED)", async () => {
    const denied = await executeScoutSafely({
      req: {
        ownerId: "sdk-owner",
        mandate: { mode: "flip", preferredMakes: ["Toyota"], zip: "72712", maxDistanceMiles: 100 },
        channel: "openserv_sdk",
      },
      kv: null,
      env: { SCOUT_ENABLED: "false" },
      autodevDeps: null,
    });
    expect(denied.ok).toBe(false);
  });

  it("runs bounded scout via safe-execute when enabled (fixture replay, not live)", async () => {
    const executed = await executeScoutSafely({
      req: {
        ownerId: "sdk-owner",
        mandate: {
          mode: "flip",
          preferredMakes: ["Toyota"],
          openToOtherMakes: false,
          zip: "72712",
          maxDistanceMiles: 400,
          targetProfitUsd: 500,
          repairAbility: "unknown",
          notes: null,
        },
        planner: "offline_heuristic",
        channel: "openserv_sdk",
        budgets: { maxProviderCalls: 0, maxCandidatesOut: 5, maxServCalls: 12 },
      },
      kv: null,
      env: { SCOUT_ENABLED: "true", SCOUT_PAID_EXECUTION: "false" },
      autodevDeps: null,
    });
    expect(executed.ok).toBe(true);
    if (!executed.ok) return;
    expect(executed.isFixture).toBe(true);
    expect(executed.inventoryMode).toBe("replay");
    expect(executed.result.investigation.every((c) => c.claimsSafeBuy === false)).toBe(true);
    expect(executed.result.investigation.every((c) => c.claimsVerifiedProfit === false)).toBe(true);
    expect(executed.result.investigation.every((c) => c.listing.source === "sample")).toBe(true);
  });

  it("preferLive cannot bypass paid-execution — stays fixture/replay", async () => {
    const executed = await executeScoutSafely({
      req: {
        ownerId: "sdk-owner",
        mandate: {
          mode: "flip",
          preferredMakes: ["Toyota"],
          zip: "72712",
          maxDistanceMiles: 100,
          notes: null,
        },
        preferLive: true,
        channel: "openserv_sdk",
      },
      kv: null,
      env: { SCOUT_ENABLED: "true", SCOUT_PAID_EXECUTION: "false" },
      autodevDeps: { fetch, apiKey: "fake-key-must-not-be-used" },
    });
    expect(executed.ok).toBe(true);
    if (!executed.ok) return;
    expect(executed.inventoryMode).toBe("replay");
    expect(executed.isFixture).toBe(true);
    expect(executed.paidBlockedReason).toMatch(/SCOUT_PAID_EXECUTION/i);
  });
});
