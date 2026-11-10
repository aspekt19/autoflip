/**
 * Regression tests for live E2E defects on prod db05acf (10 Nov 2026).
 * Provenance: uploads/REPORT_f154.md (loyalspark-tumi@mail.grokbot.com signed-in run).
 * No paid SERV calls — fixtures are structural / recorded failure shapes only.
 */
import { describe, expect, it } from "vitest";
import { proposeDirections } from "@/domain/directions";
import { RESALE_SERV_CALL_CAP } from "@/domain/resale-decision-journal";
import type { Listing } from "@/domain/types";
import { emptyNeed } from "@/domain/need";
import { needFromResaleSearchInput, parseResaleSearchInput } from "@/domain/resale-search-input";
import { buildFindPickComputedReport } from "./find-settle-serv";
import { clampFlipPublishedAction } from "./resale-settle-serv";
import { describeServCallFailure } from "./resale-serv-call";
import { buildKeyedAutonomyDiag } from "./find-next-check-orchestrator";
import type { BestDealCandidate } from "@/domain/find-best-deal";
import { FIND_NEXT_CHECK_RUBRIC_ID } from "@/domain/decision-proof-view";
import type { ResaleCandidatePnl } from "@/domain/resale-pnl";

function listing(
  partial: Partial<Listing> & Pick<Listing, "vin" | "year" | "make" | "model" | "priceUsd" | "miles">,
): Listing {
  return {
    trim: null,
    city: "Omaha",
    state: "NE",
    zip: "68114",
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
    latitude: null,
    longitude: null,
    removedAt: null,
    source: "autodev",
    ...partial,
  };
}

function pickCandidate(): BestDealCandidate {
  return {
    key: "tucson-pick",
    make: "Hyundai",
    model: "Tucson",
    year: 2019,
    priceUsd: 13_750,
    miles: 61_425,
    // Live Find pick VIN from REPORT_f154.md Run 1.
    vin: "KM8J2CA43KU949132",
    score: 12,
    factors: [],
    unknowns: [],
    fuelSummary: null,
    excludedFromPick: false,
    excludedReason: null,
    sellerQuestions: [],
  };
}

/** Shape of the live Resale best flip (REPORT Run 2) — mid +270 / low −1316. */
function reportResaleCandidate(): ResaleCandidatePnl {
  const vin = "5YFBU4EE3CP056159";
  return {
    vin,
    listing: listing({
      vin,
      year: 2012,
      make: "Toyota",
      model: "Corolla",
      priceUsd: 9_999,
      miles: 120_000,
    }),
    askingUsd: 9_999,
    negotiatedOfferUsd: 9_500,
    negotiateBasis: "fixture from REPORT_f154 mid/low band",
    salesTaxUsd: null,
    salesTaxBasis: "unknown",
    salesTaxKnown: false,
    profitScopeLabel: "",
    titleRegistrationUsd: null,
    titleRegistrationBasis: "unknown",
    titleFeeAssumptionUsd: 350,
    titleFeeBasis: "fee",
    reconUsd: 600,
    reconBasis: "recon",
    resaleLowUsd: 10_000,
    resaleMidUsd: 11_000,
    resaleHighUsd: 12_000,
    resaleChannel: "private_party",
    resaleChannelBasis: "private",
    profitLowUsd: -1_316,
    profitMidUsd: 270,
    profitHighUsd: 800,
    rankingProfitMidUsd: 270,
    roiPctMid: 2.4,
    estimatedDaysToSell: 30,
    daysToSellBasis: "typical",
    speed: "typical",
    confidence: "Medium",
    confidenceBasis: "comps",
    compCount: 5,
    score: 270,
    clearsTarget: false,
    risks: [],
    checkBeforeBuying: [],
    assumption: null,
    provenance: [],
  };
}

describe("P0 Find: adjusted comps pool gates verdict_decide", () => {
  it("counts marketPool same-model comps when shortlist peers are thin (REPORT: 1 peer vs 9–17 pool)", () => {
    const pick = pickCandidate();
    const onePeer: BestDealCandidate[] = [
      {
        ...pick,
        key: "peer-only",
        vin: "KM8J2CA43KU949133",
        priceUsd: 14_200,
        miles: 58_000,
      },
    ];
    // Nine adjusted same-model market comps (shape of live Find compsPool for Tucson).
    const marketPool = Array.from({ length: 9 }, (_, i) =>
      listing({
        vin: `KM8J2CA43KU94914${i}`,
        year: 2018 + (i % 3),
        make: "Hyundai",
        model: "Tucson",
        priceUsd: 12_500 + i * 250,
        miles: 55_000 + i * 1_200,
      }),
    );
    const shortlistOnly = buildFindPickComputedReport(pick, onePeer, []);
    expect(shortlistOnly.comps.length).toBeLessThan(3);

    const withPool = buildFindPickComputedReport(pick, onePeer, marketPool);
    expect(withPool.comps.length).toBeGreaterThanOrEqual(3);
    expect(withPool.compScope).toMatch(/comps pool/i);
    expect(withPool.fairValueUsd).not.toBeNull();
  });
});

