import { describe, expect, it, vi } from "vitest";
import {
  createLiveFreeGovPort,
  mockServPlanner,
  replayInventoryAdapter,
  runScout,
  REPLAY_CAMRY_PROVENANCE,
  collectAdverseEvidence,
} from "./index";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const camryRaw = JSON.parse(
  readFileSync(resolve(process.cwd(), "fixtures/autodev-camry.json"), "utf8"),
) as unknown;

const flipMandate = {
  mode: "flip" as const,
  budgetUsd: 40_000,
  budgetKnown: true,
  targetProfitUsd: 500,
  repairAbility: "unknown" as const,
  preferredMakes: ["Toyota"],
  openToOtherMakes: false,
  zip: "72712",
  maxDistanceMiles: 500,
  maxMiles: null,
  notes: null,
};

describe("free gov as SERV decision inputs (mocked HTTP)", () => {
  it("gov_recalls park-it evidence reaches candidate + adverse facts for planner citations", async () => {
    const inventory = replayInventoryAdapter(camryRaw, REPLAY_CAMRY_PROVENANCE);
    const peek = await inventory(flipMandate as never);
    if (!peek.ok) throw new Error("pool");
    const vin = peek.listings[0]!.vin;

    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("recallsByVehicle")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                NHTSACampaignNumber: "99V001",
                Component: "ENGINE",
                Summary: "Park outside",
                Consequence: "Fire",
                Remedy: "Inspect",
                parkIt: false,
                parkOutSide: true,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (u.includes("complaintsByVehicle")) {
        return new Response(JSON.stringify({ count: 1, results: [{}] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;

    const result = await runScout({
      ownerId: "test:free-gov",
      mandateRaw: flipMandate,
      inventory,
      gov: createLiveFreeGovPort({ fetch: fetchImpl }),
      autonomyClaim: "none",
      planner: mockServPlanner([
        {
          type: "run_tool",
          toolId: "evidence.gov_recalls",
          vin,
          reason: "pull free NHTSA recalls as decision input",
          servStepId: "g1",
        },
        { type: "finalize", reason: "done", servStepId: "f" },
      ]),
      budgets: { maxServCalls: 8, maxToolCalls: 20, maxProviderCalls: 0 },
    });

    const cand = result.candidates.find((c) => c.vin === vin);
    expect(cand).toBeTruthy();
    // parkOutside alone → nhtsa_park_outside fact; NOT nhtsa_park_it / do-not-drive reject unlock.
    expect(cand!.evidence.some((e) => e.key === "nhtsa_park_outside")).toBe(true);
    expect(cand!.evidence.some((e) => e.key === "nhtsa_park_it")).toBe(false);
    expect(cand!.evidence.some((e) => e.key === "evidence.gov_recalls" && e.kind === "verified")).toBe(
      true,
    );
    const adverse = collectAdverseEvidence(cand!);
    expect(adverse.some((a) => a.kind === "nhtsa_park_it")).toBe(false);
    expect(result.toolOutcomes.some((o) => o.toolId === "evidence.gov_recalls" && o.ok)).toBe(true);
    // Title/NMVTIS never invented clean.
    expect(JSON.stringify(cand!.evidence)).toMatch(/unknown_not_connected/);
    expect(JSON.stringify(cand!.evidence)).not.toMatch(/clean title/i);
  });
});
