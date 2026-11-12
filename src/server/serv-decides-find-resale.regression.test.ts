/**
 * Regression tests for live E2E defects on prod db05acf (10 Nov 2026).
 * Provenance: uploads/REPORT_f154.md (loyalspark-tumi@mail.grokbot.com signed-in run).
 * No paid SERV calls — fixtures are structural / recorded failure shapes only.
 */
import { describe, expect, it } from "vitest";
import { proposeDirections } from "@/domain/directions";
import type { Listing } from "@/domain/types";
import { emptyNeed } from "@/domain/need";
import { needFromResaleSearchInput, parseResaleSearchInput } from "@/domain/resale-search-input";
import { buildFindPickComputedReport } from "./find-settle-serv";
import { clampFlipPublishedAction } from "./resale-settle-serv";
import { describeServCallFailure } from "./resale-serv-call";
import type { BestDealCandidate } from "@/domain/find-best-deal";
import { FIND_NEXT_CHECK_RUBRIC_ID } from "@/domain/decision-proof-view";
import type { ResaleCandidatePnl } from "@/domain/resale-pnl";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_MODEL } from "@/server/serv";

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

  it("blocks buy/negotiate on park-outside stop even when parkIt is false", () => {
    const candidate = {
      ...reportResaleCandidate(),
      profitLowUsd: 500,
      profitMidUsd: 1_200,
      openParkIt: false,
      openParkOutside: true,
    };
    const buy = clampFlipPublishedAction("buy", candidate);
    expect(buy.overridden).toBe(true);
    expect(buy.action).toBe("pass");
    expect(buy.reason).toMatch(/park-outside/i);
    const negotiate = clampFlipPublishedAction("negotiate", candidate);
    expect(negotiate.overridden).toBe(true);
    expect(negotiate.action).toBe("pass");
  });
});

