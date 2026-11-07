/**
 * Offline regression mapped from post-PR66 live acceptance audit
 * (run 83bfd2fe… on d048b375 / post66-live-acceptance-audit_feb3.md)
 * plus seller-page validation (post66-seller-price-evidence_eb54.md).
 *
 * Isolated fixtures only — no network / inference / inventory / credentials.
 *
 * Causal facts from the audit:
 * 1. Successful gov_vpic/recalls/safety toolOutcomes did not appear on
 *    investigation[*].evidence (only six seller/history keys) — writer wipe.
 * 2. Feed asks $501 / $525 / $549 cleared the $500 floor and qualified as
 *    price.pass — not genuine purchase-price evidence; payment interpretation
 *    unproven; claimsSafeBuy correctly false but shortlist not useful.
 * 3. Tundra VIN 5TFPC5DB3RX063497 feed $525 is an explicit dealer closing FEE
 *    on the matched seller page — kind/provenance must block qualification
 *    even when magnitude clears year-aware floors (not a floor-bump alone).
 */
import { describe, expect, it, vi } from "vitest";
import type { Listing } from "@/domain/types";
import {
  MIN_SEARCH_ASKING_PRICE_USD,
  MIN_USABLE_ASKING_PRICE_USD,
  assessAskingPrice,
  assessListingAskingPrice,
  collectAdverseEvidence,
  createLiveFreeGovPort,
  filterPool,
  isListingAskingPriceUsable,
  isUsableAskingPriceUsd,
  mandateToSearchParams,
  mergeListingBaseEvidence,
  mockServPlanner,
  qualifyListingConstraints,
  runScout,
  runScoutGates,
  searchQueryRanges,
} from "./index";
import { askingPriceEvidence, identityEvidence, historyEvidence } from "./evidence";

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

/** Exact vehicles/prices from the audit selected[] (seller_claim Auto.dev retailListing.price). */
const AUDIT_ROWS = [
  { vin: "2T3C1RFV5SC305320", year: 2025, model: "RAV4", priceUsd: 549 },
  { vin: "2T3F1RFV0SW506912", year: 2025, model: "RAV4", priceUsd: 549 },
  { vin: "2T3F1RFV5SC497559", year: 2025, model: "RAV4", priceUsd: 549 },
  { vin: "3TMCZ5ANXLM360761", year: 2020, model: "Tacoma", priceUsd: 501 },
  { vin: "5TFPC5DB3RX063497", year: 2024, model: "Tundra", priceUsd: 525 },
] as const;

function listing(
  over: Partial<Listing> & Pick<Listing, "vin" | "priceUsd" | "year" | "model">,
): Listing {
  return {
    vin: over.vin,
    year: over.year,
    make: over.make ?? "Toyota",
    model: over.model,
    trim: null,
    miles: over.miles ?? 40_000,
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
    accidentCount: over.accidentCount ?? null,
    oneOwner: null,
    ownerCount: over.ownerCount ?? null,
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
    askingPriceKind: over.askingPriceKind,
    askingPriceProvenance: over.askingPriceProvenance,
    askingPriceLabel: over.askingPriceLabel,
    askingPriceSellerPageAccess: over.askingPriceSellerPageAccess,
  };
}

