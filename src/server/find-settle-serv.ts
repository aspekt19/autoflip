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
    // Missing VIN stays empty — never invent FIND* placeholders for the report or SERV.
    vin: hasVin ? row.vin! : "",
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
 * Fair value and comps use the same adjusted-comparable path as ranking/cards/Check.
 * Prefer `marketPool` (Find compsPool / same-model market listings) over shortlist peers —
 * shortlist alone often has &lt;3 same-model cars while the pool has 9–17.
 * Recalls are "available" only when a free_gov_recalls factor was recorded on the pick.
 */
export function buildFindPickComputedReport(
  pick: BestDealCandidate,
  peers: readonly BestDealCandidate[] = [],
  marketPool: readonly Listing[] = [],
): ComputedReport {
  const subject = listingFromCandidate(pick);
  const vinPlaceholder = !(pick.vin && pick.vin.length === 17);
  const peerListings = peers
    .filter(
      (row) =>
        row.key !== pick.key &&
        row.priceUsd != null &&
        row.miles != null &&
        row.make.toLowerCase() === pick.make.toLowerCase() &&
        row.model.toLowerCase() === pick.model.toLowerCase(),
    )
    .map((row) => listingFromCandidate(row));
  // Market pool first (cards/Check path); fall back to shortlist peers only when empty.
  const marketSameModel = marketPool.filter(
    (row) =>
      row.priceUsd != null &&
      row.miles != null &&
      row.make.toLowerCase() === pick.make.toLowerCase() &&
      row.model.toLowerCase() === pick.model.toLowerCase() &&
      !(pick.vin && row.vin && row.vin.toUpperCase() === pick.vin.toUpperCase()),
  );
  const pool: Listing[] = [
    subject,
    ...(marketSameModel.length > 0 ? marketSameModel : peerListings),
  ];
  const evaluation = evaluateListingPrice(subject, pool, { mode: "personal" });
  const comps = evaluation.set.cars.slice(0, 12).map((car) => ({
    // Keep real VIN or empty — never invent FINDPEER* placeholders.
    vin: car.vin && car.vin.length === 17 ? car.vin : "",
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
    ...(vinPlaceholder ? ["VIN not in listing"] : []),
  ];
  const usedMarket = marketSameModel.length > 0;
  return {
    mode: "personal",
    subject,
    verdict: verdictFromEvaluation(evaluation.priceVerdict),
    score: pick.score,
    reasons: pick.factors.slice(0, 6).map((f) => f.detail).filter(Boolean),
    flags: [],
    questions: pick.sellerQuestions.slice(0, 6),
    comps,
    compScope: usedMarket
      ? "Adjusted similar asks from the Find comps pool (same evaluateListingPrice path as cards/Check)"
      : "Adjusted similar asks from this Find shortlist (same evaluateListingPrice path as ranking)",
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
  /**
   * Full Find comps pool (same listings as cards/Check badges). Required for the
   * 3-comp verdict_decide gate when the shortlist has fewer than 3 same-model peers.
   */
  marketPool?: readonly Listing[];
  /** Injected for unit tests (unlisted models / single-shot mocks). Production omits. */
  transportPolicy?: "production" | "experiment_single_attempt";
}): Promise<FindSettleServResult> {
  let pick = input.bestDeal.pick;
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
  const marketPool = input.marketPool ?? [];
  // Prefer a finalist that already clears the 3-comp gate on the market pool so
  // SERV can decide (code ranking may have put a thin-comp car first).
  const finalists = (peers.length ? peers : [pick]).filter((row) => !row.excludedFromPick);
  const withEvidence = finalists.find((row) => {
    const probe = buildFindPickComputedReport(row, peers, marketPool);
    return (
      typeof probe.subject.priceUsd === "number" &&
      Number.isFinite(probe.subject.priceUsd) &&
      probe.fairValueUsd != null &&
      probe.comps.length >= 3
    );
  });
  if (withEvidence) pick = withEvidence;

  const report = buildFindPickComputedReport(pick, peers, marketPool);
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
            marketPoolSize: marketPool.length,
            shortlistPeers: peers.length,
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

  // Market comps unlock decide+challenge; SERV sets Buy/Negotiate/Pass under gates.
  // Numbers stay on evaluateListingPrice; confidence comes from the shopper trail.
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
