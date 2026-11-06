/**
 * Stage2C — bounded mid-loop inventory.search with offline fixtures + adapter spies.
 * Not SERV efficacy; autonomyClaim stays none.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  keyedReplayInventoryAdapter,
  mockServPlanner,
  observeScoutRun,
  replayInventoryAdapter,
  runScout,
  validateScoutSearchParams,
  type InventoryAdapter,
  type ScoutPlanAction,
  type ScoutPlanner,
} from "./index";

const camryRaw = JSON.parse(
  readFileSync(resolve(process.cwd(), "fixtures/autodev-camry.json"), "utf8"),
) as unknown;

const flipMandate = {
  mode: "flip" as const,
  budgetUsd: null as number | null,
  budgetKnown: false,
  targetProfitUsd: 500,
  repairAbility: "unknown" as const,
  preferredMakes: ["Toyota"],
  openToOtherMakes: true,
  zip: "72712",
  maxDistanceMiles: 200,
  notes: null,
};

function spyAdapter(inner: InventoryAdapter): {
  adapter: InventoryAdapter;
  calls: Array<{ makes: string[]; zip: string | null; distanceMiles: number | null; models: string[] }>;
} {
  const calls: Array<{ makes: string[]; zip: string | null; distanceMiles: number | null; models: string[] }> =
    [];
  return {
    calls,
    adapter: async (mandate, opts) => {
      calls.push({
        makes: opts?.search?.makes ?? mandate.preferredMakes,
        models: opts?.search?.models ?? [],
        zip: opts?.search?.zip ?? mandate.zip,
        distanceMiles: opts?.search?.distanceMiles ?? mandate.maxDistanceMiles,
      });
      return inner(mandate, opts);
    },
  };
}

/** Minimal Auto.dev-shaped Honda fixture for mid-loop fresh VINs. */
function hondaFixture() {
  const row = (vin: string, price: number, miles: number) => ({
    vin,
    createdAt: "2026-09-16 00:00:00",
    vehicle: { make: "Honda", model: "Civic", year: 2019, vin },
    retailListing: {
      price,
      miles,
      used: true,
      city: "Rogers",
      state: "AR",
      zip: "72712",
      dealer: "Test Honda",
      vdp: null,
      primaryImage: null,
    },
    history: { accidentCount: null, oneOwner: null, ownerCount: null, usageType: null },
  });
  // VINs must be 17 chars without I/O/Q (parser rejects invalid VINs).
  return {
    data: [row("1HGBH41JXMN109186", 16500, 42000), row("1HGBH41JXMN109187", 17500, 38000)],
  };
}

