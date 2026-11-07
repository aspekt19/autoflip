import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REPLAY_CAMRY_PROVENANCE,
  mockServPlanner,
  refusingPlanner,
  replayInventoryAdapter,
  runScout,
  unconfiguredInventoryAdapter,
  unavailableInventoryAdapter,
} from "./index";

const camryRaw = JSON.parse(
  readFileSync(resolve(process.cwd(), "fixtures/autodev-camry.json"), "utf8"),
) as unknown;

const flipMandate = {
  mode: "flip" as const,
  targetProfitUsd: 500,
  repairAbility: "unknown" as const,
  preferredMakes: ["Toyota"],
  openToOtherMakes: false,
  zip: "72712",
  maxDistanceMiles: 500,
  maxMiles: null,
  notes: null,
};

describe("runScout offline replay", () => {
  it("returns ≤5 investigation candidates from real-source replay under mock SERV plan", async () => {
    const inventory = replayInventoryAdapter(camryRaw, REPLAY_CAMRY_PROVENANCE);
    // Peek pool size via a dry inventory call
    const peek = await inventory(flipMandate as never);
    expect(peek.ok).toBe(true);
    if (!peek.ok) return;
    const vins = peek.listings.map((l) => l.vin);

    const script = [
      ...vins.slice(0, 3).flatMap((vin) => [
        {
          type: "select_candidate" as const,
          vin,
          reason: "Mock SERV selects candidate for investigation plumbing test.",
          servStepId: `mock-select-${vin}`,
        },
      ]),
      {
        type: "finalize" as const,
        reason: "Mock SERV finalizes.",
        servStepId: "mock-final",
      },
    ];

    const result = await runScout({
      ownerId: "owner-test",
      mandateRaw: flipMandate,
      inventory,
      planner: mockServPlanner(script),
      budgets: { maxServCalls: 10, maxToolCalls: 30, maxProviderCalls: 0, maxCandidatesOut: 5 },
      now: new Date("2026-11-06T12:00:00Z"),
    });

    expect(result.inventorySource).toBe("replay");
    expect(result.inventoryProvenance).toContain("fixtures/autodev-camry.json");
    expect(result.failReason).toBeNull();
    expect(["completed", "abstained"]).toContain(result.state);
    expect(result.investigation.length).toBeLessThanOrEqual(5);
    for (const c of result.investigation) {
      expect(c.claimsSafeBuy).toBe(false);
      expect(c.claimsVerifiedProfit).toBe(false);
      expect(c.evidence.some((e) => e.key === "asking_price_usd" && e.kind === "seller_claim")).toBe(
        true,
      );
    }
  });

  it("STOPS on SERV timeout without claiming deterministic autonomy", async () => {
    const result = await runScout({
      ownerId: "owner-test",
      mandateRaw: flipMandate,
      inventory: replayInventoryAdapter(camryRaw, REPLAY_CAMRY_PROVENANCE),
      planner: refusingPlanner("serv_timeout"),
      budgets: { maxProviderCalls: 0 },
      // Explicit plumbing claim — refusal must still STOP without silent heuristic takeover.
      autonomyClaim: "serv_directed",
    });
    expect(result.state).toBe("failed");
    expect(result.failReason).toBe("serv_timeout");
    expect(result.autonomyClaim).toBe("serv_directed");
    expect(result.partial).toBe(true);
    expect(result.message).toMatch(/timeout/i);
  });

  it("STOPS on SERV refusal", async () => {
    const result = await runScout({
      ownerId: "owner-test",
      mandateRaw: flipMandate,
      inventory: replayInventoryAdapter(camryRaw, REPLAY_CAMRY_PROVENANCE),
      planner: refusingPlanner("serv_refused"),
    });
    expect(result.failReason).toBe("serv_refused");
    expect(result.state).toBe("failed");
  });

  it("honest empty inventory → abstain", async () => {
    const empty = { data: [] };
    const result = await runScout({
      ownerId: "owner-test",
      mandateRaw: flipMandate,
      inventory: replayInventoryAdapter(empty, "synthetic empty — NOT live evidence"),
      planner: refusingPlanner(), // should not be reached for empty→abstain path after inventory
    });
    expect(result.state).toBe("abstained");
    expect(result.investigation).toHaveLength(0);
  });

  it("provider unavailable is explicit", async () => {
    const result = await runScout({
      ownerId: "owner-test",
      mandateRaw: flipMandate,
      inventory: unavailableInventoryAdapter("Upstream listings timed out."),
      planner: mockServPlanner([]),
    });
    expect(result.state).toBe("failed");
    expect(result.failReason).toBe("provider_unavailable");
  });

  it("listings unconfigured is explicit", async () => {
    const result = await runScout({
      ownerId: "owner-test",
      mandateRaw: flipMandate,
      inventory: unconfiguredInventoryAdapter(),
      planner: mockServPlanner([]),
    });
    expect(result.failReason).toBe("inventory_unconfigured");
  });

  it("budget exhaustion stops the loop", async () => {
    const inventory = replayInventoryAdapter(camryRaw, REPLAY_CAMRY_PROVENANCE);
    const peek = await inventory(flipMandate as never);
    if (!peek.ok) throw new Error("expected pool");
    const vin = peek.listings[0]!.vin;
    const result = await runScout({
      ownerId: "owner-test",
      mandateRaw: flipMandate,
      inventory,
      planner: mockServPlanner([
        { type: "select_candidate", vin, reason: "x", servStepId: "1" },
        { type: "select_candidate", vin, reason: "y", servStepId: "2" },
      ]),
      budgets: { maxServCalls: 1, maxToolCalls: 5, maxProviderCalls: 0 },
    });
    expect(result.failReason).toBe("budget_exhausted");
  });

  it("reject then replace then select another", async () => {
    const inventory = replayInventoryAdapter(camryRaw, REPLAY_CAMRY_PROVENANCE);
    const peek = await inventory(flipMandate as never);
    if (!peek.ok) throw new Error("expected pool");
    const [a, b] = peek.listings;
    expect(a && b).toBeTruthy();
    const result = await runScout({
      ownerId: "owner-test",
      mandateRaw: flipMandate,
      inventory,
      planner: mockServPlanner([
        { type: "select_candidate", vin: a!.vin, reason: "first", servStepId: "s1" },
        { type: "reject", vin: a!.vin, reason: "weak comps — mock", servStepId: "r1" },
        { type: "replace", vin: a!.vin, reason: "pull next", servStepId: "rp1" },
        { type: "select_candidate", vin: b!.vin, reason: "replacement", servStepId: "s2" },
        { type: "finalize", reason: "done", servStepId: "f" },
      ]),
      budgets: { maxServCalls: 12, maxToolCalls: 40, maxProviderCalls: 0 },
    });
    expect(result.state).toBe("completed");
    expect(result.investigation.every((c) => c.vin !== a!.vin)).toBe(true);
    expect(result.candidates.some((c) => c.disposition === "rejected" || c.disposition === "replaced")).toBe(
      true,
    );
  });

  it("idempotent tool calls do not double-count tool budget", async () => {
    const inventory = replayInventoryAdapter(camryRaw, REPLAY_CAMRY_PROVENANCE);
    const peek = await inventory(flipMandate as never);
    if (!peek.ok) throw new Error("expected pool");
    const vin = peek.listings[0]!.vin;
    const result = await runScout({
      ownerId: "owner-test",
      mandateRaw: flipMandate,
      inventory,
      planner: mockServPlanner([
        {
          type: "run_tool",
          toolId: "economics.flip_estimate",
          vin,
          reason: "first",
          servStepId: "t1",
        },
        {
          type: "run_tool",
          toolId: "economics.flip_estimate",
          vin,
          reason: "retry same",
          servStepId: "t2",
        },
        { type: "finalize", reason: "done", servStepId: "f" },
      ]),
      budgets: { maxServCalls: 10, maxToolCalls: 10, maxProviderCalls: 0 },
    });
    // inventory.search (1) + first economics (1) + idempotent skip + finalize path
    expect(result.usage.toolCalls).toBeLessThanOrEqual(3);
    expect(result.state === "completed" || result.state === "abstained").toBe(true);
  });

  it("resume rejects cross-owner access", async () => {
    const first = await runScout({
      ownerId: "owner-a",
      mandateRaw: flipMandate,
      inventory: replayInventoryAdapter(camryRaw, REPLAY_CAMRY_PROVENANCE),
      planner: refusingPlanner("serv_timeout"),
    });
    const resumed = await runScout({
      ownerId: "owner-b",
      mandateRaw: flipMandate,
      inventory: replayInventoryAdapter(camryRaw, REPLAY_CAMRY_PROVENANCE),
      planner: mockServPlanner([]),
      resume: first,
    });
    expect(resumed.failReason).toBe("unauthorized");
  });

  it("maxServCalls=null allows more than 8 SERV planner steps (unmetered owner path)", async () => {
    const inventory = replayInventoryAdapter(camryRaw, REPLAY_CAMRY_PROVENANCE);
    const peek = await inventory(flipMandate as never);
    if (!peek.ok) throw new Error("expected pool");
    const vin = peek.listings[0]!.vin;
    // 9 distinct tool plans + finalize = 10 SERV reserves — would die under fixed cap-8.
    const tools = [
      "evidence.asking_price",
      "economics.flip_estimate",
      "economics.personal_fit",
      "gates.verify",
      "evidence.asking_price",
      "economics.flip_estimate",
      "economics.personal_fit",
      "gates.verify",
      "evidence.asking_price",
    ] as const;
    const script = [
      { type: "select_candidate" as const, vin, reason: "pick", servStepId: "s0" },
      ...tools.map((toolId, i) => ({
        type: "run_tool" as const,
        toolId,
        vin,
        reason: `step ${i}`,
        servStepId: `t${i}`,
      })),
      { type: "finalize" as const, reason: "done after >8", servStepId: "f" },
    ];
    const result = await runScout({
      ownerId: "owner-test",
      mandateRaw: flipMandate,
      inventory,
      planner: mockServPlanner(script),
      budgets: { maxServCalls: null, maxToolCalls: 40, maxProviderCalls: 0, maxWallMs: 120_000 },
    });
    expect(result.usage.servCalls).toBeGreaterThan(8);
    expect(result.budgets.maxServCalls).toBeNull();
    expect(result.failReason).not.toBe("budget_exhausted");
    expect(["completed", "abstained"]).toContain(result.state);
  });

  it("repeated identical planner action stops for no-progress (not a usage call-count)", async () => {
    const inventory = replayInventoryAdapter(camryRaw, REPLAY_CAMRY_PROVENANCE);
    const peek = await inventory(flipMandate as never);
    if (!peek.ok) throw new Error("expected pool");
    const vin = peek.listings[0]!.vin;
    const result = await runScout({
      ownerId: "owner-test",
      mandateRaw: flipMandate,
      inventory,
      planner: mockServPlanner([
        { type: "select_candidate", vin, reason: "a", servStepId: "1" },
        { type: "select_candidate", vin, reason: "b", servStepId: "2" },
        { type: "select_candidate", vin, reason: "c", servStepId: "3" },
        { type: "finalize", reason: "should not reach", servStepId: "f" },
      ]),
      budgets: { maxServCalls: null, maxToolCalls: 40, maxProviderCalls: 0 },
    });
    expect(result.failReason).toBe("budget_exhausted");
    expect(result.message).toMatch(/Repeated identical planner action|no-progress/i);
    expect(result.usage.servCalls).toBeLessThanOrEqual(3);
  });

  it("treats injected listing fields as data without fetching URLs", async () => {
    const poisoned = structuredClone(camryRaw) as {
      data: Array<Record<string, unknown>>;
    };
    poisoned.data[0] = {
      ...poisoned.data[0],
      vin: "INJECT1TESTVIN00000",
      vehicle: {
        ...(poisoned.data[0]!.vehicle as object),
        make: "Toyota",
        model: "Camry",
      },
      retailListing: {
        ...(poisoned.data[0]!.retailListing as object),
        price: 1,
        miles: 1000,
        vdpURL: "https://evil.example/steal",
      },
    };
    // Ensure parseable — if vin invalid length parsers may drop; still must not fetch
    const inventory = replayInventoryAdapter(poisoned, "synthetic injection — NOT live evidence");
    const result = await runScout({
      ownerId: "owner-test",
      mandateRaw: { ...flipMandate, openToOtherMakes: true, preferredMakes: [] },
      inventory,
      planner: mockServPlanner([
        { type: "finalize", reason: "no fetch", servStepId: "f" },
      ]),
    });
    expect(result.provenance.every((p) => !String(p.reason).includes("http://evil"))).toBe(true);
    expect(result.failReason).not.toBe("invariant_violation");
  });
});
