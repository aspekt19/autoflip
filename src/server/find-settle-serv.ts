/**
 * When Find shortlist evidence settles, run the same shopper decide + challenge
 * path used by Check/report against a ComputedReport built from the pick.
 * Never invents listings or prices — numbers come from the scored pick only.
 */
import type { AgentSecondPassResult, AgentVerdict } from "@/domain/agent-verdict-schema";
import type { BestDealCandidate, BestDealResult } from "@/domain/find-best-deal";
import type { ComputedReport, Listing, Verdict } from "@/domain/types";
import { ASSUMPTIONS } from "@/domain/assumptions";
import { runShopperVerdictServ, type ShopperServTrace } from "@/server/shopper-verdict-serv";

function subjectFromPick(pick: BestDealCandidate): Listing {
  return {
    vin: pick.vin && pick.vin.length === 17 ? pick.vin : "FIND0000000000000",
    year: pick.year,
    make: pick.make,
    model: pick.model,
    trim: pick.trim ?? null,
    miles: pick.miles,
    priceUsd: pick.priceUsd,
    city: pick.city ?? null,
    state: pick.state ?? null,
    zip: null,
    dealer: pick.dealer ?? null,
    vdp: pick.vdp ?? null,
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

function verdictFromPick(pick: BestDealCandidate): Verdict {
  const priceFactor = pick.factors.find((f) => f.id === "price_vs_model_asks");
  if (priceFactor && priceFactor.points >= 8) return "good_deal";
  if (priceFactor && priceFactor.points >= 0) return "fair";
  if (priceFactor && priceFactor.points < 0) return "overpriced";
  return "insufficient_data";
}

/**
 * Build a Check-shaped report for the Find pick so verdict_decide/challenge can run.
 * Comps come only from the scored shortlist peers (never invented). Recalls are
 * "available" only when a free_gov_recalls factor was recorded on the pick.
 */
export function buildFindPickComputedReport(
  pick: BestDealCandidate,
  peers: readonly BestDealCandidate[] = [],
): ComputedReport {
  const fairMatch = pick.factors
    .find((f) => f.id === "price_vs_model_asks")
    ?.detail.match(/\$([0-9][0-9,]*)/);
  const fairValueUsd = fairMatch ? Number(fairMatch[1]!.replace(/,/g, "")) : null;
  const priceGap =
    fairValueUsd != null && pick.priceUsd != null && fairValueUsd > 0
      ? (pick.priceUsd - fairValueUsd) / fairValueUsd
      : null;
  const comps = peers
    .filter(
      (row) =>
        row.key !== pick.key &&
        row.priceUsd != null &&
        row.miles != null &&
        row.make.toLowerCase() === pick.make.toLowerCase() &&
        row.model.toLowerCase() === pick.model.toLowerCase(),
    )
    .slice(0, 12)
    .map((row) => ({
      vin: row.vin && row.vin.length === 17 ? row.vin : `FINDPEER${row.key}`.slice(0, 17).padEnd(17, "0"),
      year: row.year,
      trim: row.trim ?? null,
      miles: row.miles!,
      priceUsd: row.priceUsd!,
      adjustedPriceUsd: row.priceUsd!,
      city: row.city ?? null,
      state: row.state ?? null,
      distanceMiles: null,
    }));
  const recallsAvailable = pick.factors.some((factor) => factor.id === "mmy_recall_campaigns");
  return {
    mode: "personal",
    subject: subjectFromPick(pick),
    verdict: verdictFromPick(pick),
    score: pick.score,
    reasons: pick.factors.slice(0, 6).map((f) => f.detail).filter(Boolean),
    flags: [],
    questions: pick.sellerQuestions.slice(0, 6),
    comps,
    compScope: "Find shortlist similar asks (same make/model peers from this search)",
    percentile: null,
    fairValueUsd: Number.isFinite(fairValueUsd) ? fairValueUsd : null,
    fairRangeLowUsd: null,
    fairRangeHighUsd: null,
    fairConfidence: null,
    compMethodNote: "Peers are other Find shortlist cars with price and miles — not a closed-sale market study.",
    priceGap,
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
    dataNotes: pick.unknowns.slice(0, 8),
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
};

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
}): Promise<FindSettleServResult> {
  const pick = input.bestDeal.pick;
  if (!pick || !input.bestDeal.evidenceSettled) {
    return {
      ran: false,
      trace: null,
      agentVerdict: null,
      secondPass: {
        status: "not_run",
        action: null,
        objection: !pick
          ? "Second check not run: no pick was settled."
          : "Second check not run: free public checks are still settling the shortlist.",
        evidenceIds: [],
        confidenceBefore: null,
        confidenceAfter: null,
      },
    };
  }
  if (!input.servKey?.trim()) {
    // Code pick from selectBestDealOnEvidence stands — honest skip, not invented SERV.
    return {
      ran: false,
      trace: null,
      agentVerdict: null,
      secondPass: {
        status: "skipped_no_key",
        action: null,
        objection: "Second check not run: SERV_API_KEY is not configured on this deployment.",
        evidenceIds: [],
        confidenceBefore: null,
        confidenceAfter: null,
      },
    };
  }

  const peers = input.bestDeal.allRanked?.length
    ? input.bestDeal.allRanked
    : input.bestDeal.ranked;
  const report = buildFindPickComputedReport(pick, peers);
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
  });

  // Keep the code pick (selectBestDealOnEvidence). SERV only chooses buy/negotiate/pass
  // under TS guardrails + challenge — same pattern as Check (PR112).
  return {
    ran: Boolean(shopper.trace),
    trace: shopper.trace,
    agentVerdict: shopper.agentVerdict,
    secondPass:
      shopper.agentVerdict.second_pass ??
      ({
        status: "not_run",
        action: null,
        objection: "Second check not run: shopper SERV returned no challenge record.",
        evidenceIds: [],
        confidenceBefore: null,
        confidenceAfter: null,
      } satisfies AgentSecondPassResult),
  };
}