describe("post66 evidence retention + asking-price qualification (mapped live evidence)", () => {
  it("search floor rises to credible search min (not $500 alone) under $20k budget", () => {
    expect(MIN_USABLE_ASKING_PRICE_USD).toBe(500);
    expect(MIN_SEARCH_ASKING_PRICE_USD).toBe(3_000);
    const params = mandateToSearchParams(personalMandate);
    expect(searchQueryRanges(params)).toEqual({ priceRange: "3000-20000" });
  });

  it("audit feed asks $501/$525/$549 are suspicious_unverified — not shortlist-usable; not vehicle defect", () => {
    for (const row of AUDIT_ROWS) {
      const a = assessAskingPrice(row.priceUsd, {
        year: row.year,
        priceKind: "unknown",
        provenance: "feed_only",
      });
      expect(a.status).toBe("suspicious_unverified");
      expect(a.usableForShortlist).toBe(false);
      expect(a.kind).toBe("unknown");
      expect(a.provenance).toBe("feed_only");
      expect(a.ambiguity === "fee_vs_purchase" || a.ambiguity === "source_unverified").toBe(true);
      expect(isUsableAskingPriceUsd(row.priceUsd, row.year)).toBe(false);
      expect(a.note).toMatch(/not genuine purchase-price evidence/i);
      // May mention payment/downpayment only as unproven — never as a positive claim.
      expect(a.note).toMatch(/unproven/i);
      expect(a.note).not.toMatch(/\bis a (monthly )?payment\b|\bis a downpayment\b/i);

      const search = mandateToSearchParams(personalMandate);
      const q = qualifyListingConstraints({
        listing: listing(row),
        mandate: personalMandate,
        search,
      });
      expect(q.price.status).toBe("unknown");
      expect(q.hardConstraintVerified).toBe(false);

      const gates = runScoutGates({
        listing: listing(row),
        mandate: personalMandate,
        flip: null,
        historyStatus: "unknown",
      });
      expect(gates.allowInvestigate).toBe(false);
      expect(gates.claimsSafeBuy).toBe(false);

      const adverse = collectAdverseEvidence({
        vin: row.vin,
        listing: listing(row),
        disposition: "pending",
        evidence: [],
        flip: null,
        gates: gates.gates,
        withheld: gates.withheld,
        withholdReason: gates.withholdReason,
        rejectReason: null,
        dispositionRationale: null,
        historyStatus: "unknown",
        historyEvaluated: false,
        claimsSafeBuy: false,
        claimsVerifiedProfit: false,
      });
      expect(adverse.some((x) => x.kind === "missing_asking_price")).toBe(true);
      expect(adverse.every((x) => x.kind !== "bad_title_brand")).toBe(true);
    }
  });

  it("Tundra 5TFPC5DB3RX063497: seller-page Closing Fee cannot qualify (even above year-aware floor)", () => {
    // Mapped from post66-seller-price-evidence_eb54.md — "$525+ Closing Fee".
    const tundraFee = listing({
      vin: "5TFPC5DB3RX063497",
      year: 2024,
      model: "Tundra",
      priceUsd: 525,
      miles: 41_200,
      askingPriceKind: "dealer_fee",
      askingPriceProvenance: "seller_page_labeled",
      askingPriceLabel: "Closing Fee",
      askingPriceSellerPageAccess: "obtained",
    });
    const a = assessListingAskingPrice(tundraFee);
    expect(a.status).toBe("known_non_purchase");
    expect(a.kind).toBe("dealer_fee");
    expect(a.provenance).toBe("seller_page_labeled");
    expect(a.ambiguity).toBe("fee_vs_purchase");
    expect(a.usableForShortlist).toBe(false);
    expect(isListingAskingPriceUsable(tundraFee)).toBe(false);
    expect(a.note).toMatch(/dealer fee|Closing Fee/i);
    expect(a.note).toMatch(/not a verified vehicle purchase price/i);
    expect(a.note).not.toMatch(/\bis a (monthly )?payment\b/i);

    // Critical: fee kind blocks even when magnitude would clear year-aware floors.
    const feeAboveFloor = listing({
      vin: "5TFPC5DB3RX063497",
      year: 2024,
      model: "Tundra",
      priceUsd: 18_000,
      askingPriceKind: "dealer_fee",
      askingPriceProvenance: "seller_page_labeled",
      askingPriceLabel: "Closing Fee",
      askingPriceSellerPageAccess: "obtained",
    });
    expect(assessListingAskingPrice(feeAboveFloor).status).toBe("known_non_purchase");
    expect(isListingAskingPriceUsable(feeAboveFloor)).toBe(false);
    expect(
      qualifyListingConstraints({
        listing: feeAboveFloor,
        mandate: personalMandate,
        search: mandateToSearchParams(personalMandate),
      }).price.status,
    ).toBe("unknown");
    expect(
      runScoutGates({
        listing: feeAboveFloor,
        mandate: personalMandate,
        flip: null,
        historyStatus: "unknown",
      }).allowInvestigate,
    ).toBe(false);

    const ev = askingPriceEvidence(tundraFee);
    expect(ev.kind).toBe("unknown");
    expect(ev.value).toMatchObject({
      kind: "dealer_fee",
      provenance: "seller_page_labeled",
      ambiguity: "fee_vs_purchase",
      usableForShortlist: false,
      label: "Closing Fee",
    });
  });

  it("RAV4 seller-page access unavailable ⇒ unknown (not unavailable listing); Tacoma source-unverified", () => {
    const rav4 = listing({
      vin: "2T3C1RFV5SC305320",
      year: 2025,
      model: "RAV4",
      priceUsd: 549,
      askingPriceKind: "unknown",
      askingPriceProvenance: "feed_only",
      askingPriceSellerPageAccess: "unavailable",
    });
    const a = assessListingAskingPrice(rav4);
    expect(a.usableForShortlist).toBe(false);
    expect(a.ambiguity).toBe("access_unknown");
    expect(a.note).toMatch(/unknown/i);
    // Access unknown must not be narrated as proof the listing is gone.
    expect(a.note).not.toMatch(/\blisting (gone|removed)\b/i);
    expect(a.note).toMatch(/unavailable listing|access_unknown|source unknown/i);

    const tacoma = listing({
      vin: "3TMCZ5ANXLM360761",
      year: 2020,
      model: "Tacoma",
      priceUsd: 501,
      askingPriceKind: "unknown",
      askingPriceProvenance: "feed_only",
      askingPriceSellerPageAccess: "obtained",
    });
    const t = assessListingAskingPrice(tacoma);
    expect(t.usableForShortlist).toBe(false);
    expect(t.note).not.toMatch(/\bis a (monthly )?payment\b/i);
    expect(t.ambiguity === "fee_vs_purchase" || t.ambiguity === "source_unverified").toBe(true);
  });

  it("filterPool drops audit micro-asks so inventory does not promote them into shortlist", () => {
    const pool = filterPool(
      AUDIT_ROWS.map((r) => listing(r)),
      personalMandate,
      mandateToSearchParams(personalMandate),
    );
    expect(pool).toHaveLength(0);
  });

  it("credible in-budget seller ask still qualifies; over-cap still fails", () => {
    const ok = listing({
      vin: "4T1B11HK5JU000100",
      year: 2018,
      model: "Camry",
      priceUsd: 14_500,
    });
    expect(assessAskingPrice(ok.priceUsd, ok.year).status).toBe("usable_seller_claim");
    expect(isUsableAskingPriceUsd(ok.priceUsd, ok.year)).toBe(true);
    const search = mandateToSearchParams(personalMandate);
    expect(
      qualifyListingConstraints({ listing: ok, mandate: personalMandate, search }).price.status,
    ).toBe("pass");

    const over = listing({
      vin: "4T1B11HK5JU000101",
      year: 2018,
      model: "Camry",
      priceUsd: 22_000,
    });
    expect(
      qualifyListingConstraints({ listing: over, mandate: personalMandate, search }).price.status,
    ).toBe("fail");
  });

  it("mergeListingBaseEvidence preserves gov facts across gates.verify-style rewrite", () => {
    const l = listing({
      vin: "2T3C1RFV5SC305320",
      year: 2025,
      model: "RAV4",
      priceUsd: 14_900,
    });
    const prior = [
      {
        key: "evidence.gov_vpic",
        value: { errorCode: "0", year: 2025, make: "TOYOTA", model: "RAV4" },
        kind: "verified" as const,
        source: "gov",
        note: "vPIC VIN decode specs recorded (ErrorCode=0).",
      },
      {
        key: "evidence.gov_recalls",
        value: { recallCount: 3, parkIt: false },
        kind: "verified" as const,
        source: "gov",
        note: "NHTSA make/model/year campaigns recorded.",
      },
      {
        key: "evidence.gov_safety",
        value: { ratingAggregate: "rated", overall: 5 },
        kind: "verified" as const,
        source: "gov",
        note: "NHTSA configuration safety ratings recorded.",
      },
    ];
    const hist = historyEvidence(l);
    const rewritten = mergeListingBaseEvidence(prior, [
      ...identityEvidence(l),
      askingPriceEvidence(l),
      ...hist.facts,
    ]);
    expect(rewritten.some((e) => e.key === "evidence.gov_vpic" && e.kind === "verified")).toBe(
      true,
    );
    expect(rewritten.some((e) => e.key === "evidence.gov_recalls")).toBe(true);
    expect(rewritten.some((e) => e.key === "evidence.gov_safety")).toBe(true);
    expect(rewritten.some((e) => e.key === "asking_price_usd")).toBe(true);
    // Audit shape: six seller/history keys alone is the bug — gov keys must survive.
    expect(rewritten.map((e) => e.key)).toEqual(
      expect.arrayContaining([
        "vin",
        "year_make_model",
        "odometer_miles",
        "asking_price_usd",
        "accident_count",
        "owner_history",
        "evidence.gov_vpic",
        "evidence.gov_recalls",
        "evidence.gov_safety",
      ]),
    );
  });

  it("runScout: successful free-gov facts remain on investigation after gates.verify", async () => {
    const vin = "4T1B11HK5JU009900";
    const row = listing({
      vin,
      year: 2019,
      model: "Camry",
      priceUsd: 16_500,
      accidentCount: 0,
      ownerCount: 1,
    });

    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("DecodeVinValues")) {
        return new Response(
          JSON.stringify({
            Results: [
              {
                ErrorCode: "0",
                ErrorText: "",
                ModelYear: "2019",
                Make: "TOYOTA",
                Model: "Camry",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (u.includes("recallsByVehicle")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                NHTSACampaignNumber: "19V001",
                Component: "AIR BAGS",
                Summary: "Inflator",
                Consequence: "Injury",
                Remedy: "Replace",
                parkIt: false,
                parkOutSide: false,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (u.includes("complaintsByVehicle")) {
        return new Response(JSON.stringify({ count: 2, results: [{}] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("SafetyRatings/modelyear")) {
        return new Response(
          JSON.stringify({
            Count: 1,
            Results: [{ VehicleId: 9001, VehicleDescription: "2019 Toyota Camry" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (u.includes("SafetyRatings/VehicleId/9001")) {
        return new Response(
          JSON.stringify({
            Results: [
              {
                VehicleId: 9001,
                VehicleDescription: "2019 Toyota Camry",
                OverallRating: "5",
                OverallFrontCrashRating: "5",
                OverallSideCrashRating: "5",
                RolloverRating: "4",
                RolloverPossibility: 0.12,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;

    const result = await runScout({
      ownerId: "test:post66-evidence",
      mandateRaw: personalMandate,
      inventory: async () => ({
        ok: true as const,
        listings: [row],
        source: "live" as const,
        provenance: "test:post66-mapped-fixture",
        isFixture: false,
        providerCallsUsed: 0,
      }),
      gov: createLiveFreeGovPort({ fetch: fetchImpl }),
      autonomyClaim: "none",
      planner: mockServPlanner([
        {
          type: "run_tool",
          toolId: "evidence.gov_vpic",
          vin,
          reason: "mapped audit: vPIC before accept",
          servStepId: "step-1",
        },
        {
          type: "run_tool",
          toolId: "evidence.gov_recalls",
          vin,
          reason: "mapped audit: recalls before accept",
          servStepId: "step-2",
        },
        {
          type: "run_tool",
          toolId: "evidence.gov_safety",
          vin,
          reason: "mapped audit: safety before accept",
          servStepId: "step-3",
        },
        {
          type: "run_tool",
          toolId: "gates.verify",
          vin,
          reason: "mapped audit: accept after gov (must retain facts)",
          servStepId: "step-7",
        },
        { type: "finalize", reason: "done", servStepId: "f" },
      ]),
      budgets: { maxServCalls: 12, maxToolCalls: 20, maxProviderCalls: 0 },
    });

    expect(result.investigation).toHaveLength(1);
    const inv = result.investigation[0]!;
    expect(inv.evidence.some((e) => e.key === "evidence.gov_vpic" && e.kind === "verified")).toBe(
      true,
    );
    expect(inv.evidence.some((e) => e.key === "evidence.gov_recalls" && e.kind === "verified")).toBe(
      true,
    );
    expect(inv.evidence.some((e) => e.key === "evidence.gov_safety")).toBe(true);
    // Must not collapse to the six seller/history keys alone (audit failure mode).
    expect(inv.evidence.map((e) => e.key).filter((k) => k.startsWith("evidence.gov_")).length).toBeGreaterThanOrEqual(
      3,
    );
    expect(result.toolOutcomes.filter((o) => o.toolId.startsWith("evidence.gov_") && o.ok).length).toBeGreaterThanOrEqual(
      3,
    );
    expect(result.runDiagnostics?.evidenceRetention.investigationWithGovEvidence).toBe(1);
    expect(result.runDiagnostics?.terminationCause).toBe("planner_finalize");
    expect(inv.claimsSafeBuy).toBe(false);
  });

  it("runScout: audit-priced pool never enters investigation (reject / remap; not vehicle-defect)", async () => {
    const pool = AUDIT_ROWS.map((r) => listing(r));
    // Custom adapter returns raw rows (filterPool not applied here) — gates + sanitize
    // must still refuse shortlist promotion.
    const result = await runScout({
      ownerId: "test:post66-price",
      mandateRaw: personalMandate,
      inventory: async () => ({
        ok: true as const,
        listings: pool,
        source: "live" as const,
        provenance: "test:post66-audit-prices",
        isFixture: false,
        providerCallsUsed: 0,
      }),
      autonomyClaim: "none",
      planner: mockServPlanner([
        {
          type: "run_tool",
          toolId: "gates.verify",
          vin: pool[0]!.vin,
          reason: "try accept suspicious ask",
          servStepId: "s1",
        },
        {
          type: "run_tool",
          toolId: "evidence.gov_vpic",
          vin: pool[1]!.vin,
          reason: "free-gov must remap to missing_asking_price reject",
          servStepId: "s2",
        },
        { type: "abstain", reason: "no genuine purchase-price evidence", servStepId: "a1" },
      ]),
      budgets: { maxServCalls: 8, maxToolCalls: 20, maxProviderCalls: 0 },
    });

    expect(result.investigation).toHaveLength(0);
    expect(result.state).toBe("abstained");
    expect(result.candidates.some((c) => c.disposition === "rejected")).toBe(true);
    expect(result.runDiagnostics?.askingPrice.poolUsableForShortlist).toBe(0);
    expect(result.runDiagnostics?.terminationCause).toBe("planner_abstain");
  });
});
