/**
 * Regression for owner retest d7d3dc78…:
 * Live SERV burned all 3 grant calls on free-gov for a $1 placeholder VIN,
 * never finalized, then opaque 503 grant_exhausted with all dispositions pending.
 *
 * Offline guards: remap non-unlocking free-gov → grounded reject; last-call
 * free-gov → abstain/finalize; exhaustion + all-unusable pool → honest abstain.
 */
import { describe, expect, it } from "vitest";
import type { Listing } from "@/domain/types";
import {
  MIN_USABLE_ASKING_PRICE_USD,
  allAskingPricesUnusable,
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

describe("serv-cap free-gov burn regression (d7d3dc78)", () => {
  it("placeholder $1–$59 asks stay unusable and briefs mark free-gov cannot unlock", () => {
    for (const price of [1, 10, 59]) {
      expect(isUsableAskingPriceUsd(price)).toBe(false);
      const brief = buildCandidateEvidenceBrief(pendingCand(listing({ vin: `VIN${price}`, priceUsd: price })));
      expect(brief.askingPriceUsable).toBe(false);
      expect(brief.freeGovCanUnlockInvestigate).toBe(false);
      expect(brief.askingUsd).toBe(price);
    }
    expect(MIN_USABLE_ASKING_PRICE_USD).toBe(500);
    const usable = buildCandidateEvidenceBrief(
      pendingCand(listing({ vin: "VINOK", priceUsd: 12_000 })),
    );
    expect(usable.askingPriceUsable).toBe(true);
    expect(usable.freeGovCanUnlockInvestigate).toBe(true);
  });

  it("sanitize remaps free-gov on unusable ask → reject missing_asking_price (not shortlist)", () => {
    const vin = "4TAWM72N3WZ162673";
    const cand = pendingCand(listing({ vin, priceUsd: 1 }));
    const map = new Map([[vin, cand]]);
    const out = sanitizeScoutPlanAction({
      action: {
        type: "run_tool",
        toolId: "evidence.gov_vpic",
        vin,
        reason: "burn gov",
        servStepId: "step-1",
      },
      candidates: map,
      investigatedCount: 0,
      servCallsRemainingAfterReserve: 2,
    });
    expect(out.type).toBe("reject");
    if (out.type !== "reject") return;
    expect(out.vin).toBe(vin);
    expect(out.rationaleKind).toBe("adverse_evidence");
    expect(out.citedEvidence?.[0]?.kind).toBe("missing_asking_price");
  });

  it("sanitize remaps free-gov on last SERV call → abstain when nothing investigated", () => {
    const vin = "4T1B11HK5JU000100";
    const cand = pendingCand(listing({ vin, priceUsd: 15_000 }));
    const out = sanitizeScoutPlanAction({
      action: {
        type: "run_tool",
        toolId: "evidence.gov_recalls",
        vin,
        reason: "last call gov",
        servStepId: "step-last",
      },
      candidates: new Map([[vin, cand]]),
      investigatedCount: 0,
      servCallsRemainingAfterReserve: 0,
    });
    expect(out.type).toBe("abstain");
  });

  it("runScout: three free-gov probes on $1–$59 pool → grounded rejects, not opaque fail; no shortlist", async () => {
    const pool = [
      listing({ vin: "4TAWM72N3WZ162673", priceUsd: 1 }),
      listing({ vin: "3TMAZ5CN1LM120535", priceUsd: 10 }),
      listing({ vin: "5TFEV54187X032378", priceUsd: 59 }),
    ];
    const inventory = async () =>
      ({
        ok: true as const,
        listings: pool,
        source: "live" as const,
        provenance: "test:placeholder-pool",
        isFixture: false,
        providerCallsUsed: 0,
      });

    const result = await runScout({
      ownerId: "owner-cap-gov-burn",
      mandateRaw: personalMandate,
      inventory,
      autonomyClaim: "none",
      planner: mockServPlanner([
        {
          type: "run_tool",
          toolId: "evidence.gov_vpic",
          vin: pool[0]!.vin,
          reason: "would-burn-1",
          servStepId: "step-1",
        },
        {
          type: "run_tool",
          toolId: "evidence.gov_recalls",
          vin: pool[1]!.vin,
          reason: "would-burn-2",
          servStepId: "step-2",
        },
        {
          type: "run_tool",
          toolId: "evidence.gov_safety",
          vin: pool[2]!.vin,
          reason: "would-burn-3",
          servStepId: "step-3",
        },
        // Cap=3: fourth plan attempt hits budget; all asks unusable → honest abstain.
      ]),
      budgets: { maxServCalls: 3, maxToolCalls: 20, maxProviderCalls: 0 },
    });

    expect(result.investigation).toHaveLength(0);
    expect(result.candidates.every((c) => c.disposition !== "investigate")).toBe(true);
    expect(result.candidates.some((c) => c.disposition === "rejected")).toBe(true);
    for (const c of result.candidates.filter((x) => x.disposition === "rejected")) {
      expect(c.rejectReason ?? c.dispositionRationale?.groundedReason ?? "").toMatch(
        /missing_asking_price|usable|placeholder/i,
      );
      expect(c.claimsSafeBuy).toBe(false);
    }
    // No free-gov evidence attached from remapped probes.
    expect(
      result.toolOutcomes.some(
        (o) =>
          (o.toolId === "evidence.gov_vpic" ||
            o.toolId === "evidence.gov_recalls" ||
            o.toolId === "evidence.gov_safety") &&
          o.status === "success",
      ),
    ).toBe(false);
    expect(result.state).toBe("abstained");
    expect(result.failReason).toBeNull();
    expect(result.partial).toBe(true);
    expect(result.message ?? "").toMatch(/no usable asking|honest no-options|placeholder/i);
  });

  it("allAskingPricesUnusable helper matches placeholder pool", () => {
    const map = new Map(
      [1, 10, 59].map((p) => {
        const l = listing({ vin: `V${p}`, priceUsd: p });
        return [l.vin, pendingCand(l)] as const;
      }),
    );
    expect(allAskingPricesUnusable(map, [...map.keys()])).toBe(true);
    map.set("ok", pendingCand(listing({ vin: "ok", priceUsd: 9000 })));
    expect(allAskingPricesUnusable(map, [...map.keys()])).toBe(false);
  });
});
