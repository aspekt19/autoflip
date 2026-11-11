/**
 * When Find shortlist evidence settles, SERV picks among eligible finalists
 * (verified ask + fair value + ≥3 comps), then decide + challenge run on that car.
 * Code ranking is the honest fallback when SERV is unavailable or rejects a hard rule.
 * Never invents listings or prices — fair value + comps from evaluateListingPrice only.
 */
import {
  moreConservativeConfidence,
  type AgentMultipathResult,
  type AgentSecondPassResult,
  type AgentVerdict,
  type AgentVerdictConfidence,
} from "@/domain/agent-verdict-schema";
import type { BestDealCandidate, BestDealResult } from "@/domain/find-best-deal";
import {
  buildDecisionProofRecord,
  VERDICT_RUBRIC_ID,
  type DecisionProofRecord,
} from "@/domain/decision-proof-record";
import { closeCallCars } from "@/domain/find-close-call";
import {
  capConfidenceForStopFlags,
  confidenceCapReasonForStop,
  stopFlagsForFindPick,
} from "@/domain/nhtsa-stop-flags";
import { evaluateListingPrice } from "@/domain/price-evaluation";
import type { ComputedReport, Listing, Verdict } from "@/domain/types";
import { ASSUMPTIONS } from "@/domain/assumptions";
import { providerResponseIdFromCall } from "@/domain/serv-response-id";
import { runFindCloseCallMultipathServ } from "@/server/find-close-call-serv";
import { chatCompletionContent, profile, runServ } from "@/server/serv";
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
    cpo: row.cpo ?? null,
    // Forward listing-feed facts when present — never invent zeros/clean history.
    accidentCount: row.accidentCount ?? null,
    oneOwner: row.oneOwner ?? null,
    ownerCount: row.ownerCount ?? null,
    usageType: row.usageType ?? null,
    fuel: row.fuel ?? null,
    engine: row.engine ?? null,
    drivetrain: row.drivetrain ?? null,
    bodyStyle: null,
    distanceMiles: row.distanceMiles ?? null,
    latitude: null,
    longitude: null,
    removedAt: null,
    source: "autodev",
  };
}

/** Consistent buyer/SERV accident line — one statement, never invented clean history. */
export function accidentHistoryFact(row: BestDealCandidate): string {
  if (row.accidentCount == null) {
    return "This listing does not say whether accidents were reported.";
  }
  if (row.accidentCount > 0) {
    return `This listing says ${row.accidentCount} accident${row.accidentCount === 1 ? "" : "s"} were reported.`;
  }
  return "This listing says no accidents were reported. That is the seller's claim, not a history report.";
}