describe("Stage2C bounded mid-loop inventory.search", () => {
  it("validates search params inside mandate; rejects out-of-mandate without adapter call", async () => {
    const badMake = validateScoutSearchParams(
      { makes: ["Ferrari"], zip: "72712", distanceMiles: 100 },
      { ...flipMandate, openToOtherMakes: false, preferredMakes: ["Toyota"] },
    );
    expect(badMake.ok).toBe(false);
    if (!badMake.ok) expect(badMake.reason).toBe("out_of_mandate");

    const enlargeRadius = validateScoutSearchParams(
      { makes: ["Toyota"], zip: "72712", distanceMiles: 999 },
      flipMandate,
    );
    expect(enlargeRadius.ok).toBe(false);

    const otherZip = validateScoutSearchParams(
      { makes: ["Toyota"], zip: "10001", distanceMiles: 50 },
      flipMandate,
    );
    expect(otherZip.ok).toBe(false);
    if (!otherZip.ok) expect(otherZip.reason).toBe("out_of_mandate");
  });

  it("mid-loop search invokes adapter with typed params and adds fresh VINs; next action uses them", async () => {
    const keyed = keyedReplayInventoryAdapter(
      { Toyota: camryRaw, Honda: hondaFixture() },
      "stage2c-offline",
    );
    const { adapter, calls } = spyAdapter(keyed);
    const peek = await adapter(flipMandate as never);
    if (!peek.ok) throw new Error("initial pool");
    const firstVin = peek.listings[0]!.vin;

    let step = 0;
    const planner: ScoutPlanner = async (input) => {
      step += 1;
      if (step === 1) {
        return {
          ok: true,
          action: {
            type: "run_tool",
            toolId: "inventory.search",
            vin: null,
            reason: "adjust search to Honda within mandate",
            servStepId: "s2c-1",
            args: { makes: ["Honda"], zip: "72712", distanceMiles: 200 },
          },
        };
      }
      const last = input.recentOutcomes[input.recentOutcomes.length - 1];
      if (last?.toolId === "inventory.search" && last.status === "success" && last.acquiredVin) {
        return {
          ok: true,
          action: {
            type: "select_candidate",
            vin: last.acquiredVin,
            reason: "investigate fresh VIN from mid-loop search",
            servStepId: "s2c-2",
          },
        };
      }
      if (input.investigated.length > 0) {
        return { ok: true, action: { type: "finalize", reason: "done", servStepId: "s2c-f" } };
      }
      return {
        ok: true,
        action: {
          type: "select_candidate",
          vin: firstVin,
          reason: "fallback",
          servStepId: "s2c-fb",
        },
      };
    };

    const result = await runScout({
      ownerId: "owner-test",
      mandateRaw: flipMandate,
      inventory: adapter,
      planner,
      autonomyClaim: "none",
      budgets: { maxServCalls: 20, maxToolCalls: 40, maxProviderCalls: 0, maxCandidatesOut: 3 },
    });

    expect(result.autonomyClaim).toBe("none");
    // Initial + mid-loop = 2 adapter calls; mid-loop carries Honda.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.some((c) => c.makes.map((m) => m.toLowerCase()).includes("honda"))).toBe(true);

    const mid = result.toolOutcomes.filter((o) => o.toolId === "inventory.search");
    expect(mid.length).toBeGreaterThanOrEqual(2);
    const midLoop = mid[mid.length - 1]!;
    expect(midLoop.status).toBe("success");
    expect((midLoop.freshVinCount ?? 0) > 0).toBe(true);
    expect(result.candidates.some((c) => c.vin.startsWith("1HGBH41JX"))).toBe(true);
    // Next action must change from search → select of a fresh acquired VIN (not blind initial Toyota walk only).
    expect(midLoop.acquiredVin?.startsWith("1HGBH41JX")).toBe(true);
    expect(
      result.provenance.some(
        (p) =>
          p.toolId === "listing.normalize" &&
          typeof p.reason === "string" &&
          p.reason.includes(midLoop.acquiredVin!),
      ) || result.investigation.some((c) => c.vin === midLoop.acquiredVin),
    ).toBe(true);

    const obs = observeScoutRun(result, {
      expect: {
        requireInventorySearch: true,
        expectedInventorySource: "replay",
        expectedFixture: true,
      },
    });
    expect(obs.tools.midLoopSearchSuccessWithFreshVins.status).toBe("observed");
    if (obs.tools.midLoopSearchSuccessWithFreshVins.status === "observed") {
      expect(obs.tools.midLoopSearchSuccessWithFreshVins.value).toBeGreaterThanOrEqual(1);
    }
  });

  it("duplicate / out-of-mandate mid-loop search is rejected_no_spend — adapter not called again", async () => {
    const base = replayInventoryAdapter(camryRaw, "camry-replay");
    const { adapter, calls } = spyAdapter(base);
    const script: ScoutPlanAction[] = [
      {
        type: "run_tool",
        toolId: "inventory.search",
        vin: null,
        reason: "duplicate of initial",
        servStepId: "dup",
        args: { makes: ["Toyota"], zip: "72712", distanceMiles: 200 },
      },
      {
        type: "run_tool",
        toolId: "inventory.search",
        vin: null,
        reason: "out of mandate make",
        servStepId: "oom",
        args: { makes: ["Ferrari"], zip: "72712", distanceMiles: 50 },
      },
      { type: "abstain", reason: "stop", servStepId: "abs" },
    ];
    // openToOtherMakes false for OOM make rejection
    const mandate = { ...flipMandate, openToOtherMakes: false };
    const result = await runScout({
      ownerId: "owner-test",
      mandateRaw: mandate,
      inventory: adapter,
      planner: mockServPlanner(script),
      autonomyClaim: "none",
      budgets: { maxServCalls: 20, maxToolCalls: 40, maxProviderCalls: 0 },
    });
    // Only initial inventory dispatch — mid-loop rejects do not call adapter.
    expect(calls).toHaveLength(1);
    const rejected = result.toolOutcomes.filter(
      (o) => o.toolId === "inventory.search" && o.status === "rejected",
    );
    expect(rejected.length).toBeGreaterThanOrEqual(2);
    expect(rejected.every((o) => /rejected_no_spend/i.test(o.summary))).toBe(true);

    const obs = observeScoutRun(result, {
      expect: { requireInventorySearch: true, expectedInventorySource: "replay", expectedFixture: true },
    });
    expect(obs.tools.midLoopSearchRejectedNoSpend.status).toBe("observed");
    if (obs.tools.midLoopSearchRejectedNoSpend.status === "observed") {
      expect(obs.tools.midLoopSearchRejectedNoSpend.value).toBeGreaterThanOrEqual(2);
    }
  });

  it("planner evidenceContext carries missingness/gates/confidence; unsupported gov alone is not car-bad", async () => {
    const inventory = replayInventoryAdapter(camryRaw, "camry");
    const peek = await inventory(flipMandate as never);
    if (!peek.ok) throw new Error("pool");
    const vin = peek.listings[0]!.vin;
    let sawContext = false;
    let choseNonReplaceAfterGov = false;
    const planner: ScoutPlanner = async (input) => {
      if (input.evidenceContext?.budgetsRemaining) {
        sawContext = true;
      }
      const lastGov = [...input.recentOutcomes]
        .reverse()
        .find((o) => o.toolId === "evidence.gov_recalls");
      if (!lastGov) {
        return {
          ok: true,
          action: {
            type: "run_tool",
            toolId: "evidence.gov_recalls",
            vin,
            reason: "gov check",
            servStepId: "g1",
          },
        };
      }
      if (lastGov.status === "unsupported") {
        // Must not be forced to replace merely because gov is unsupported.
        choseNonReplaceAfterGov = true;
        return {
          ok: true,
          action: {
            type: "run_tool",
            toolId: "evidence.asking_price",
            vin,
            reason: "gov unsupported ≠ car bad — continue other evidence",
            servStepId: "g2",
          },
        };
      }
      return { ok: true, action: { type: "finalize", reason: "done", servStepId: "f" } };
    };

    const result = await runScout({
      ownerId: "owner-test",
      mandateRaw: flipMandate,
      inventory,
      planner,
      autonomyClaim: "none",
      budgets: { maxServCalls: 20, maxToolCalls: 40, maxProviderCalls: 0 },
    });
    expect(sawContext).toBe(true);
    expect(choseNonReplaceAfterGov).toBe(true);
    expect(result.autonomyClaim).toBe("none");
    expect(result.toolOutcomes.some((o) => o.toolId === "evidence.asking_price")).toBe(true);
    expect(result.candidates.find((c) => c.vin === vin)?.disposition).not.toBe("replaced");
  });
});
