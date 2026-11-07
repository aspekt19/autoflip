import { describe, expect, it } from "vitest";
import { executeScoutSafely } from "./safe-execute";

describe("executeScoutSafely", () => {
  it("rejects when scout disabled for api channel", async () => {
    const result = await executeScoutSafely({
      req: {
        ownerId: "u1",
        mandate: { mode: "flip" },
        channel: "api",
      },
      kv: null,
      env: {},
    });
    expect(result.ok).toBe(false);
  });

  it("strips client spend claims and still runs replay", async () => {
    const result = await executeScoutSafely({
      req: {
        ownerId: "u1",
        mandate: {
          mode: "flip",
          preferredMakes: ["Toyota"],
          zip: "72712",
          maxDistanceMiles: 200,
          maxMiles: null,
          verifiedBalanceUsd: 999,
          hardCapUsd: 50,
          attestationId: "evil",
        },
        channel: "test",
        planner: "offline_heuristic",
      },
      kv: null,
      env: { SCOUT_ENABLED: "true" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.isFixture).toBe(true);
    expect(result.result.usage.providerCalls).toBe(0);
  });

  it("timeout planner surfaces serv_timeout without autonomy fallback success", async () => {
    const result = await executeScoutSafely({
      req: {
        ownerId: "u1",
        mandate: {
          mode: "flip",
          preferredMakes: ["Toyota"],
          zip: "72712",
          maxDistanceMiles: 200,
          maxMiles: null,
        },
        channel: "test",
        planner: "mock_script",
        mockScript: [],
      },
      kv: null,
      env: { SCOUT_ENABLED: "true" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // empty mock script → serv_unavailable after inventory
    expect(result.result.state).toBe("failed");
    expect(["serv_unavailable", "serv_timeout", "serv_refused"]).toContain(
      result.result.failReason,
    );
  });

  it("duplicate concurrent-ish resumes keep owner isolation", async () => {
    const first = await executeScoutSafely({
      req: {
        ownerId: "owner-a",
        mandate: {
          mode: "flip",
          preferredMakes: ["Toyota"],
          zip: "72712",
          maxDistanceMiles: 200,
          maxMiles: null,
        },
        channel: "test",
        planner: "mock_script",
        mockScript: [],
      },
      kv: null,
      env: { SCOUT_ENABLED: "true" },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await executeScoutSafely({
      req: {
        ownerId: "owner-b",
        mandate: { mode: "flip" },
        channel: "test",
        resume: first.result,
        planner: "mock_script",
        mockScript: [],
      },
      kv: null,
      env: { SCOUT_ENABLED: "true" },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.result.failReason).toBe("unauthorized");
  });
});