/** Direct listing URL only — never Carfax/generic aggregator pages. */
function listingUrlForServ(row: BestDealCandidate): string | null {
  const href = row.vdp?.trim() || null;
  if (!href || !/^https?:\/\//i.test(href)) return null;
  try {
    const host = new URL(href).hostname.replace(/^www\./i, "").toLowerCase();
    if (host === "carfax.com" || host.endsWith(".carfax.com")) return null;
    return href;
  } catch {
    return null;
  }
}

/** Cap published confidence: never High next to Needs inspection. */
export function capConfidenceForNeedsInspection<T extends "high" | "medium" | "low">(
  confidence: T,
  verdict: string | null | undefined,
): T | "medium" {
  if (verdict === "needs_inspection" && confidence === "high") return "medium";
  return confidence;
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
  const recallsAvailable =
    pick.factors.some((factor) => factor.id === "mmy_recall_campaigns") ||
    pick.recallCampaignCount != null ||
    pick.stopSale === true ||
    pick.parkOutside === true;
  const dataNotes = [
    accidentHistoryFact(pick),
    ...pick.unknowns.filter((u) => !/accident/i.test(u)).slice(0, 7),
    ...(vinPlaceholder ? ["VIN not in listing"] : []),
  ];
  const stopTexts = [
    ...pick.factors.flatMap((factor) => [factor.id, factor.detail, factor.label]),
    ...pick.unknowns,
    ...pick.sellerQuestions,
    pick.stopSale ? "park-it stop-sale" : "",
    pick.parkOutside ? "park-outside" : "",
  ];
  const stop = stopFlagsForFindPick({ texts: stopTexts });
  const openParkIt = stop.openParkIt || pick.stopSale === true;
  const openParkOutside = stop.openParkOutside || pick.parkOutside === true;
  const usedMarket = marketSameModel.length > 0;
  return {
    mode: "personal",
    subject,
    verdict: verdictFromEvaluation(evaluation.priceVerdict),
    score: pick.score,
    reasons: pick.factors.slice(0, 6).map((f) => f.detail).filter(Boolean),
    flags: stop.flags.map((flag) => ({
      level: flag.level,
      source: "nhtsa-recalls" as const,
      text: flag.text,
    })),
    questions: pick.sellerQuestions.slice(0, 6),
    comps,
    // Prefer evaluation sampleSize for SERV notes — comps[] may be truncated for display.
    compSampleSize: evaluation.sampleSize > 0 ? evaluation.sampleSize : comps.length,
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
    history: {
      multiplier: 1,
      lines: [accidentHistoryFact(pick)].filter(Boolean),
    },
    recalls: [],
    recallsAvailable,
    openParkIt,
    openParkOutside,
    complaintCount: pick.complaintCount ?? null,
    fuel: null,
    vinDecode: null,
    distanceToSearchZipMiles: pick.distanceMiles ?? null,
    flip: null,
    assumptions: { ...ASSUMPTIONS },
    dataNotes,
    sample: false,
  };
}

export type FindSettleServResult = {
  /** Published shortlist after SERV (or code) pick — page must show this car. */
  bestDeal: BestDealResult;
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

function hasVerifiedPriceEvidence(report: ComputedReport): boolean {
  return (
    typeof report.subject.priceUsd === "number" &&
    Number.isFinite(report.subject.priceUsd) &&
    report.fairValueUsd != null &&
    report.comps.length >= 3
  );
}

function mapDealConfidence(
  level: AgentVerdictConfidence | null | undefined,
  fallback: BestDealResult["confidence"],
): "high" | "medium" | "low" {
  if (level === "high" || level === "medium" || level === "low") return level;
  if (fallback === "high" || fallback === "medium" || fallback === "low") return fallback;
  return "medium";
}

/** Buyer-visible code fact from the published pick (price factor first). */
function codeFactFromPick(pick: BestDealCandidate): string | null {
  const price = pick.factors.find((factor) => factor.id === "price_vs_model_asks");
  const detail = (price ?? pick.factors[0])?.detail?.trim();
  return detail ? detail.replace(/\s+/g, " ") : null;
}

const PRICE_FAIRNESS_UNSCORED_RE =
  /Not scored for fairness|provisional on price|treated as neutral \(\+0\)/i;
const PRICE_FAIRNESS_CLAIM_RE =
  /\b(?:well )?below fair(?: value)?\b|\b(?:well )?above fair(?: value)?\b|\bnear(?:er)?(?: to)? fair(?: value)?\b|\bfair value\b|\bsolid comps?\b/i;

/** True when the pick's price factor (or code fact text) says fairness was not scored. */
export function priceFairnessUnscored(
  pick: BestDealCandidate,
  codeFact?: string | null,
): boolean {
  const price = pick.factors.find((factor) => factor.id === "price_vs_model_asks");
  if (price && PRICE_FAIRNESS_UNSCORED_RE.test(price.detail)) return true;
  if (codeFact && PRICE_FAIRNESS_UNSCORED_RE.test(codeFact)) return true;
  return false;
}

/**
 * Drop fairness-claim wording when price fairness is unscored / provisional.
 * Keeps non-fairness bits of a SERV note; drops empty leftovers.
 */
export function scrubFairnessClaimsWhenUnscored(
  text: string | null | undefined,
  unscored: boolean,
): string | null {
  const raw = text?.trim().replace(/\s+/g, " ") || "";
  if (!raw) return null;
  if (!unscored || !PRICE_FAIRNESS_CLAIM_RE.test(raw)) return raw;
  const scrubbed = raw
    .replace(/\b(?:well )?below fair(?: value)?\b/gi, "")
    .replace(/\b(?:well )?above fair(?: value)?\b/gi, "")
    .replace(/\bnear(?:er)?(?: to)? fair(?: value)?(?: of \$[\d,]+)?\b/gi, "")
    .replace(/\bfair value(?: of \$[\d,]+)?\b/gi, "")
    .replace(/\bsolid comps?\b/gi, "")
    .replace(/[;,]\s*[;,]+/g, ";")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,;:.\-–—]+|[\s,;:.\-–—]+$/g, "")
    .trim();
  return scrubbed || null;
}

