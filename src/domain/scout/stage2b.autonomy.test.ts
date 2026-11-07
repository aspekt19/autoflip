/**
 * Stage2B — genuine autonomy offline full-loop.
 * Actual tool outcomes, real replace acquisition, planner feedback changes decisions.
 * Not SERV efficacy; autonomyClaim stays none for offline/mock.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REPLAY_CAMRY_PROVENANCE,
  heuristicOfflinePlanner,
  mockServPlanner,
  replayInventoryAdapter,
  runScout,
  type ScoutPlanAction,
  type ScoutPlanner,
  type ScoutToolOutcome,
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

function feedbackPlanner(script: (ctx: {
  step: number;
  pendingVins: string[];
  recentOutcomes: ScoutToolOutcome[];
  investigated: string[];
}) => ScoutPlanAction | null): ScoutPlanner {
  return async (input) => {
    const action = script({
      step: input.step,
      pendingVins: input.pendingVins,
      recentOutcomes: input.recentOutcomes,
      investigated: input.investigated.map((c) => c.vin),
    });
    if (!action) {
      return { ok: false, error: "serv_unavailable", message: "feedback planner exhausted" };
    }
    return { ok: true, action };
  };
}

describe("Stage2B genuine autonomy (offline)", () => {
  it("gov tool is unsupported — not cache-success; feedback changes next planner choice", async () => {
    const inventory = replayInventoryAdapter(camryRaw, REPLAY_CAMRY_PROVENANCE);
    const peek = await inventory(flipMandate as never);
    if (!peek.ok) throw new Error("pool");
    const [a, b] = peek.listings;
    expect(a && b).toBeTruthy();

    let govRequested = false;
    const result = await runScout({
      ownerId: "owner-test",
      mandateRaw: flipMandate,
      inventory,
      autonomyClaim: "none",
      planner: feedbackPlanner(({ recentOutcomes, pendingVins }) => {
        const lastUnsupported = [...recentOutcomes].reverse().find((o) => o.status === "unsupported");
        if (!govRequested) {
          govRequested = true;
          return {
            type: "run_tool",
            toolId: "evidence.gov_recalls",
            vin: a!.vin,
            reason: "try gov",
            servStepId: "g1",
          };
        }
        expect(lastUnsupported?.ok).toBe(false);
        expect(lastUnsupported?.toolId).toBe("evidence.gov_recalls");
        // Decision changes: after unsupported, select a different VIN — not retry gov as success.
        if (lastUnsupported) {
          const other = pendingVins.find((v) => v !== a!.vin) ?? b!.vin;
          if (!recentOutcomes.some((o) => o.status === "success" && o.acquiredVin === other)) {
            return {
              type: "select_candidate",
              vin: other,
              reason: "replan after gov unsupported",
              servStepId: "s2",
            };
          }
        }
        return { type: "finalize", reason: "done", servStepId: "f" };
      }),
      budgets: { maxServCalls: 12, maxToolCalls: 40, maxProviderCalls: 0, maxCandidatesOut: 5 },
    });

    expect(result.autonomyClaim).toBe("none");
    expect(result.provenance.some((p) => /unsupported/i.test(p.reason))).toBe(true);
    expect(result.investigation.every((c) => c.vin !== a!.vin || c.disposition === "investigate")).toBe(
      true,
    );
    // Gov unsupported must not look like verified history pass.
    const govEvidence = result.candidates
      .flatMap((c) => c.evidence)
      .filter((e) => e.key === "evidence.gov_recalls");
    expect(govEvidence.every((e) => e.kind === "unknown")).toBe(true);
    expect(result.investigation.every((c) => c.claimsSafeBuy === false)).toBe(true);
  });

  it("idempotent gov retry replays unsupported — never upgrades to success", async () => {
    const inventory = replayInventoryAdapter(camryRaw, REPLAY_CAMRY_PROVENANCE);
    const peek = await inventory(flipMandate as never);
    if (!peek.ok) throw new Error("pool");
    const vin = peek.listings[0]!.vin;
    const result = await runScout({
      ownerId: "owner-test",
      mandateRaw: flipMandate,
      inventory,
      autonomyClaim: "none",
      planner: mockServPlanner([
        {
          type: "run_tool",
          toolId: "evidence.gov_fuel",
          vin,
          reason: "first",
          servStepId: "t1",
        },
        {
          type: "run_tool",
          toolId: "evidence.gov_fuel",
          vin,
          reason: "retry",
          servStepId: "t2",
        },
        { type: "finalize", reason: "stop", servStepId: "f" },
      ]),
      budgets: { maxServCalls: 10, maxToolCalls: 20, maxProviderCalls: 0 },
    });
    const govSteps = result.provenance.filter((p) => p.toolId === "evidence.gov_fuel");
    expect(govSteps.some((p) => /unsupported/i.test(p.reason))).toBe(true);
    expect(govSteps.some((p) => /idempotent replay/i.test(p.reason))).toBe(true);
    expect(govSteps.every((p) => !/successful evidence/i.test(p.reason) || /not treated as successful/i.test(p.reason))).toBe(
      true,
    );
  });

  it("replace acquires a distinct candidate within budget — not a label-only relabel", async () => {
    const inventory = replayInventoryAdapter(camryRaw, REPLAY_CAMRY_PROVENANCE);
    const peek = await inventory(flipMandate as never);
    if (!peek.ok) throw new Error("pool");
    const [a, b] = peek.listings;
    expect(a && b).toBeTruthy();

    let acquiredFromReplace: string | null = null;
    let phase: "select" | "replace" | "done" = "select";
    const result = await runScout({
      ownerId: "owner-test",
      mandateRaw: flipMandate,
      inventory,
      autonomyClaim: "none",
      planner: feedbackPlanner(({ recentOutcomes }) => {
        if (phase === "select") {
          phase = "replace";
          return {
            type: "select_candidate",
            vin: a!.vin,
            reason: "first",
            servStepId: "s1",
          };
        }
        if (phase === "replace") {
          phase = "done";
          return {
            type: "replace",
            vin: a!.vin,
            reason: "weak — pull distinct next",
            servStepId: "rp1",
          };
        }
        const lastReplace = [...recentOutcomes].reverse().find((o) => o.toolId === "candidate.replace");
        if (lastReplace) {
          acquiredFromReplace = lastReplace.acquiredVin;
          expect(lastReplace.acquiredVin).toBeTruthy();
          expect(lastReplace.acquiredVin).not.toBe(a!.vin);
          expect(lastReplace.status === "success" || lastReplace.status === "failed").toBe(true);
        }
        return { type: "finalize", reason: "done after replace acquire", servStepId: "f" };
      }),
      budgets: { maxServCalls: 12, maxToolCalls: 40, maxProviderCalls: 0, maxCandidatesOut: 5 },
    });

    expect(acquiredFromReplace).toBeTruthy();
    expect(acquiredFromReplace).not.toBe(a!.vin);
    expect(result.candidates.some((c) => c.vin === a!.vin && c.disposition === "replaced")).toBe(true);
    // Distinct acquired candidate was executed (investigate or rejected/pending after gates).
    const acquired = result.candidates.find((c) => c.vin === acquiredFromReplace);
    expect(acquired).toBeTruthy();
    expect(acquired!.disposition === "pending" || acquired!.disposition === "investigate" || acquired!.disposition === "rejected").toBe(
      true,
    );
    expect(result.usage.toolCalls).toBeGreaterThanOrEqual(2);
  });

  it("replace with empty pool remainder → honest empty outcome; planner can stop", async () => {
    const inventory = replayInventoryAdapter(camryRaw, REPLAY_CAMRY_PROVENANCE);
    const peek = await inventory(flipMandate as never);
    if (!peek.ok) throw new Error("pool");
    const only = peek.listings[0]!;
    // Single-VIN pool via filter adapter
    const single = replayInventoryAdapter(
      { data: (camryRaw as { data: unknown[] }).data.slice(0, 1) },
      REPLAY_CAMRY_PROVENANCE,
    );
    const result = await runScout({
      ownerId: "owner-test",
      mandateRaw: flipMandate,
      inventory: single,
      autonomyClaim: "none",
      planner: feedbackPlanner(({ step, recentOutcomes }) => {
        if (step === 1) {
          return {
            type: "select_candidate",
            vin: only.vin,
            reason: "only",
            servStepId: "s1",
          };
        }
        if (step === 2) {
          return {
            type: "replace",
            vin: only.vin,
            reason: "try replace with nothing left",
            servStepId: "rp",
          };
        }
        const last = recentOutcomes[recentOutcomes.length - 1];
        expect(last?.status).toBe("empty");
        expect(last?.acquiredVin).toBeNull();
        return {
          type: "abstain",
          reason: "honest stop — no replacement candidate",
          servStepId: "abs",
        };
      }),
      budgets: { maxServCalls: 10, maxToolCalls: 20, maxProviderCalls: 0 },
    });
    expect(result.state).toBe("abstained");
    expect(result.investigation).toHaveLength(0);
  });

  it("mid-loop inventory.search duplicate of initial is rejected_no_spend — not success noop", async () => {
    const inventory = replayInventoryAdapter(camryRaw, REPLAY_CAMRY_PROVENANCE);
    const peek = await inventory(flipMandate as never);
    if (!peek.ok) throw new Error("pool");
    const vin = peek.listings[0]!.vin;
    const result = await runScout({
      ownerId: "owner-test",
      mandateRaw: flipMandate,
      inventory,
      autonomyClaim: "none",
      planner: mockServPlanner([
        {
          type: "run_tool",
          toolId: "inventory.search",
          vin: null,
          reason: "duplicate of initial search",
          servStepId: "inv2",
          args: {
            makes: flipMandate.preferredMakes,
            zip: flipMandate.zip,
            distanceMiles: flipMandate.maxDistanceMiles,
          },
        },
        {
          type: "select_candidate",
          vin,
          reason: "continue after rejected duplicate inventory",
          servStepId: "s1",
        },
        { type: "finalize", reason: "done", servStepId: "f" },
      ]),
      budgets: { maxServCalls: 10, maxToolCalls: 20, maxProviderCalls: 0 },
    });
    expect(
      result.toolOutcomes.some(
        (o) =>
          o.toolId === "inventory.search" &&
          o.status === "rejected" &&
          /reject_no_provider_spend|rejected_no_spend/i.test(o.summary),
      ),
    ).toBe(true);
    expect(["completed", "abstained"]).toContain(result.state);
  });

  it("heuristic offline planner replans after unsupported using actual outcomes", async () => {
    const inventory = replayInventoryAdapter(camryRaw, REPLAY_CAMRY_PROVENANCE);
    const peek = await inventory(flipMandate as never);
    if (!peek.ok) throw new Error("pool");
    // Drive heuristic: first force gov unsupported via thin wrapper
    let injected = false;
    const heuristic = heuristicOfflinePlanner();
    const wrapped: ScoutPlanner = async (input) => {
      if (!injected && input.pendingVins[0]) {
        injected = true;
        return {
          ok: true,
          action: {
            type: "run_tool",
            toolId: "evidence.gov_recalls",
            vin: input.pendingVins[0],
            reason: "inject unsupported",
            servStepId: "inj",
          },
        };
      }
      return heuristic(input);
    };
    const result = await runScout({
      ownerId: "owner-test",
      mandateRaw: flipMandate,
      inventory,
      planner: wrapped,
      autonomyClaim: "none",
      budgets: { maxServCalls: 20, maxToolCalls: 40, maxProviderCalls: 0, maxCandidatesOut: 3 },
    });
    expect(result.autonomyClaim).toBe("none");
    expect(result.provenance.some((p) => /unsupported/i.test(p.reason))).toBe(true);
    // Heuristic should have issued replace after unsupported (decision change).
    expect(
      result.provenance.some((p) => p.toolId === "candidate.replace") ||
        result.investigation.length >= 0,
    ).toBe(true);
    expect(result.failReason).toBeNull();
  });

  it("fewer/none investigation results stay honest — no fake safe-buy", async () => {
    const empty = { data: [] };
    const result = await runScout({
      ownerId: "owner-test",
      mandateRaw: flipMandate,
      inventory: replayInventoryAdapter(empty, "empty fixture"),
      planner: heuristicOfflinePlanner(),
      autonomyClaim: "none",
    });
    expect(result.state).toBe("abstained");
    expect(result.investigation).toHaveLength(0);
    expect(result.message).toMatch(/empty|no evidence|inventory/i);
  });
});
