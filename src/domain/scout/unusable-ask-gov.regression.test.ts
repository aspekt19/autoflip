/**
 * Independently correct (not under-3 workaround): free-gov must not invent unlock
 * for placeholder $1–$59 asks. Unknown ≠ pass; no shortlist from unusable price.
 */
import { describe, expect, it } from "vitest";
import type { Listing } from "@/domain/types";
import {
  MIN_USABLE_ASKING_PRICE_USD,
  buildCandidateEvidenceBrief,
  isUsableAskingPriceUsd,
  mockServPlanner,
  runScout,
  sanitizeScoutPlanAction,
} from "./index";
import type { ScoutCandidate } from "./types";

const personalMandate = {
  mode: "personal" as const,
  budgetUsd: 20_000,
  budgetKnown: true,
  targetProfitUsd: null,
  repairAbility: "unknown" as const,
  preferredMakes: ["Toyota"],
  openToOtherMakes: false,
  zip: null,
  maxDistanceMiles: null,
  maxMiles: null,
  notes: null,
};

function listing(over: Partial<Listing> & Pick<Listing, "vin" | "priceUsd">): Listing {
  return {
    vin: over.vin,
    year: over.year ?? 1998,
    make: over.make ?? "Toyota",
    model: over.model ?? "Tacoma",
    trim: null,
    miles: over.miles ?? 120_000,
    priceUsd: over.priceUsd,
    city: null,
    state: null,
    zip: null,
    dealer: null,
    vdp: null,
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: null,
    accidentCount: null,
    oneOwner: null,
    ownerCount: null,
    usageType: null,
    fuel: null,
    engine: null,
    drivetrain: null,
    bodyStyle: null,
    style: null,
    distanceMiles: null,
    latitude: null,
    longitude: null,
    removedAt: null,
    createdAt: null,
    source: "autodev",
  };
}

function pendingCand(l: Listing): ScoutCandidate {
  return {
    vin: l.vin,
    listing: l,
    disposition: "pending",
    evidence: [],
    flip: null,
    gates: [],
    withheld: false,
    withholdReason: null,
    rejectReason: null,
    dispositionRationale: null,
    historyStatus: "unknown",
    historyEvaluated: false,
    claimsSafeBuy: false,
    claimsVerifiedProfit: false,
  };
}

describe("unusable ask + free-gov (independent of SERV usage policy)", () => {
  it("briefs mark $1–$59 as unusable; freeGov cannot unlock", () => {
    expect(MIN_USABLE_ASKING_PRICE_USD).toBe(500);
    for (const price of [1, 10, 59]) {
      expect(isUsableAskingPriceUsd(price)).toBe(false);
      const brief = buildCandidateEvidenceBrief(pendingCand(listing({ vin: `V${price}`, priceUsd: price })));
      expect(brief.askingPriceUsable).toBe(false);
      expect(brief.freeGovCanUnlockInvestigate).toBe(false);
    }
  });

  it("sanitize remaps free-gov on unusable ask → reject; leaves usable-price free-gov alone", () => {
    const badVin = "4TAWM72N3WZ162673";
    const bad = sanitizeScoutPlanAction({
      action: {
        type: "run_tool",
        toolId: "evidence.gov_vpic",
        vin: badVin,
        reason: "probe",
        servStepId: "s1",
      },
      candidates: new Map([[badVin, pendingCand(listing({ vin: badVin, priceUsd: 1 }))]]),
    });
    expect(bad.type).toBe("reject");
    if (bad.type === "reject") {
      expect(bad.citedEvidence?.[0]?.kind).toBe("missing_asking_price");
    }

    const okVin = "4T1B11HK5JU009999";
    const ok = sanitizeScoutPlanAction({
      action: {
        type: "run_tool",
        toolId: "evidence.gov_recalls",
        vin: okVin,
        reason: "legitimate",
        servStepId: "s2",
      },
      candidates: new Map([[okVin, pendingCand(listing({ vin: okVin, priceUsd: 12_000 }))]]),
    });
    expect(ok.type).toBe("run_tool");
    if (ok.type === "run_tool") expect(ok.toolId).toBe("evidence.gov_recalls");
  });

  it("runScout remaps free-gov on placeholder pool to grounded rejects (no shortlist)", async () => {
    const pool = [
      listing({ vin: "4TAWM72N3WZ162673", priceUsd: 1 }),
      listing({ vin: "3TMAZ5CN1LM120535", priceUsd: 59 }),
    ];
    const result = await runScout({
      ownerId: "owner-unusable-gov",
      mandateRaw: personalMandate,
      inventory: async () => ({
        ok: true as const,
        listings: pool,
        source: "live" as const,
        provenance: "test:placeholder",
        isFixture: false,
        providerCallsUsed: 0,
      }),
      autonomyClaim: "none",
      planner: mockServPlanner([
        {
          type: "run_tool",
          toolId: "evidence.gov_vpic",
          vin: pool[0]!.vin,
          reason: "would not unlock",
          servStepId: "g1",
        },
        {
          type: "run_tool",
          toolId: "evidence.gov_safety",
          vin: pool[1]!.vin,
          reason: "would not unlock",
          servStepId: "g2",
        },
        { type: "abstain", reason: "honest stop", servStepId: "a1" },
      ]),
      budgets: { maxServCalls: 8, maxToolCalls: 20, maxProviderCalls: 0 },
    });

    expect(result.investigation).toHaveLength(0);
    expect(result.candidates.filter((c) => c.disposition === "rejected").length).toBe(2);
    expect(
      result.toolOutcomes.some(
        (o) =>
          (o.toolId === "evidence.gov_vpic" || o.toolId === "evidence.gov_safety") &&
          o.status === "success",
      ),
    ).toBe(false);
    expect(result.state).toBe("abstained");
  });
});
