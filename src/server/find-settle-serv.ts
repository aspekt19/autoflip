/**
 * When Find shortlist evidence settles, run the same shopper decide + challenge
 * path used by Check/report against a ComputedReport built from the pick.
 * Never invents listings or prices — fair value + comps from evaluateListingPrice only.
 */
import type { AgentSecondPassResult, AgentVerdict } from "@/domain/agent-verdict-schema";
import type { BestDealCandidate, BestDealResult } from "@/domain/find-best-deal";
import {
  buildDecisionProofRecord,
  VERDICT_RUBRIC_ID,
  type DecisionProofRecord,
} from "@/domain/decision-proof-record";
import { evaluateListingPrice } from "@/domain/price-evaluation";
import type { ComputedReport, Listing, Verdict } from "@/domain/types";
import { ASSUMPTIONS } from "@/domain/assumptions";
import { runShopperVerdictServ, type ShopperServTrace } from "@/server/shopper-verdict-serv";

function listingFromCandidate(row: BestDealCandidate): Listing {
  const hasVin = Boolean(row.vin && row.vin.length === 17);
  return {
    vin: hasVin ? row.vin! : "FIND0000000000000",
    year: row.year,
    make: row.make,
    model: row.model,
    trim: row.trim ?? null,
    miles: row.miles,
    priceUsd: row.priceUsd,
    city: row.city ?? null,
    state: row.state ?? null,
    zip: null,
    dealer: row.dealer ?? null,
    vdp: row.vdp ?? null,
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
  };
}

function verdictFromEvaluation(verdict: Verdict): Verdict {
  return verdict;
}

/**
 * Build a Check-shaped report for the Find pick so verdict_decide/challenge can run.
 * Fair value and comps use the same adjusted-comparable path as ranking (line 9).
 * Recalls are "available" only when a free_gov_recalls factor was recorded on the pick.
 */
export function buildFindPickComputedReport(
  pick: BestDealCandidate,
  peers: readonly BestDealCandidate[] = [],
): ComputedReport {
  const subject = listingFromCandidate(pick);
  const vinPlaceholder = !(pick.vin && pick.vin.length === 17);
  const pool: Listing[] = [
    subject,
    ...peers
      .filter(
        (row) =>
          row.key !== pick.key &&
          row.priceUsd != null &&
          row.miles != null &&
          row.make.toLowerCase() === pick.make.toLowerCase() &&
          row.model.toLowerCase() === pick.model.toLowerCase(),
      )
      .map((row) => listingFromCandidate(row)),
  ];
  const evaluation = evaluateListingPrice(subject, pool, { mode: "personal" });
  const comps = evaluation.set.cars.slice(0, 12).map((car) => ({
    vin: car.vin && car.vin.length === 17 ? car.vin : "FINDPEER000000000".slice(0, 17),
    year: car.year,
    trim: car.trim ?? null,
    miles: car.miles,
    priceUsd: car.askingUsd,
    adjustedPriceUsd: car.adjustedUsd,
    city: car.city ?? null,
    state: car.state ?? null,
    distanceMiles: car.distanceMiles ?? null,
    sourceUrl: car.sourceUrl ?? null,
    sourceLabel: car.sourceLabel ?? null,
    adjustmentNotes: car.reasons.slice(0, 4),
  }));
  const recallsAvailable = pick.factors.some((factor) => factor.id === "mmy_recall_campaigns");
  const dataNotes = [
    ...pick.unknowns.slice(0, 8),
    ...(vinPlaceholder
      ? ["Subject VIN was missing on the Find pick — placeholder used for settle only, not a real VIN."]
      : []),
  ];
  return {
    mode: "personal",
    subject,
    verdict: verdictFromEvaluation(evaluation.priceVerdict),
    score: pick.score,
    reasons: pick.factors.slice(0, 6).map((f) => f.detail).filter(Boolean),
    flags: [],
    questions: pick.sellerQuestions.slice(0, 6),
    comps,
    compScope: "Adjusted similar asks from this Find shortlist (same evaluateListingPrice path as ranking)",
    percentile: evaluation.percentile01,
    fairValueUsd: evaluation.fairValueUsd,
    fairRangeLowUsd: evaluation.fairLowUsd,
    fairRangeHighUsd: evaluation.fairHighUsd,
    fairConfidence: evaluation.priced ? evaluation.set.confidence : null,
    compMethodNote: evaluation.methodNote,
    priceGap: evaluation.priceGap,
    mileage: {
      expectedMiles: null,
      subjectMiles: pick.miles,
      medianCompMiles: null,
      perMileUsd: null,
    },
    history: { multiplier: 1, lines: [] },
    recalls: [],
    recallsAvailable,
    openParkIt: false,
    openParkOutside: false,
    complaintCount: null,
    fuel: null,
    vinDecode: null,
    distanceToSearchZipMiles: null,
    flip: null,
    assumptions: { ...ASSUMPTIONS },
    dataNotes,
    sample: false,
  };
}

