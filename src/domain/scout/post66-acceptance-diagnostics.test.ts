/**
 * Offline fixtures shaped like parent post-PR66 live audit (run 83bfd2fe…).
 * No network; does not reconstruct missing raw planner JSON; no model winner.
 */
import { describe, expect, it } from "vitest";
import {
  diagnosePost66Acceptance,
  productAcceptanceBlockers,
  NEAR_FLOOR_SELLER_CLAIM_USD,
} from "./post66-acceptance-diagnostics";

const BASIC_EVIDENCE: string[] = [
  "vin",
  "year_make_model",
  "odometer_miles",
  "asking_price_usd",
  "accident_count",
  "owner_history",
];

/** Minimal sanitized mirror of observed post66 holes (not a live replay). */
function post66LikeSnapshot() {
  return {
    inventorySearchCount: 1,
    tokensRecorded: false,
    rawPlannerActionsPresent: false,
    selected: [
      {
        vin: "2T3C1RFV5SC305320",
        priceUsd: 549,
        priceSource: ["autodev.retailListing.price"],
        evidenceKeys: [...BASIC_EVIDENCE],
        withheld: true,
        claimsSafeBuy: false,
        claimsVerifiedProfit: false,
      },
      {
        vin: "3TMCZ5ANXLM360761",
        priceUsd: 501,
        priceSource: ["autodev.retailListing.price"],
        evidenceKeys: [...BASIC_EVIDENCE],
        withheld: true,
        claimsSafeBuy: false,
        claimsVerifiedProfit: false,
      },
      {
        vin: "5TFPC5DB3RX063497",
        priceUsd: 525,
        priceSource: ["autodev.retailListing.price"],
        evidenceKeys: [...BASIC_EVIDENCE],
        withheld: true,
        claimsSafeBuy: false,
        claimsVerifiedProfit: false,
      },
    ],
    toolOutcomes: [
      { toolId: "inventory.search", vin: null, ok: true, status: "success" },
      {
        toolId: "evidence.gov_vpic",
        vin: "2T3C1RFV5SC305320",
        ok: true,
        status: "success",
      },
      {
        toolId: "evidence.gov_recalls",
        vin: "2T3C1RFV5SC305320",
        ok: true,
        status: "success",
      },
      {
        toolId: "evidence.gov_safety",
        vin: "2T3C1RFV5SC305320",
        ok: true,
        status: "success",
      },
      {
        toolId: "gates.verify",
        vin: "2T3C1RFV5SC305320",
        ok: true,
        status: "success",
      },
      {
        toolId: "evidence.gov_vpic",
        vin: "3TMCZ5ANXLM360761",
        ok: true,
        status: "success",
      },
      {
        toolId: "evidence.gov_recalls",
        vin: "3TMCZ5ANXLM360761",
        ok: true,
        status: "success",
      },
      {
        toolId: "listing.normalize",
        vin: "5TFPC5DB3RX063497",
        ok: true,
        status: "success",
      },
    ],
    provenance: [
      { state: "finalizing", reason: "Candidate cap reached; finalizing.", toolId: null },
      {
        state: "completed",
        reason: "Completed with investigation candidates.",
        toolId: "run.finalize",
      },
    ],
  };
}

describe("post66 acceptance diagnostics (offline)", () => {
  it("flags product blockers PR68 parse diagnostics do NOT fix", () => {
    const report = diagnosePost66Acceptance(post66LikeSnapshot());
    expect(report.countersAreNotHttpOrBilling).toBe(true);
    expect(report.modelWinnerClaimForbidden).toBe(true);
    expect(report.dispositionMix.inventorySearch).toBe(1);
    expect(report.dispositionMix.reject).toBe(0);
    expect(report.dispositionMix.replace).toBe(0);
    expect(report.dispositionMix.govToolsOk).toBeGreaterThan(0);

    const blockers = productAcceptanceBlockers(report).map((h) => h.id);
    expect(blockers).toEqual(
      expect.arrayContaining([
        "gov_evidence_retention_gap",
        "no_reject_or_replace",
        "single_inventory_no_replan",
        "near_floor_seller_claims",
      ]),
    );
    for (const hole of productAcceptanceBlockers(report)) {
      expect(hole.addressedByParseDiagnosticsPr68).toBe(false);
    }

    const near = report.holes.find((h) => h.id === "near_floor_seller_claims");
    expect(near?.counts?.nearFloorSelected).toBe(3);
    expect(NEAR_FLOOR_SELLER_CLAIM_USD.minInclusive).toBe(500);
    expect(NEAR_FLOOR_SELLER_CLAIM_USD.maxExclusive).toBe(600);
  });

  it("marks raw/token gaps as diagnostic (PR68 compare path helps future compares only)", () => {
    const report = diagnosePost66Acceptance(post66LikeSnapshot());
    const raw = report.holes.find((h) => h.id === "raw_planner_absent");
    const tokens = report.holes.find((h) => h.id === "tokens_unrecorded");
    expect(raw?.addressedByParseDiagnosticsPr68).toBe(true);
    expect(tokens?.addressedByParseDiagnosticsPr68).toBe(true);
    expect(report.holes.find((h) => h.id === "completion_by_candidate_cap")?.severity).toBe(
      "diagnostic_gap",
    );
    expect(report.holes.find((h) => h.id === "claims_honesty_ok")?.severity).toBe(
      "preserved_safeguard",
    );
  });

  it("clears retention + disposition blockers when gov evidence and reject/replan appear", () => {
    const fixed = post66LikeSnapshot();
    fixed.inventorySearchCount = 2;
    fixed.selected[0]!.evidenceKeys = [...BASIC_EVIDENCE, "evidence.gov_vpic", "evidence.gov_recalls"];
    fixed.selected[1]!.evidenceKeys = [...BASIC_EVIDENCE, "evidence.gov_vpic"];
    fixed.selected[2]!.evidenceKeys = [...BASIC_EVIDENCE, "evidence.gov_safety"];
    // Move prices out of near-floor band for this positive control.
    for (const s of fixed.selected) s.priceUsd = 12_500;
    fixed.toolOutcomes.push(
      { toolId: "candidate.reject", vin: "2T3C1RFV5SC305320", ok: true, status: "success" },
      { toolId: "inventory.search", vin: null, ok: true, status: "success" },
    );
    const report = diagnosePost66Acceptance(fixed);
    const blockerIds = productAcceptanceBlockers(report).map((h) => h.id);
    expect(blockerIds).not.toContain("gov_evidence_retention_gap");
    expect(blockerIds).not.toContain("no_reject_or_replace");
    expect(blockerIds).not.toContain("single_inventory_no_replan");
    expect(blockerIds).not.toContain("near_floor_seller_claims");
  });
});
