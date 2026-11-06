import { describe, expect, it } from "vitest";
import {
  REPLAY_CAMRY_PROVENANCE,
  mockServPlanner,
  replayInventoryAdapter,
  runScout,
} from "./index";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const camryRaw = JSON.parse(
  readFileSync(resolve(process.cwd(), "fixtures/autodev-camry.json"), "utf8"),
) as unknown;

describe("personal_fit evidence honesty (Stage2A)", () => {
  it("labels personal_budget_fit as assumed — not verified external fact", async () => {
    const inventory = replayInventoryAdapter(camryRaw, REPLAY_CAMRY_PROVENANCE);
    const peek = await inventory({
      mode: "personal",
      budgetUsd: 25_000,
      budgetKnown: true,
      targetProfitUsd: null,
      repairAbility: "unknown",
      preferredMakes: ["Toyota"],
      openToOtherMakes: false,
      zip: "72712",
      maxDistanceMiles: 500,
      notes: null,
    });
    expect(peek.ok).toBe(true);
    if (!peek.ok) return;
    const vin = peek.listings[0]!.vin;
    const result = await runScout({
      ownerId: "test:personal-fit",
      mandateRaw: {
        mode: "personal",
        budgetUsd: 25_000,
        budgetKnown: true,
        preferredMakes: ["Toyota"],
        openToOtherMakes: false,
        zip: "72712",
        maxDistanceMiles: 500,
      },
      inventory,
      planner: mockServPlanner([
        {
          type: "run_tool",
          toolId: "economics.personal_fit",
          vin,
          reason: "fit check",
          servStepId: "pf1",
        },
        { type: "finalize", reason: "done", servStepId: "f" },
      ]),
      budgets: { maxProviderCalls: 0, maxServCalls: 10, maxToolCalls: 20 },
      autonomyClaim: "none",
    });
    const cand = result.candidates.find((c) => c.vin === vin);
    const fit = cand?.evidence.find((e) => e.key === "personal_budget_fit");
    expect(fit).toBeTruthy();
    expect(fit?.kind).not.toBe("verified");
    expect(fit?.kind).toBe("assumed");
    expect(fit?.note).toMatch(/not independently verified/i);
  });
});