describe("P1 Resale: null-content refusal is a real labelled failure", () => {
  /**
   * Provenance: live Resale run on Nov 10, 2026 — job 45678673584e449bbdeb6c04eb0fdc5a.
   * Real failure shape: no response id, null message content (not an invented chatcmpl id).
   */
  it("describeServCallFailure names message_content_null_refusal_field (live job 45678673584e449bbdeb6c04eb0fdc5a)", () => {
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
        modelRequested: BASE_MODEL,
        modelReported: "gpt-5.4-mini-2026-03-17",
        reasoningEffort: null,
        contentFilter: "default_on",
        promptCache: "default",
        streamed: false,
        endpoint: "chat",
        // Live refusal: no response id; choices[0].message.content was null.
        openserv: {
          object: "chat.completion",
          choices: [{ finish_reason: "stop", message: { content: null, refusal: "content_filter" } }],
        },
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

describe("P1 artificial call cap removed", () => {
  it("resale settle source has no RESALE_SERV_CALL_CAP and no call-cap skip line", () => {
    const settleSrc = readFileSync(join(process.cwd(), "src/server/resale-settle-serv.ts"), "utf8");
    const journalSrc = readFileSync(join(process.cwd(), "src/domain/resale-decision-journal.ts"), "utf8");
    expect(journalSrc).not.toMatch(/RESALE_SERV_CALL_CAP/);
    expect(journalSrc).not.toMatch(/servCallCap/);
    expect(settleSrc).not.toMatch(/call cap reached/);
    expect(settleSrc).not.toMatch(/skipped_call_cap/);
  });
});

describe("P1 next-check honesty rubric id", () => {
  it("exposes FIND_NEXT_CHECK_RUBRIC_ID for proof records", () => {
    expect(FIND_NEXT_CHECK_RUBRIC_ID).toBe("lemonless.find_next_check_rubric.v1");
  });
});

describe("P1 Check: park-outside campaign is stop-level end-to-end via runCheck", () => {
  it("runCheck VIN dossier lowers agentVerdict.confidence when parkOutSide stop exists", async () => {
    const { runCheck } = await import("./check/run-check");
    const { TtlCache } = await import("@/io/cache");
    const { MemoryCounter } = await import("@/io/quota");
    const { MemoryKv } = await import("@/io/kv");
    // Campaign 20V543000 shape from REPORT Run 3 — parkIt false, parkOutSide true.
    const vin = "2HGFC3B33KH356212";
    let servCalls = 0;
    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("serv-mock.test")) {
        servCalls += 1;
        const body =
          servCalls === 1
            ? { verdict: "negotiate", note: "Ask is near the fair value from similar listings." }
            : { agrees: true, action: "negotiate", objection: null, evidenceIds: ["ev_fair_value"] };
        return Response.json({
          id: `synthetic-test-park-outside-${servCalls}`,
          model: BASE_MODEL,
          choices: [{ message: { content: JSON.stringify(body) } }],
        });
      }
      if (url.includes(`api.auto.dev/listings/${vin}`) || url.includes(`/listings/${vin}`)) {
        return Response.json({
          data: [
            {
              vin,
              vehicle: { year: 2019, make: "Honda", model: "Civic", trim: "EX" },
              retailListing: {
                price: 15_189,
                miles: 17_480,
                used: true,
                city: "Omaha",
                state: "NE",
                zip: "68114",
                dealer: "Optimus Auto",
                vdp: `https://dealer.example/vdp/${vin}`,
              },
            },
          ],
        });
      }
      if (url.includes("api.auto.dev/listings?")) {
        const rows = Array.from({ length: 10 }, (_, i) => ({
          vin: `2HGFC3B33KH35620${i}`,
          year: 2019,
          price: 14_500 + i * 150,
          miles: 16_000 + i * 800,
        }));
        return Response.json({
          data: rows.map((row) => ({
            vin: row.vin,
            vehicle: { year: row.year, make: "Honda", model: "Civic", trim: "EX" },
            retailListing: {
              price: row.price,
              miles: row.miles,
              used: true,
              city: "Omaha",
              state: "NE",
              zip: "68114",
              vdp: `https://dealer.example/vdp/${row.vin}`,
            },
          })),
        });
      }
      if (url.includes("DecodeVinValues")) {
        return Response.json({
          Results: [
            {
              ErrorCode: "0",
              ModelYear: "2019",
              Make: "HONDA",
              Model: "Civic",
              Trim: "EX",
              FuelTypePrimary: "Gasoline",
            },
          ],
        });
      }
      if (url.includes("recallsByVehicle")) {
        return Response.json({
          count: 1,
          results: [
            {
              NHTSACampaignNumber: "20V543000",
              Component: "ELECTRICAL SYSTEM",
              Summary: "Park outside fire risk guidance.",
              Consequence: "Fire risk.",
              Remedy: "Replace module.",
              ParkIt: false,
              ParkOutSide: true,
            },
          ],
        });
      }
      if (url.includes("complaintsByVehicle")) {
        return Response.json({ results: [], count: 0 });
      }
      if (url.includes("SafetyRatings")) {
        return Response.json({ Results: [] });
      }
      if (url.includes("fueleconomy") || url.includes("fuel")) {
        return Response.json({ menuItem: [] });
      }
      return new Response("{}", { status: 404 });
    };

    const result = await runCheck(
      { kind: "vin", vin, optionalZip: "68114" },
      {
        fetch: fetchImpl as unknown as typeof fetch,
        servKey: "test-serv-key",
        servModel: BASE_MODEL,
        servBaseUrl: "https://serv-mock.test/v1",
        autodevKey: "test-autodev",
        autodev: { cache: new TtlCache(), counter: new MemoryCounter() },
        kv: new MemoryKv(),
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.redFlags.some((f) => f.id === "park_outside" && f.level === "stop")).toBe(
      true,
    );
    expect(result.result.confidence).not.toBe("High");
    expect(result.result.agentVerdict.confidence).not.toBe("high");
    expect(["medium", "low"]).toContain(result.result.agentVerdict.confidence);
  });
});