export type FindSettleServResult = {
  secondPass: AgentSecondPassResult;
  trace: ShopperServTrace | null;
  /** Shopper agentVerdict from decide+challenge (verdict + trail with model/response ids). */
  agentVerdict: AgentVerdict | null;
  /** True when decide+challenge HTTP ran. */
  ran: boolean;
  /** One proof record per SERV decision (or honest skip). */
  proofRecords: DecisionProofRecord[];
};

function emptySecondPass(
  objection: string,
  status: AgentSecondPassResult["status"] = "not_run",
): AgentSecondPassResult {
  return {
    status,
    action: null,
    objection,
    evidenceIds: [],
    confidenceBefore: null,
    confidenceAfter: null,
  };
}

/**
 * Run decide + challenge for the settled Find pick, or return an honest not_run record.
 */
export async function runFindSettleServ(input: {
  bestDeal: BestDealResult;
  servKey?: string;
  servBaseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  budgetUsd?: number | null;
  /** Injected for unit tests (unlisted models / single-shot mocks). Production omits. */
  transportPolicy?: "production" | "experiment_single_attempt";
}): Promise<FindSettleServResult> {
  const pick = input.bestDeal.pick;
  const recordedAt = new Date().toISOString();
  // Root cause (b): blocking on evidenceSettled skipped verdict_decide after the Find
  // loop already stopped with a pick — UI showed no Buy/Negotiate/Pass. Run decide
  // whenever a pick exists; soft evidence is noted on the challenge skip copy only.
  if (!pick) {
    return {
      ran: false,
      trace: null,
      agentVerdict: null,
      secondPass: emptySecondPass("Second check not run: no pick was settled."),
      proofRecords: [
        buildDecisionProofRecord({
          purpose: "verdict_decide",
          rubricId: VERDICT_RUBRIC_ID,
          status: "skipped_no_evidence",
          recordedAt,
          inputs: { reason: "no_pick" },
          detail: "Second check not run: no pick was settled.",
        }),
      ],
    };
  }
  if (!input.servKey?.trim()) {
    // Code pick from selectBestDealOnEvidence stands — honest skip, not invented SERV.
    return {
      ran: false,
      trace: null,
      agentVerdict: null,
      secondPass: emptySecondPass(
        "Second check not run: SERV_API_KEY is not configured on this deployment.",
        "skipped_no_key",
      ),
      proofRecords: [
        buildDecisionProofRecord({
          purpose: "verdict_decide",
          rubricId: VERDICT_RUBRIC_ID,
          status: "skipped_no_key",
          recordedAt,
          inputs: { vin: pick.vin, priceUsd: pick.priceUsd },
          detail: "Second check not run: SERV_API_KEY is not configured on this deployment.",
        }),
      ],
    };
  }

  const peers = input.bestDeal.allRanked?.length
    ? input.bestDeal.allRanked
    : input.bestDeal.ranked;
  const report = buildFindPickComputedReport(pick, peers);
  // Principle 4: no verified price evidence → do not call SERV; say why (unknown, not pass).
  const verifiedPrice =
    typeof report.subject.priceUsd === "number" &&
    Number.isFinite(report.subject.priceUsd) &&
    report.fairValueUsd != null &&
    report.comps.length >= 3;
  if (!verifiedPrice) {
    const detail =
      report.comps.length < 3
        ? `Second check not run: only ${report.comps.length} verified similar asks (need 3+).`
        : report.fairValueUsd == null
          ? "Second check not run: no verified fair value from similar asks."
          : "Second check not run: asking price is not verified.";
    return {
      ran: false,
      trace: null,
      agentVerdict: null,
      secondPass: emptySecondPass(detail),
      proofRecords: [
        buildDecisionProofRecord({
          purpose: "verdict_decide",
          rubricId: VERDICT_RUBRIC_ID,
          status: "skipped_no_evidence",
          recordedAt,
          inputs: {
            priceUsd: report.subject.priceUsd,
            fairValueUsd: report.fairValueUsd,
            compCount: report.comps.length,
          },
          detail,
        }),
      ],
    };
  }

  const shopper = await runShopperVerdictServ({
    report,
    mandate: {
      budgetUsd: input.budgetUsd ?? null,
      budgetKnown: input.budgetUsd != null,
    },
    servKey: input.servKey,
    servBaseUrl: input.servBaseUrl,
    model: input.model,
    fetchImpl: input.fetchImpl,
    transportPolicy: input.transportPolicy,
  });

  // Keep the code pick (selectBestDealOnEvidence). SERV only chooses buy/negotiate/pass
  // under TS guardrails + challenge — same pattern as Check (PR112).
  return {
    ran: Boolean(shopper.trace),
    trace: shopper.trace,
    agentVerdict: shopper.agentVerdict,
    secondPass:
      shopper.agentVerdict.second_pass ??
      emptySecondPass("Second check not run: shopper SERV returned no challenge record."),
    proofRecords: shopper.proofRecords,
  };
}