/**
 * Buyer-visible confidence line. Content comes from SERV's stated note plus a code
 * fact when present. Code fallback is labelled "code" — never the stale selectBestDeal
 * sentence ("clearly ahead on the checks…").
 */
function confidenceLineFor(
  confidence: Exclude<BestDealResult["confidence"], "none">,
  actor: "SERV" | "code",
  note: string | null,
  codeFact: string | null,
): string {
  const cap = confidence === "high" ? "High" : confidence === "medium" ? "Medium" : "Low";
  const noteBit = note?.trim() ? note.trim().replace(/\s+/g, " ") : "";
  const factBit = codeFact?.trim() ? codeFact.trim().replace(/\s+/g, " ") : "";
  if (actor === "SERV") {
    const bits = [noteBit, factBit && factBit !== noteBit ? factBit : ""].filter(Boolean);
    if (bits.length === 0) return `${cap}: chosen among eligible finalists.`;
    return `${cap}: ${bits.join(" ")}`.trim();
  }
  // Code fallback labelled as code (buyer-safe — no "SERV" token).
  const extra = noteBit || factBit;
  return extra ? `${cap}: code fallback. ${extra}`.trim() : `${cap}: code fallback.`;
}

/**
 * Publish SERV's (or labelled code-fallback) pick as the single source for the Find page:
 * choice.label / confidence / confidenceLine, pick first in ranked cards, rest keep order.
 */
export function publishBestDeal(input: {
  bestDeal: BestDealResult;
  pick: BestDealCandidate;
  confidence: BestDealResult["confidence"];
  actor: "SERV" | "code";
  /** SERV find_pick note (or null) — may only repeat numbers already in facts. */
  servNote?: string | null;
  /** Appended when stop-level NHTSA guidance capped High → Medium. */
  confidenceCapReason?: string | null;
}): BestDealResult {
  const confidence = input.confidence === "none" ? "medium" : input.confidence;
  const label = `${input.pick.year} ${input.pick.make} ${input.pick.model}`;
  const ask =
    input.pick.priceUsd != null ? `$${input.pick.priceUsd.toLocaleString("en-US")}` : "price not listed";
  const codeFact = codeFactFromPick(input.pick);
  const unscored = priceFairnessUnscored(input.pick, codeFact);
  const servNote = scrubFairnessClaimsWhenUnscored(input.servNote, unscored);
  const reasons: string[] = [];
  if (servNote) reasons.push(servNote);
  if (codeFact && codeFact !== servNote) reasons.push(codeFact);
  if (reasons.length === 0) {
    reasons.push(
      input.actor === "code"
        ? `${label} (${ask}) — published pick from code fallback.`
        : `${label} (${ask}) — chosen among eligible finalists.`,
    );
  }
  // Keep at most two reasons (FindChoice contract).
  const trimmedReasons = reasons.slice(0, 2);
  const priorPick = input.bestDeal.pick;
  const priorLabel =
    priorPick && priorPick.key !== input.pick.key
      ? `${priorPick.year} ${priorPick.make} ${priorPick.model}`
      : null;
  const capReason = input.confidenceCapReason?.trim() || null;
  const baseLine = confidenceLineFor(confidence, input.actor, servNote, codeFact);
  const choice = {
    label,
    runnerUpLabel: priorLabel ?? input.bestDeal.choice?.runnerUpLabel ?? null,
    reasons: trimmedReasons,
    confidence,
    confidenceLine: capReason ? `${baseLine} ${capReason}` : baseLine,
    confirmBeforeBuying: input.bestDeal.choice?.confirmBeforeBuying ?? [],
  };
  const movePickFirst = <T extends { key: string }>(rows: readonly T[]): T[] => {
    const hit = rows.find((row) => row.key === input.pick.key);
    if (!hit) return [...rows];
    return [hit, ...rows.filter((row) => row.key !== input.pick.key)];
  };
  const ranked = movePickFirst(input.bestDeal.ranked);
  const allRanked = movePickFirst(input.bestDeal.allRanked?.length ? input.bestDeal.allRanked : ranked);
  const why = [
    `Best choice on current data: ${label}.`,
    choice.confidenceLine,
    ...choice.reasons,
    input.bestDeal.settlementNote || null,
  ]
    .filter(Boolean)
    .join(" ");
  return {
    ...input.bestDeal,
    pick: input.pick,
    confidence,
    choice,
    ranked,
    allRanked,
    why,
  };
}

