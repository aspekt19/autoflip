/**
 * Offline ledger replay of PR63 third live primary failure (run ff52a261… on de5eb0c).
 * Sanitized evidence only — no network / paid / provider calls.
 *
 * Failure shape:
 * - live Auto.dev returned 20 placeholder asks ($1–$59) under price=1-20000 + sort=price
 * - planner reject cited missing_asking_price@price → reject_rationale_not_grounded
 * - third identical reject signature → no-progress stop (not a SERV call-count)
 * - all pending; no shortlist; no gov
 */
import { describe, expect, it } from "vitest";
import type { Listing } from "@/domain/types";
import {
  MIN_USABLE_ASKING_PRICE_USD,
  collectAdverseEvidence,
  filterPool,
  mandateToSearchParams,
  mockServPlanner,
  runScout,
  searchQueryRanges,
  validateDispositionAction,
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

/** Observed placeholder ask ladder from sanitized live evidence (order preserved). */
const OBSERVED_PLACEHOLDER_PRICES = [
  1, 10, 10, 10, 15, 15, 37, 37, 50, 50, 50, 50, 59, 59, 59, 59, 59, 59, 59, 59,
] as const;

const FIRST_VIN = "4TAWM72N3WZ162673";

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

function placeholderPool(): Listing[] {
  return OBSERVED_PLACEHOLDER_PRICES.map((price, i) =>
    listing({
      vin: i === 0 ? FIRST_VIN : `4TAWM72N3WZ${String(100000 + i).slice(-6)}`,
      priceUsd: price,
    }),
  );
}

describe("placeholder-price recovery (PR63 live ff52a261 ledger replay)", () => {
  it("reproduces reject_rationale_not_grounded for missing_asking_price@price before fix path is exercised", () => {
    // Document the live citation shape: kind + gateId "price" from constraint field name.
    const cand = pendingCand(listing({ vin: FIRST_VIN, priceUsd: 1 }));
    const adverse = collectAdverseEvidence(cand);
    expect(adverse.some((a) => a.kind === "missing_asking_price")).toBe(true);

    const liveCitationShape = validateDispositionAction({
      action: "reject",
      vin: FIRST_VIN,
      reason: "placeholder ask cannot unlock investigation",
      candidate: cand,
      recentOutcomes: [],
      rationaleKind: "adverse_evidence",
      citedEvidence: [{ kind: "missing_asking_price", gateId: "price" }],
    });
    // After fix this must be ok — placeholder is pipeline-unusable, not invented car-bad proof.
    expect(liveCitationShape.ok).toBe(true);
  });

  it("Auto.dev scout price query must not start at $1 when budget allows usable retail floor", () => {
    const params = mandateToSearchParams(personalMandate);
    expect(params.maxPriceUsd).toBe(20_000);
    const ranges = searchQueryRanges(params);
    // Search floor is the credible search min when budget allows — not the $500 placeholder band alone.
    expect(ranges.priceRange).toBe(`3000-20000`);
    expect(MIN_USABLE_ASKING_PRICE_USD).toBe(500);
    expect(ranges.priceRange).not.toMatch(/^1-/);
  });

  it("filterPool drops positive placeholder asks under a priced search (null ask kept as unknown)", () => {
    const search = mandateToSearchParams(personalMandate);
    const rows = [
      listing({ vin: FIRST_VIN, priceUsd: 1 }),
      listing({ vin: "4T1B11HK5JU009999", priceUsd: 12_000 }),
      listing({ vin: "4T1B11HK5JU008888", priceUsd: null }),
    ];
    const filtered = filterPool(rows, personalMandate, search);
    expect(filtered.map((r) => r.vin).sort()).toEqual(
      ["4T1B11HK5JU008888", "4T1B11HK5JU009999"].sort(),
    );
  });

  it("offline ledger: live reject@price + abstain completes honestly (no no-progress fail, no shortlist)", async () => {
    const pool = placeholderPool();
    expect(pool).toHaveLength(20);
    expect(pool.every((l) => l.priceUsd != null && l.priceUsd < MIN_USABLE_ASKING_PRICE_USD)).toBe(
      true,
    );

    // Inventory adapter returns the sanitized placeholder pool (as live did before floor fix).
    // Runner still must not crash into repeated identical deny → no-progress.
    const result = await runScout({
      ownerId: "owner-placeholder-recovery",
      mandateRaw: personalMandate,
      inventory: async () => ({
        ok: true as const,
        listings: pool,
        source: "live" as const,
        provenance:
          "offline-ledger:api.auto.dev/listings makes=Toyota; models=*; price=sanitized-placeholders; cached=false; quota used 22/900",
        isFixture: false,
        providerCallsUsed: 0,
      }),
      autonomyClaim: "none",
      planner: mockServPlanner([
        {
          type: "reject",
          vin: FIRST_VIN,
          reason: "missing usable asking price",
          servStepId: "step-1",
          rationaleKind: "adverse_evidence",
          // Exact live citation shape that previously failed grounding.
          citedEvidence: [{ kind: "missing_asking_price", gateId: "price" }],
        },
        {
          type: "reject",
          vin: FIRST_VIN,
          reason: "retry same signature",
          servStepId: "step-2",
          rationaleKind: "adverse_evidence",
          citedEvidence: [{ kind: "missing_asking_price", gateId: "price" }],
        },
        {
          type: "abstain",
          reason:
            "No verified options — all observed asks are placeholder/unknown; not a provider failure.",
          servStepId: "step-3",
        },
      ]),
      budgets: {
        maxServCalls: null,
        maxToolCalls: 40,
        maxProviderCalls: 3,
        maxWallMs: 120_000,
      },
    });

    expect(result.failReason).not.toBe("budget_exhausted");
    expect(result.message ?? "").not.toMatch(/Repeated identical planner action|no-progress/i);
    expect(result.state).toBe("abstained");
    expect(result.investigation).toHaveLength(0);
    expect(result.partial).toBe(false);

    const rejectOutcomes = result.toolOutcomes.filter((o) => o.toolId === "candidate.reject");
    expect(rejectOutcomes.length).toBeGreaterThanOrEqual(1);
    expect(rejectOutcomes[0]?.ok).toBe(true);
    expect(rejectOutcomes[0]?.summary ?? "").not.toMatch(/reject_rationale_not_grounded/);

    const first = result.candidates.find((c) => c.vin === FIRST_VIN);
    expect(first?.disposition).toBe("rejected");
    // Grounded reason must not invent car-bad / title / history claims from placeholder ask.
    expect(first?.rejectReason ?? "").toMatch(/missing_asking_price|usable|placeholder|unusable/i);
    expect(first?.rejectReason ?? "").not.toMatch(/salvage|lemon title|car is bad/i);
  });

  it("when adapter already filtered to zero usable asks → honest empty abstain (not provider_unavailable)", async () => {
    const result = await runScout({
      ownerId: "owner-placeholder-empty",
      mandateRaw: personalMandate,
      inventory: async () => ({
        ok: false as const,
        error: "inventory_empty" as const,
        message:
          "Live Auto.dev inventory produced zero listings after mandate filter (placeholder/unusable asks excluded).",
        providerCallsUsed: 1,
        isFixture: false,
      }),
      autonomyClaim: "none",
      planner: mockServPlanner([{ type: "finalize", reason: "unreachable", servStepId: "x" }]),
      budgets: { maxServCalls: null, maxToolCalls: 10, maxProviderCalls: 3 },
    });
    expect(result.state).toBe("abstained");
    expect(result.failReason).toBeNull();
    expect(result.message).toMatch(/zero listings|mandate filter|placeholder|unusable/i);
    expect(result.investigation).toHaveLength(0);
  });
});