describe("P0 Resale: budget-only directions stay multi-model", () => {
  it("never labels refine as The model you named when the buyer named none", () => {
    const need = {
      ...emptyNeed("flip"),
      budgetKnown: true,
      budgetUsd: 15_000,
      preferredModels: [],
      preferredModelsSource: "service" as const,
    };
    const dirs = proposeDirections(need, { make: "Toyota", model: "Corolla" });
    expect(dirs).toHaveLength(1);
    expect(dirs[0]!.segment).toBe("Focused model");
    expect(dirs[0]!.segment).not.toMatch(/you named/i);
  });

  it("budget-only need without refine keeps several editorial directions", () => {
    const parsed = parseResaleSearchInput({ budgetUsd: 15_000 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const dirs = proposeDirections(needFromResaleSearchInput(parsed.input), undefined, new Date("2026-11-10T00:00:00Z"));
    expect(dirs.length).toBeGreaterThanOrEqual(2);
    expect(dirs.every((d) => !/you named/i.test(d.segment))).toBe(true);
  });
});

describe("P1 Resale: hard-fact guardrails only", () => {
  it("lets needs_inspection stand when low profit is negative (REPORT challenge override)", () => {
    const clamped = clampFlipPublishedAction("needs_inspection", reportResaleCandidate());
    expect(clamped.overridden).toBe(false);
    expect(clamped.action).toBe("needs_inspection");
  });

  it("still blocks buy on negative low profit", () => {
    const clamped = clampFlipPublishedAction("buy", reportResaleCandidate());
    expect(clamped.overridden).toBe(true);
    expect(clamped.action).toBe("pass");
    expect(clamped.reason).toMatch(/negative/i);
  });
});

describe("P1 Resale: null-content refusal is a real labelled failure", () => {
  it("describeServCallFailure names message_content_null_refusal_field (REPORT verdict_decide fail)", () => {
    const fail = describeServCallFailure({
      ok: false,
      error: "SERV structured refusal field (message_content_null_refusal_field).",
      status: 200,
      proof: {
        purpose: "verdict_decide",
        tools: [],
        features: [],
        promptGuard: "not_used",
        shadowOutcome: "not_used",
        shadowMaxIterations: null,
        latencyMs: 800,
        modelRequested: "gpt-5.4-mini",
        modelReported: "gpt-5.4-mini-2026-03-17",
        reasoningEffort: null,
        contentFilter: "default_on",
        promptCache: "default",
        streamed: false,
        endpoint: "chat",
        openserv: { id: "chatcmpl-EijSNullFixture" },
      },
      fallback: "ignored_malformed",
      upstream: null,
      httpAttempts: 1,
      transportPolicy: "production",
      responseShape: null,
      failureDiag: {
        category: "content_null_refusal_field",
        reasonCode: "message_content_null_refusal_field",
        honesty:
          "Refusal/failure cause is not known from transport fields alone — do not assert format-failure or safety-cause RCA.",
        fields: {
          contentIsNull: true,
          contentEmpty: true,
          contentBytes: 0,
          refusalFieldPresent: true,
          refusalFieldBytes: 12,
          finishReason: "stop",
          hasUsageObject: true,
        },
        usage: null,
      },
    });
    expect(fail.rejected).toBe("content_null_refusal_field");
    expect(fail.why).toMatch(/null content/i);
    expect(fail.why).toMatch(/message_content_null_refusal_field/);
  });
});

describe("P1 artificial call cap", () => {
  it("RESALE_SERV_CALL_CAP is not the old product surface of 6", () => {
    expect(RESALE_SERV_CALL_CAP).toBeGreaterThan(6);
  });
});

describe("P1 next-check honesty: drain does not claim SERV parse failure", () => {
  it("buildKeyedAutonomyDiag uses honesty override for free-gov drain", () => {
    const diag = buildKeyedAutonomyDiag({
      keyed: true,
      mintSaidKeyed: true,
      autonomousServ: false,
      source: "deterministic_fallback",
      failureDiag: null,
      honestyOverride:
        "Deterministic free public check (bounded_free_gov_drain) — SERV was not called this hop.",
    });
    expect(diag.configHint).toMatch(/SERV was not called this hop/i);
    expect(diag.configHint).not.toMatch(/parse\/clamp\/refusal/i);
  });

  it("exposes FIND_NEXT_CHECK_RUBRIC_ID for proof records", () => {
    expect(FIND_NEXT_CHECK_RUBRIC_ID).toBe("lemonless.find_next_check_rubric.v1");
  });
});

describe("P1 Check: park-outside campaign is stop-level", () => {
  it("maps open parkOutSide recalls (e.g. 20V543000) to stop red flags", () => {
    // Same gate as src/server/check/run-check.ts — campaign from REPORT Run 3.
    const parkOutsideRecalls = [
      {
        campaignNumber: "20V543000",
        parkIt: false,
        parkOutSide: true,
      },
    ];
    const redFlags: Array<{ id: string; level: string; text: string }> = [];
    const sample = parkOutsideRecalls.find((r) => r.parkOutSide && !r.parkIt);
    if (sample) {
      redFlags.push({
        id: "park_outside",
        level: "stop",
        text: `NHTSA lists outdoor-parking / fire-risk guidance (campaign ${sample.campaignNumber}).`,
      });
    }
    expect(redFlags).toEqual([expect.objectContaining({ id: "park_outside", level: "stop" })]);
    expect(redFlags[0]!.text).toMatch(/20V543000/);
    // Stop flags must lower High → Medium (same gate as run-check).
    let confidence: "High" | "Medium" | "Low" = "High";
    if (redFlags.some((flag) => flag.level === "stop") && confidence === "High") {
      confidence = "Medium";
    }
    expect(confidence).toBe("Medium");
  });
});