/**
 * Run Find settle: SERV picks among all eligible finalists, then decide+challenge
 * on that car. When SERV is unavailable, code pick + code verdict are labelled as code.
 * A verdict is always returned when a pick exists.
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
  const recordedAt = new Date().toISOString();
  const codePick = input.bestDeal.pick;
  if (!codePick) {
    return {
      bestDeal: input.bestDeal,
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

  const peers = input.bestDeal.allRanked?.length
    ? input.bestDeal.allRanked
    : input.bestDeal.ranked;
  const marketPool = input.marketPool ?? [];
  // Every eligible finalist — never `.find` the first car that clears the gate.
  const finalists = (peers.length ? peers : [codePick]).filter((row) => !row.excludedFromPick);
  const eligible = finalists
    .map((row) => ({
      row,
      report: buildFindPickComputedReport(row, peers, marketPool),
    }))
    .filter((item) => hasVerifiedPriceEvidence(item.report));

  if (eligible.length === 0) {
    const probe = buildFindPickComputedReport(codePick, peers, marketPool);
    const detail =
      probe.comps.length < 3
        ? `Second check not run: only ${probe.comps.length} verified similar asks (need 3+).`
        : probe.fairValueUsd == null
          ? "Second check not run: no verified fair value from similar asks."
          : "Second check not run: asking price is not verified.";
    return {
      bestDeal: input.bestDeal,
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
            priceUsd: probe.subject.priceUsd,
            fairValueUsd: probe.fairValueUsd,
            compCount: probe.comps.length,
            marketPoolSize: marketPool.length,
            shortlistPeers: peers.length,
            eligibleFinalists: 0,
          },
          detail,
        }),
      ],
    };
  }

  const codeEligible =
    eligible.find((item) => item.row.key === codePick.key)?.row ?? eligible[0]!.row;
  let pick = codeEligible;
  let pickActor: "SERV" | "code" = "code";
  let pickConfidence: AgentVerdictConfidence | null =
    input.bestDeal.confidence !== "none" ? input.bestDeal.confidence : null;
  let pickNote: string | null = null;
  let pickResponseId: string | null = null;
  let pickModel: string | null = input.model ?? null;
  let pickRecordedAt = recordedAt;
  const proofRecords: DecisionProofRecord[] = [];
  const fetchImpl = input.fetchImpl ?? fetch;
  const servKey = input.servKey?.trim() || "";
  let closeMultipath: AgentMultipathResult | null = null;

  // Near ties: SERV find_close_call_multipath (not code-only reconcileMultipathDeterministic).
  const tiedEligible = closeCallCars(eligible.map((item) => item.row));
  if (tiedEligible.length >= 2 || input.bestDeal.closeCall) {
    const close = await runFindCloseCallMultipathServ({
      cars: eligible.map((item) => item.row),
      servKey: servKey || null,
      servBaseUrl: input.servBaseUrl,
      model: input.model,
      fetchImpl,
      transportPolicy: input.transportPolicy,
    });
    proofRecords.push(...close.proofRecords);
    closeMultipath = close.multipath;
    // Only a live SERV close-call pick overrides the shortlist leader. Code
    // multipath fallback is for path display — it must not replace find_pick.
    if (close.source === "serv" && close.finalPickKey) {
      const fromClose = eligible.find((item) => item.row.key === close.finalPickKey)?.row;
      if (fromClose) {
        pick = fromClose;
        pickActor = "SERV";
        pickModel = input.model ?? null;
        pickRecordedAt = recordedAt;
        pickNote = close.multipath?.reconciliation ?? null;
        pickConfidence = pickConfidence ?? "medium";
      }
    }
  }

  // Multi-finalist SERV pick — every real fact per car (never invent).
  // Skip when close-call multipath already published a SERV pick among the tied group.
  if (servKey && !(pickActor === "SERV" && closeMultipath?.source === "serv")) {
    const allowedKeys = eligible.map((item) => item.row.key);
    const allowedEvidenceIds = eligible.flatMap((item) => [
      `car:${item.row.key}`,
      `ask:${item.row.key}`,
      `fair:${item.row.key}`,
      `comps:${item.row.key}`,
      `miles:${item.row.key}`,
      `history:${item.row.key}`,
      `recalls:${item.row.key}`,
      `listing:${item.row.key}`,
    ]);
    const facts = {
      allowedKeys,
      allowedEvidenceIds,
      evidence: allowedEvidenceIds.map((id) => {
        const [kind, key] = id.split(":");
        const row = eligible.find((item) => item.row.key === key)?.row;
        const report = eligible.find((item) => item.row.key === key)?.report;
        if (!row || !report) return { id, text: id };
        if (kind === "car") return { id, text: `${row.year} ${row.make} ${row.model}` };
        if (kind === "ask") return { id, text: `Asking price $${report.subject.priceUsd ?? "unknown"}` };
        if (kind === "fair") return { id, text: `Fair value $${report.fairValueUsd ?? "unknown"}` };
        if (kind === "comps") return { id, text: `${report.comps.length} similar asks` };
        if (kind === "miles") return { id, text: `Odometer ${row.miles ?? "unknown"} miles` };
        if (kind === "history") return { id, text: accidentHistoryFact(row) };
        if (kind === "recalls") {
          return {
            id,
            text: row.stopSale
              ? "Stop-sale / park-until-fixed recall guidance is open for this year and model"
              : row.recallCampaignCount != null
                ? `${row.recallCampaignCount} recall campaign(s) on file for this year and model`
                : "Recall campaigns not confirmed for this year and model",
          };
        }
        return { id, text: listingUrlForServ(row) ?? "No direct listing link" };
      }),
      finalists: eligible.map((item) => {
        const row = item.row;
        const report = item.report;
        return {
          key: row.key,
          label: `${row.year} ${row.make} ${row.model}`,
          vin: row.vin && row.vin.length === 17 ? row.vin : null,
          year: row.year,
          make: row.make,
          model: row.model,
          trim: row.trim ?? null,
          drivetrain: row.drivetrain ?? null,
          askUsd: report.subject.priceUsd,
          fairValueUsd: report.fairValueUsd,
          adjustedComps: report.comps.slice(0, 8).map((c) => ({
            year: c.year,
            miles: c.miles,
            askUsd: c.priceUsd,
            adjustedUsd: c.adjustedPriceUsd,
          })),
          compCount: report.comps.length,
          priceGap: report.priceGap,
          miles: row.miles,
          accidentCount: row.accidentCount ?? null,
          accidentHistory: accidentHistoryFact(row),
          ownerCount: row.ownerCount ?? null,
          oneOwner: row.oneOwner ?? null,
          recallCampaignCount: row.recallCampaignCount ?? null,
          stopSale: row.stopSale === true,
          parkOutside: row.parkOutside === true,
          complaintCount: row.complaintCount ?? null,
          ncapOverall: row.ncapOverall ?? null,
          distanceMiles: row.distanceMiles ?? report.distanceToSearchZipMiles ?? null,
          listingUrl: listingUrlForServ(row),
        };
      }),
      // Code shortlist order is not ranking authority — SERV chooses among allowlisted keys.
      codeFallbackKey: codeEligible.key,
    };
    const judged = await runServ(
      "find_pick",
      { user: JSON.stringify({ facts }) },
      {
        fetch: fetchImpl,
        apiKey: servKey,
        baseUrl: input.servBaseUrl,
        model: input.model,
        transportPolicy: input.transportPolicy,
        timeoutMs: profile("find_pick").timeoutMs,
      },
    );
    let payload: Record<string, unknown> | null = null;
    if (judged.ok && judged.text?.trim()) {
      try {
        const parsed = JSON.parse(judged.text) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          payload = parsed as Record<string, unknown>;
        }
      } catch {
        payload = null;
      }
    }
    const pickKey = typeof payload?.pickKey === "string" ? payload.pickKey.trim() : "";
    const allow = new Set(allowedKeys);
    const hardRuleOk = Boolean(pickKey && allow.has(pickKey));
    const rawResponse =
      chatCompletionContent(judged.proof?.openserv) ??
      (judged.ok ? judged.text : null) ??
      null;
    const responseId = providerResponseIdFromCall({
      ok: judged.ok && hardRuleOk,
      id: typeof judged.proof?.openserv?.id === "string" ? judged.proof.openserv.id : null,
    });
    let pickAlternatives: string[] = [];
    let pickWatchFor: string[] = [];
    let pickReasons: string[] = [];
    if (judged.ok && hardRuleOk && payload) {
      pick = eligible.find((item) => item.row.key === pickKey)!.row;
      pickActor = "SERV";
      const conf = payload.confidence;
      if (conf === "high" || conf === "medium" || conf === "low") pickConfidence = conf;
      pickNote = typeof payload.note === "string" ? payload.note.trim() || null : null;
      if (Array.isArray(payload.alternatives)) {
        pickAlternatives = payload.alternatives
          .filter((k): k is string => typeof k === "string" && allowedKeys.includes(k) && k !== pickKey)
          .slice(0, 3);
      }
      if (Array.isArray(payload.reasons)) {
        pickReasons = payload.reasons
          .filter((r): r is string => typeof r === "string" && r.trim().length > 0)
          .map((r) => r.trim())
          .slice(0, 4);
      }
      if (Array.isArray(payload.watchFor)) {
        pickWatchFor = payload.watchFor
          .filter((r): r is string => typeof r === "string" && r.trim().length > 0)
          .map((r) => r.trim())
          .slice(0, 4);
      }
      if (!pickNote && pickReasons.length > 0) pickNote = pickReasons.join(" ");
      pickModel = judged.proof?.modelReported ?? judged.proof?.modelRequested ?? input.model ?? null;
      pickRecordedAt = recordedAt;
      const findPickProof = buildDecisionProofRecord({
        purpose: "find_pick",
        rubricId: VERDICT_RUBRIC_ID,
        status: "ok",
        recordedAt: pickRecordedAt,
        responseId,
        model: pickModel,
        inputs: {
          allowedKeys,
          codeFallbackKey: codeEligible.key,
          chosenKey: pick.key,
          alternatives: pickAlternatives,
          watchFor: pickWatchFor,
          eligibleFinalists: eligible.length,
        },
        verdict: typeof payload.action === "string" ? payload.action : null,
        rawResponse,
        detail:
          typeof payload.note === "string" && payload.note.trim()
            ? payload.note.trim()
            : `SERV picked ${pick.year} ${pick.make} ${pick.model} among ${eligible.length} eligible finalists.`,
      });
      pickResponseId = findPickProof.servResponseId;
      proofRecords.push(findPickProof);
      // Stash buyer-facing extras on the note when present.
      if (pickWatchFor.length > 0) {
        pickNote = [pickNote, `Watch for: ${pickWatchFor.join("; ")}`].filter(Boolean).join(" ");
      }
    } else {
      const rejectWhy = !judged.ok
        ? judged.failureDiag?.honesty ||
          judged.failureDiag?.reasonCode ||
          judged.error ||
          "SERV find_pick did not finish."
        : !pickKey
          ? "SERV find_pick omitted pickKey — code fallback stands."
          : `SERV pickKey ${pickKey} is not in allowedKeys — hard rule reject; code fallback stands.`;
      pick = codeEligible;
      pickActor = "code";
      pickModel = judged.proof?.modelReported ?? judged.proof?.modelRequested ?? input.model ?? null;
      pickRecordedAt = recordedAt;
      pickResponseId = null;
      proofRecords.push(
        buildDecisionProofRecord({
          purpose: "find_pick",
          rubricId: VERDICT_RUBRIC_ID,
          status: judged.ok ? "failed" : "failed",
          recordedAt: pickRecordedAt,
          responseId: null,
          model: pickModel,
          inputs: {
            allowedKeys,
            codeFallbackKey: codeEligible.key,
            rejectedPickKey: pickKey || null,
            eligibleFinalists: eligible.length,
          },
          rawResponse,
          detail: `${rejectWhy} Published pick labelled as code fallback.`,
        }),
      );
    }
  } else {
    pickRecordedAt = recordedAt;
    pickResponseId = null;
    pickModel = input.model ?? null;
    proofRecords.push(
      buildDecisionProofRecord({
        purpose: "find_pick",
        rubricId: VERDICT_RUBRIC_ID,
        status: "skipped_no_key",
        recordedAt: pickRecordedAt,
        inputs: {
          codeFallbackKey: codeEligible.key,
          eligibleFinalists: eligible.length,
        },
        detail:
          "Find pick by code fallback — SERV_API_KEY is not configured on this deployment (not a SERV pick).",
      }),
    );
  }

  const report = buildFindPickComputedReport(pick, peers, marketPool);
  const hasStop = Boolean(report.openParkIt || report.openParkOutside);
  const stopCapReason = confidenceCapReasonForStop(hasStop);
  const screeningConfidence: AgentVerdictConfidence | null = capConfidenceForStopFlags(
    pickConfidence ??
      (input.bestDeal.confidence !== "none" ? input.bestDeal.confidence : "medium"),
    hasStop,
  );

  const shopper = await runShopperVerdictServ({
    report,
    mandate: {
      budgetUsd: input.budgetUsd ?? null,
      budgetKnown: input.budgetUsd != null,
    },
    servKey: servKey || undefined,
    servBaseUrl: input.servBaseUrl,
    model: input.model,
    fetchImpl,
    transportPolicy: input.transportPolicy,
    screeningConfidence,
  });

  // One buyer-facing confidence = minimum of pick / decide / challenge / caps.
  // Never High next to Needs inspection; stop-level park flags never publish High.
  const shopperVerdict = shopper.agentVerdict.verdict;
  const challengeAfter = shopper.agentVerdict.second_pass?.confidenceAfter ?? null;
  const minSteps = moreConservativeConfidence(
    moreConservativeConfidence(pickConfidence, shopper.agentVerdict.confidence),
    challengeAfter,
  );
  const rawPublished = mapDealConfidence(
    minSteps,
    input.bestDeal.confidence === "none" ? "medium" : input.bestDeal.confidence,
  );
  const afterStop = capConfidenceForStopFlags(rawPublished, hasStop);
  const publishedConfidence = capConfidenceForNeedsInspection(afterStop, shopperVerdict);
  const intendedHigh =
    rawPublished === "high" ||
    pickConfidence === "high" ||
    input.bestDeal.confidence === "high" ||
    shopper.agentVerdict.confidence === "high";
  const confidenceWasCapped = Boolean(
    publishedConfidence !== "high" &&
      intendedHigh &&
      (hasStop || shopperVerdict === "needs_inspection"),
  );
  let agentVerdict = shopper.agentVerdict;
  if (agentVerdict) {
    const pickLabel = `${pick.year} ${pick.make} ${pick.model}`;
    const cappedAgentConfidence = capConfidenceForNeedsInspection(
      capConfidenceForStopFlags(
        (minSteps ??
          shopper.agentVerdict.confidence ??
          pickConfidence ??
          agentVerdict.confidence ??
          "medium") as AgentVerdictConfidence,
        hasStop,
      ),
      shopperVerdict,
    );
    const pickStep = {
      decided:
        pickActor === "SERV"
          ? `SERV picked ${pickLabel} among ${eligible.length} eligible finalists.`
          : `Code picked ${pickLabel} among ${eligible.length} eligible finalists (not SERV).`,
      why:
        pickActor === "SERV"
          ? "Published Find pick comes from SERV find_pick under allowlisted finalist facts."
          : servKey
            ? "SERV pick was unavailable or broke a hard allowlist rule — code fallback stands."
            : "SERV_API_KEY is not configured — code fallback is the published pick.",
      changed: pick.key !== codePick.key ? `Earlier code shortlist led with ${codePick.key}.` : null,
      model: pickModel,
      responseId: pickResponseId,
      recordedAt: pickRecordedAt,
    };
    const trailExtra =
      confidenceWasCapped
        ? [
            {
              decided:
                shopperVerdict === "needs_inspection" && !hasStop
                  ? "Lowered from High: verdict is Needs inspection."
                  : stopCapReason ?? "Confidence capped for buyer safety.",
              why:
                shopperVerdict === "needs_inspection" && !hasStop
                  ? "Needs inspection never publishes High confidence."
                  : "Stop-level NHTSA park-it or park-outside guidance is open on the published pick.",
              changed: "Published confidence capped from High to Medium.",
              model: pickModel,
              responseId: pickResponseId,
              recordedAt: pickRecordedAt,
            },
          ]
        : [];
    agentVerdict = {
      ...agentVerdict,
      pick: { key: pick.key, label: pickLabel },
      confidence: cappedAgentConfidence,
      // Prefer live close-call multipath (SERV or labelled code fallback) over any
      // earlier code-only reconcile baked into the shopper verdict.
      multipath: closeMultipath ?? agentVerdict.multipath ?? null,
      serv_steps: [pickStep, ...trailExtra, ...(agentVerdict.serv_steps ?? [])],
      no_serv_step: pickActor === "SERV" ? false : agentVerdict.no_serv_step,
    };
  }

  return {
    bestDeal: publishBestDeal({
      bestDeal: input.bestDeal,
      pick,
      confidence: publishedConfidence,
      actor: pickActor,
      servNote: pickNote,
      confidenceCapReason: confidenceWasCapped ? stopCapReason : null,
    }),
    ran: Boolean(shopper.trace) || pickActor === "SERV",
    trace: shopper.trace,
    agentVerdict,
    secondPass: (() => {
      if (!servKey) {
        return emptySecondPass(
          "Second check not run: SERV_API_KEY is not configured on this deployment.",
          "skipped_no_key",
        );
      }
      return (
        shopper.agentVerdict.second_pass ??
        emptySecondPass("Second check not run: shopper SERV returned no challenge record.")
      );
    })(),
    proofRecords: [...proofRecords, ...shopper.proofRecords],
  };
}
