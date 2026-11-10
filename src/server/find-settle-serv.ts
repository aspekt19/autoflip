/**
 * When Find shortlist evidence settles, SERV picks among eligible finalists
 * (verified ask + fair value + ≥3 comps), then decide + challenge run on that car.
 * Code ranking is the honest fallback when SERV is unavailable or rejects a hard rule.
 * Never invents listings or prices — fair value + comps from evaluateListingPrice only.
 */
import type { AgentSecondPassResult, AgentVerdict, AgentVerdictConfidence } from "@/domain/agent-verdict-schema";
import type { BestDealCandidate, BestDealResult } from "@/domain/find-best-deal";
import {
  buildDecisionProofRecord,
  VERDICT_RUBRIC_ID,
  type DecisionProofRecord,
} from "@/domain/decision-proof-record";
import { evaluateListingPrice } from "@/domain/price-evaluation";
import type { ComputedReport, Listing, Verdict } from "@/domain/types";
import { ASSUMPTIONS } from "@/domain/assumptions";
import { providerResponseIdFromCall } from "@/domain/serv-response-id";
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
): BestDealResult["confidence"] {
  if (level === "high" || level === "medium" || level === "low") return level;
  return fallback;
}

function publishBestDeal(
  bestDeal: BestDealResult,
  pick: BestDealCandidate,
  confidence: BestDealResult["confidence"],
): BestDealResult {
  return {
    ...bestDeal,
    pick,
    confidence,
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
  const proofRecords: DecisionProofRecord[] = [];
  const fetchImpl = input.fetchImpl ?? fetch;
  const servKey = input.servKey?.trim() || "";

  // Multi-finalist (or single) SERV pick — give SERV all eligible cars with facts.
  if (servKey) {
    const allowedKeys = eligible.map((item) => item.row.key);
    const allowedEvidenceIds = eligible.flatMap((item) => [
      `car:${item.row.key}`,
      `ask:${item.row.key}`,
      `fair:${item.row.key}`,
      `comps:${item.row.key}`,
    ]);
    const facts = {
      allowedKeys,
      allowedEvidenceIds,
      evidence: allowedEvidenceIds.map((id) => ({
        id,
        text: id.startsWith("car:")
          ? `Finalist ${id.slice(4)}`
          : id.startsWith("ask:")
            ? `Asking price for ${id.slice(4)}`
            : id.startsWith("fair:")
              ? `Fair value for ${id.slice(5)}`
              : `Similar-ask count for ${id.slice(6)}`,
      })),
      finalists: eligible.map((item) => ({
        key: item.row.key,
        label: `${item.row.year} ${item.row.make} ${item.row.model}`,
        vin: item.row.vin && item.row.vin.length === 17 ? item.row.vin : null,
        askUsd: item.report.subject.priceUsd,
        fairValueUsd: item.report.fairValueUsd,
        compCount: item.report.comps.length,
        priceGap: item.report.priceGap,
        score: item.row.score,
      })),
      codeRankedKey: codeEligible.key,
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
    if (judged.ok && hardRuleOk && payload) {
      pick = eligible.find((item) => item.row.key === pickKey)!.row;
      pickActor = "SERV";
      const conf = payload.confidence;
      if (conf === "high" || conf === "medium" || conf === "low") pickConfidence = conf;
      proofRecords.push(
        buildDecisionProofRecord({
          purpose: "find_pick",
          rubricId: VERDICT_RUBRIC_ID,
          status: "ok",
          recordedAt,
          responseId,
          model: judged.proof?.modelReported ?? judged.proof?.modelRequested ?? input.model ?? null,
          inputs: {
            allowedKeys,
            codeRankedKey: codeEligible.key,
            chosenKey: pick.key,
            eligibleFinalists: eligible.length,
          },
          verdict: typeof payload.action === "string" ? payload.action : null,
          rawResponse,
          detail:
            typeof payload.note === "string" && payload.note.trim()
              ? payload.note.trim()
              : `SERV picked ${pick.year} ${pick.make} ${pick.model} among ${eligible.length} eligible finalists.`,
        }),
      );
    } else {
      const rejectWhy = !judged.ok
        ? judged.failureDiag?.honesty ||
          judged.failureDiag?.reasonCode ||
          judged.error ||
          "SERV find_pick did not finish."
        : !pickKey
          ? "SERV find_pick omitted pickKey — code ranking stands."
          : `SERV pickKey ${pickKey} is not in allowedKeys — hard rule reject; code ranking stands.`;
      pick = codeEligible;
      pickActor = "code";
      proofRecords.push(
        buildDecisionProofRecord({
          purpose: "find_pick",
          rubricId: VERDICT_RUBRIC_ID,
          status: judged.ok ? "failed" : "failed",
          recordedAt,
          responseId: null,
          model: judged.proof?.modelReported ?? judged.proof?.modelRequested ?? input.model ?? null,
          inputs: {
            allowedKeys,
            codeRankedKey: codeEligible.key,
            rejectedPickKey: pickKey || null,
            eligibleFinalists: eligible.length,
          },
          rawResponse,
          detail: `${rejectWhy} Published pick labelled as code fallback.`,
        }),
      );
    }
  } else {
    proofRecords.push(
      buildDecisionProofRecord({
        purpose: "find_pick",
        rubricId: VERDICT_RUBRIC_ID,
        status: "skipped_no_key",
        recordedAt,
        inputs: {
          codeRankedKey: codeEligible.key,
          eligibleFinalists: eligible.length,
        },
        detail:
          "Find pick by code ranking — SERV_API_KEY is not configured on this deployment (not a SERV pick).",
      }),
    );
  }

  const report = buildFindPickComputedReport(pick, peers, marketPool);
  const screeningConfidence: AgentVerdictConfidence | null =
    pickConfidence ??
    (input.bestDeal.confidence !== "none" ? input.bestDeal.confidence : "medium");

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

  // SERV confidence (pick + shopper) becomes published; code fallback stays labelled as code.
  const publishedConfidence = mapDealConfidence(
    shopper.agentVerdict.confidence ?? pickConfidence,
    input.bestDeal.confidence === "none" ? "medium" : input.bestDeal.confidence,
  );
  let agentVerdict = shopper.agentVerdict;
  if (agentVerdict) {
    const pickLabel = `${pick.year} ${pick.make} ${pick.model}`;
    const pickStep = {
      decided:
        pickActor === "SERV"
          ? `SERV picked ${pickLabel} among ${eligible.length} eligible finalists.`
          : `Code picked ${pickLabel} among ${eligible.length} eligible finalists (not SERV).`,
      why:
        pickActor === "SERV"
          ? "Published Find pick comes from SERV find_pick under allowlisted finalist facts."
          : servKey
            ? "SERV pick was unavailable or broke a hard allowlist rule — code ranking stands."
            : "SERV_API_KEY is not configured — code ranking is the published pick.",
      changed: pick.key !== codePick.key ? `Earlier code ranking led with ${codePick.key}.` : null,
      model: shopper.trace?.calls[0]?.model ?? input.model ?? null,
      responseId: shopper.trace?.calls[0]?.responseId ?? null,
      recordedAt,
    };
    agentVerdict = {
      ...agentVerdict,
      pick: { key: pick.key, label: pickLabel },
      confidence: shopper.agentVerdict.confidence ?? pickConfidence ?? agentVerdict.confidence,
      serv_steps: [pickStep, ...(agentVerdict.serv_steps ?? [])],
      no_serv_step: pickActor === "SERV" ? false : agentVerdict.no_serv_step,
    };
  }

  return {
    bestDeal: publishBestDeal(input.bestDeal, pick, publishedConfidence),
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
