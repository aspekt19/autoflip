/**
 * Resale SERV settle: triage/pick/challenge with evidence validation + decision journal.
 * Code owns all dollar figures. SERV only chooses among allowlisted VINs / actions.
 */
import {
  emptyAgentVerdict,
  type AgentSecondPassResult,
  type AgentTrailStep,
  type AgentVerdict,
  type AgentVerdictConfidence,
} from "@/domain/agent-verdict-schema";
import { ASSUMPTIONS } from "@/domain/assumptions";
import {
  appendJournalStep,
  emptyResaleJournal,
  RESALE_SERV_CALL_CAP,
  type ResaleDecisionJournal,
} from "@/domain/resale-decision-journal";
import type { ResaleCandidatePnl } from "@/domain/resale-pnl";
import { evidenceBundleFromCandidates } from "@/domain/resale-serv-validate";
import { actionFromVerdict } from "@/domain/decision-action";
import type { ComputedReport, Listing, Verdict } from "@/domain/types";
import { flipVerdict } from "@/domain/verdict";
import {
  rankByRiskAdjustedProfit,
  riskAdjustedScore,
  runResaleDeepChecks,
} from "@/server/resale-deep-check";
import {
  journalWhyFromServAttempt,
  journalWhyFromShopperCall,
  normalizeCheckId,
  normalizeVin,
  runResaleServWithRejectRetry,
  softFilterEvidenceIds,
  stringArrayField,
  validationFromCall,
} from "@/server/resale-serv-call";
import { runShopperVerdictServ, type ShopperServTrace } from "@/server/shopper-verdict-serv";
import { profile, type ServProof } from "@/server/serv";
import {
  resaleCallTimeoutMs,
  RESALE_STAGE_BUDGET_MS,
  RESALE_TIME_BUDGET_SKIP,
  type ResaleDeadline,
} from "@/domain/resale-deadline";
import { decideWhyWithGateResult } from "@/domain/verdict-decide";
import { providerResponseIdFromCall } from "@/domain/serv-response-id";
import { redactSecretsOnly } from "@/domain/redact-secrets";
import { stripUnsupportedNumbers } from "@/domain/resale-serv-validate";
import {
  buildDecisionProofRecord,
  VERDICT_RUBRIC_ID,
  type DecisionProofRecord,
} from "@/domain/decision-proof-record";

const RESALE_SERV_JUDGE_MAX = 3;

/** Settle phases for client-driven stepped Resale jobs. `all` keeps one-shot behavior. */
export type ResaleSettlePhase =
  | "triage_deep"
  | "pick"
  | "challenge"
  /** @deprecated Prefer separate pick + challenge steps (each needs its own ~50s budget). */
  | "pick_challenge"
  | "shopper"
  | "all";

/**
 * Persisted mid-settle state between job steps.
 * Code owns dollar figures; SERV only chooses among allowlisted VINs / actions.
 */
export type ResaleSettleCheckpoint = {
  phaseCompleted: "triage_deep" | "pick" | "challenge" | "pick_challenge" | "shopper" | "empty";
  journal: ResaleDecisionJournal;
  /** Profit-sorted full candidate list (for alternatives). */
  rankedAll: ResaleCandidatePnl[];
  /** Risk-adjusted ordered shortlist after triage/deep (or code rank). */
  ordered: ResaleCandidatePnl[];
  shortlist: ResaleCandidatePnl[];
  best: ResaleCandidatePnl | null;
  alternatives: ResaleCandidatePnl[];
  verdictAction: "buy" | "negotiate" | "pass" | "needs_inspection";
  confidence: "High" | "Medium" | "Low";
  agentVerdict: AgentVerdict;
  trail: AgentTrailStep[];
  secondPass: AgentSecondPassResult;
  agentConfidence: AgentVerdictConfidence;
  ranJudge: boolean;
  ranDecide: boolean;
  trace: ShopperServTrace | null;
  /** Shared lemonless.decision_proof.v1 rows from shopper decide/challenge (and honest skips). */
  proofRecords: DecisionProofRecord[];
  budgetUsd: number;
  timeToSellPref?: "any" | "faster" | "unknown";
};

export type ResaleSettleServResult = {
  best: ResaleCandidatePnl | null;
  alternatives: ResaleCandidatePnl[];
  agentVerdict: AgentVerdict;
  journal: ResaleDecisionJournal;
  trace: ShopperServTrace | null;
  verdictAction: "buy" | "negotiate" | "pass" | "needs_inspection";
  confidence: "High" | "Medium" | "Low";
  ranJudge: boolean;
  ranDecide: boolean;
  /** Shared lemonless.decision_proof.v1 — same contract as Find/Radar. */
  proofRecords: DecisionProofRecord[];
  /** Snapshot for the next job step (or final state). */
  checkpoint: ResaleSettleCheckpoint;
};

function carLabel(item: ResaleCandidatePnl): string {
  const l = item.listing;
  return `${l.year} ${l.make} ${l.model}${l.trim ? ` ${l.trim}` : ""}`.trim();
}

function confidenceFromPnl(item: ResaleCandidatePnl | null): AgentVerdictConfidence {
  if (!item) return "low";
  if (item.confidence === "High") return "high";
  if (item.confidence === "Medium") return "medium";
  return "low";
}

function responseIdFrom(proof: ServProof | null, ok = true): string | null {
  return providerResponseIdFromCall({
    ok,
    id: typeof proof?.openserv?.id === "string" ? proof.openserv.id : null,
  });
}

function modelFrom(proof: ServProof | null, fallback?: string | null): string | null {
  return fallback || proof?.modelReported || proof?.modelRequested || null;
}

function buildFlipReport(
  candidate: ResaleCandidatePnl,
  budgetUsd: number,
  peerCandidates: ResaleCandidatePnl[] = [],
): ComputedReport {
  const subject: Listing = candidate.listing;
  const fair = candidate.resaleMidUsd;
  const ask = candidate.askingUsd;
  const priceGap = fair != null && fair > 0 ? (ask - fair) / fair : null;
  // Flip framing: risk-adjusted margin is the conservative (low) profit when present.
  // Buy requires mid profit ≥ flipDesiredProfitUsd; below that is negotiate/pass — never
  // treat ask < resale mid as a personal "good deal" fair-value buy.
  const marginUsd =
    candidate.profitLowUsd != null
      ? candidate.profitLowUsd
      : candidate.profitMidUsd != null
        ? candidate.profitMidUsd
        : null;
  const profitTarget = ASSUMPTIONS.flipDesiredProfitUsd;
  const friction = ASSUMPTIONS.flipSellFriction;
  // Never invent sales tax as $0 — omit unknown tax from all-in and say so.
  const salesTaxIncluded =
    candidate.salesTaxKnown === true && typeof candidate.salesTaxUsd === "number";
  const allInUsd =
    candidate.negotiatedOfferUsd +
    candidate.titleFeeAssumptionUsd +
    candidate.reconUsd +
    (salesTaxIncluded ? candidate.salesTaxUsd! : 0);
  const conservativeProceedsUsd =
    candidate.resaleLowUsd != null ? Math.round(candidate.resaleLowUsd * (1 - friction)) : 0;
  const targetBuyUsd =
    fair != null
      ? Math.max(
          0,
          Math.round(
            fair * (1 - friction) -
              candidate.titleFeeAssumptionUsd -
              candidate.reconUsd -
              profitTarget,
          ),
        )
      : 0;
  const flip =
    fair != null && marginUsd != null
      ? {
          resaleLowUsd: candidate.resaleLowUsd ?? fair,
          resaleMidUsd: fair,
          resaleHighUsd: candidate.resaleHighUsd ?? fair,
          titleFeeUsd: candidate.titleFeeAssumptionUsd,
          reconUsd: candidate.reconUsd,
          sellFriction: friction,
          allInUsd,
          conservativeProceedsUsd,
          marginUsd,
          targetBuyUsd,
          timeToSellRisk:
            candidate.compCount < 5 ? ("high" as const) : candidate.compCount < 8 ? ("medium" as const) : ("low" as const),
          timeToSellNote:
            "Days on market are not in the listing feed, so time-to-sell risk is only how many similar listings were found.",
        }
      : null;
  let verdict: Verdict = "insufficient_data";
  if (flip) {
    verdict = flipVerdict(flip.marginUsd, false);
  } else if (candidate.profitMidUsd == null) {
    verdict = "insufficient_data";
  }
  // Ordered gates require minComps priced peers — use other shortlist cars from this scan.
  const comps = peerCandidates
    .filter(
      (item): item is ResaleCandidatePnl & { listing: Listing & { priceUsd: number; miles: number } } =>
        item.vin !== candidate.vin && item.listing.priceUsd != null && item.listing.miles != null,
    )
    .slice(0, 8)
    .map((item) => ({
      vin: item.vin,
      year: item.listing.year,
      trim: item.listing.trim,
      miles: item.listing.miles,
      priceUsd: item.listing.priceUsd,
      adjustedPriceUsd: item.listing.priceUsd,
      city: item.listing.city,
      state: item.listing.state,
      distanceMiles: null as number | null,
    }));
  const midLine =
    candidate.profitMidUsd != null
      ? `Code estimate mid profit $${candidate.profitMidUsd.toLocaleString("en-US")}${
          candidate.profitScopeLabel ? ` ${candidate.profitScopeLabel}` : ""
        } from ${candidate.compCount} similar listings.`
      : "Profit band incomplete — similar listings were thin.";
  const thresholdLine = `Buy only when risk-adjusted (conservative) profit clears the labeled margin threshold of $${profitTarget.toLocaleString("en-US")} (flipDesiredProfitUsd); thin margin is $${ASSUMPTIONS.flipThinMarginUsd.toLocaleString("en-US")} (flipThinMarginUsd). Resale mid $${fair != null ? fair.toLocaleString("en-US") : "—"} is an exit estimate, not a buy-side fair value. Ask $${ask.toLocaleString("en-US")}.`;
  const noFlipLine =
    flip && flip.marginUsd < ASSUMPTIONS.flipThinMarginUsd
      ? "No good flip within this budget on risk-adjusted margin — pass or keep shopping."
      : null;
  const taxNote = salesTaxIncluded
    ? `All-in includes sales tax $${candidate.salesTaxUsd!.toLocaleString("en-US")}.`
    : "All-in omits sales tax (state unknown) — tax is not treated as $0.";
  return {
    mode: "flip",
    subject,
    verdict,
    score: candidate.score,
    reasons: [midLine, thresholdLine, noFlipLine, taxNote, candidate.negotiateBasis, candidate.resaleChannelBasis].filter(
      (line): line is string => Boolean(line),
    ),
    flags: [],
    questions: candidate.checkBeforeBuying.slice(0, 6),
    comps,
    compScope: "Resale search similar asks in this scan",
    percentile: null,
    // Kept for schema compatibility; flip facts label this as resale mid, not buy fair value.
    fairValueUsd: fair,
    fairRangeLowUsd: candidate.resaleLowUsd,
    fairRangeHighUsd: candidate.resaleHighUsd,
    fairConfidence: candidate.compCount >= 5 ? "reasonable" : candidate.compCount >= 3 ? "rough" : "not_available",
    compMethodNote:
      "Adjusted similar listing asks (mileage/year/trim) via evaluateListingPrice — resale mid estimate, not a buy-side fair value or closed sales.",
    priceGap,
    mileage: {
      expectedMiles: null,
      subjectMiles: subject.miles,
      medianCompMiles: null,
      perMileUsd: null,
    },
    history: { multiplier: 1, lines: [] },
    recalls: [],
    recallsAvailable: false,
    openParkIt: false,
    openParkOutside: false,
    complaintCount: null,
    fuel: null,
    vinDecode: null,
    distanceToSearchZipMiles: null,
    flip,
    assumptions: { ...ASSUMPTIONS },
    dataNotes: [
      taxNote,
      salesTaxIncluded
        ? null
        : "salesTaxUsd=null; salesTaxKnown=false; allInIncludesSalesTax=false",
      ...candidate.risks.slice(0, 8),
    ].filter((line): line is string => Boolean(line)),
    sample: false,
    mandate: {
      budgetUsd,
      budgetKnown: true,
      targetProfitUsd: profitTarget,
      repairAbility: "unknown",
    },
  };
}

function sortByProfit(items: ResaleCandidatePnl[]): ResaleCandidatePnl[] {
  return [...items].sort((a, b) => {
    const aMid = a.rankingProfitMidUsd ?? a.profitMidUsd ?? Number.NEGATIVE_INFINITY;
    const bMid = b.rankingProfitMidUsd ?? b.profitMidUsd ?? Number.NEGATIVE_INFINITY;
    return bMid - aMid;
  });
}

/**
 * Alternatives must respect the flip budget.
 * Ask ≤ budget: keep. Ask over budget but negotiated offer ≤ budget: keep with an explicit over-budget label.
 * Both ask and offer over budget: drop.
 */
/** Label alternatives whose mid profit is negative — consistent with flip margin gates. */
export function withNotProfitableAtAskLabel(item: ResaleCandidatePnl): ResaleCandidatePnl {
  const mid = item.rankingProfitMidUsd ?? item.profitMidUsd;
  if (mid == null || !Number.isFinite(mid) || mid >= 0) return item;
  const label = "Not profitable at ask";
  return {
    ...item,
    risks: item.risks.includes(label) ? item.risks : [label, ...item.risks],
  };
}

function pickAlternatives(
  ranked: ResaleCandidatePnl[],
  bestVin: string,
  budgetUsd: number,
  limit = 4,
): ResaleCandidatePnl[] {
  const out: ResaleCandidatePnl[] = [];
  for (const item of sortByProfit(ranked.filter((row) => row.vin !== bestVin))) {
    if (out.length >= limit) break;
    const ask = item.askingUsd;
    const offer = item.negotiatedOfferUsd;
    if (ask <= budgetUsd) {
      out.push(withNotProfitableAtAskLabel(item));
      continue;
    }
    if (offer <= budgetUsd) {
      const label = `Over budget: ask $${ask.toLocaleString("en-US")} against budget $${budgetUsd.toLocaleString("en-US")}; negotiated offer estimate $${offer.toLocaleString("en-US")} is under the budget.`;
      out.push(
        withNotProfitableAtAskLabel({
          ...item,
          risks: item.risks.includes(label) ? item.risks : [label, ...item.risks],
        }),
      );
      continue;
    }
  }
  return out;
}

export type FlipPublishedAction = ResaleSettleServResult["verdictAction"];

/** Optimism rank — higher may not be published when the margin gate is lower. */
function flipActionOptimism(action: FlipPublishedAction): number {
  switch (action) {
    case "buy":
      return 3;
    case "negotiate":
      return 2;
    case "needs_inspection":
      return 1;
    case "pass":
      return 0;
  }
}

/**
 * Code-owned published flip action from risk-adjusted margin.
 * Uses low profit when present (conservative), else mid. Maps via flipVerdict thresholds.
 */
export function flipMarginPublishedAction(candidate: ResaleCandidatePnl): {
  action: FlipPublishedAction;
  marginUsd: number | null;
  reason: string;
} {
  const marginUsd =
    candidate.profitLowUsd != null
      ? candidate.profitLowUsd
      : candidate.profitMidUsd != null
        ? candidate.profitMidUsd
        : null;
  const mid = candidate.profitMidUsd;
  const roi = candidate.roiPctMid;
  if (marginUsd == null) {
    return {
      action: "needs_inspection",
      marginUsd: null,
      reason: "Risk-adjusted margin unavailable — profit band incomplete.",
    };
  }
  const action = actionFromVerdict(flipVerdict(marginUsd, false)) as FlipPublishedAction;
  const bits = [
    `Risk-adjusted margin $${marginUsd.toLocaleString("en-US")} (low profit when present, else mid)`,
    mid != null ? `mid $${mid.toLocaleString("en-US")}` : null,
    roi != null ? `ROI mid ${roi}%` : null,
    `buy needs ≥ $${ASSUMPTIONS.flipDesiredProfitUsd.toLocaleString("en-US")} (flipDesiredProfitUsd)`,
    `negotiate/thin needs ≥ $${ASSUMPTIONS.flipThinMarginUsd.toLocaleString("en-US")} (flipThinMarginUsd)`,
    `→ ${action}`,
  ].filter(Boolean);
  return { action, marginUsd, reason: bits.join("; ") + "." };
}

/**
 * Cap a proposed action (code or SERV) so it cannot be more optimistic than the margin gate.
 * SERV may still choose a more conservative action.
 */
export function clampFlipPublishedAction(
  proposed: FlipPublishedAction,
  candidate: ResaleCandidatePnl,
): { action: FlipPublishedAction; overridden: boolean; reason: string | null } {
  const gated = flipMarginPublishedAction(candidate);
  if (flipActionOptimism(proposed) <= flipActionOptimism(gated.action)) {
    return { action: proposed, overridden: false, reason: null };
  }
  return {
    action: gated.action,
    overridden: true,
    reason: `SERV said ${proposed}; guardrail capped to ${gated.action}. ${gated.reason}`,
  };
}

function applyFlipPublishedAction(input: {
  proposed: FlipPublishedAction;
  candidate: ResaleCandidatePnl;
  source: "code" | "SERV";
  journal: ResaleDecisionJournal;
  trail: AgentTrailStep[];
  recordedAt: string;
  model?: string | null;
  responseId?: string | null;
}): {
  action: FlipPublishedAction;
  journal: ResaleDecisionJournal;
  trail: AgentTrailStep[];
} {
  // Code path: publish the gate directly (no "SERV said" framing).
  if (input.source === "code") {
    const gated = flipMarginPublishedAction(input.candidate);
    return { action: gated.action, journal: input.journal, trail: input.trail };
  }
  const clamped = clampFlipPublishedAction(input.proposed, input.candidate);
  if (!clamped.overridden || !clamped.reason) {
    return { action: clamped.action, journal: input.journal, trail: input.trail };
  }
  let journal = appendJournalStep(input.journal, {
    kind: "fallback",
    actor: "code",
    decided: `Guardrail capped SERV ${input.proposed} → ${clamped.action}`,
    why: clamped.reason,
    inputsUsed: [`vin:${input.candidate.vin}`, "check:flip_margin_gate"],
    changed: `Published action ${input.proposed} → ${clamped.action}`,
    model: input.model ?? null,
    responseId: input.responseId ?? null,
    recordedAt: input.recordedAt,
    rejected: null,
  });
  const trail = [
    ...input.trail,
    {
      decided: `Guardrail capped SERV ${input.proposed} → ${clamped.action}`,
      why: clamped.reason,
      changed: `Published action ${input.proposed} → ${clamped.action}`,
      model: input.model ?? null,
      responseId: input.responseId ?? null,
      recordedAt: input.recordedAt,
    },
  ];
  return { action: clamped.action, journal, trail };
}

function profitHeadline(c: ResaleCandidatePnl): string {
  if (c.profitMidUsd == null) return "Profit mid unavailable — similar listings were thin.";
  const scope = c.profitScopeLabel ? ` ${c.profitScopeLabel}` : "";
  return `Expected mid net profit about $${c.profitMidUsd.toLocaleString("en-US")}${scope} (estimate from similar listings minus labeled costs).`;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function buildSettleResult(state: {
  best: ResaleCandidatePnl | null;
  alternatives: ResaleCandidatePnl[];
  agentVerdict: AgentVerdict;
  journal: ResaleDecisionJournal;
  trace: ShopperServTrace | null;
  verdictAction: ResaleSettleServResult["verdictAction"];
  confidence: ResaleSettleServResult["confidence"];
  ranJudge: boolean;
  ranDecide: boolean;
  proofRecords: DecisionProofRecord[];
  checkpoint: ResaleSettleCheckpoint;
}): ResaleSettleServResult {
  return {
    best: state.best,
    alternatives: state.alternatives,
    agentVerdict: state.agentVerdict,
    journal: state.journal,
    trace: state.trace,
    proofRecords: state.proofRecords,
    verdictAction: state.verdictAction,
    confidence: state.confidence,
    ranJudge: state.ranJudge,
    ranDecide: state.ranDecide,
    checkpoint: state.checkpoint,
  };
}

function finalizeAgentVerdict(input: {
  best: ResaleCandidatePnl;
  verdictAction: ResaleSettleServResult["verdictAction"];
  agentConfidence: AgentVerdictConfidence;
  trail: AgentTrailStep[];
  secondPass: AgentSecondPassResult;
  journal: ResaleDecisionJournal;
  ranJudge: boolean;
  ranDecide: boolean;
}): AgentVerdict {
  return {
    ...emptyAgentVerdict({
      pick: { key: input.best.vin, label: carLabel(input.best) },
      verdict: input.verdictAction,
      confidence: input.agentConfidence,
      reasons: [
        {
          evidenceId: "pnl_mid",
          text: profitHeadline(input.best),
        },
        { evidenceId: "comps", text: `${input.best.compCount} similar listings in this scan.` },
      ],
      risks: input.best.risks.slice(0, 4).map((text, i) => ({ evidenceId: `risk_${i}`, text })),
      unknowns: [
        ...(input.best.salesTaxKnown
          ? []
          : ["Sales tax unknown — profit shown before sales tax (state unknown); ranking applies a conservative tax haircut."]),
        "Title/registration dollar amount unknown.",
        ...(input.best.estimatedDaysToSell == null ? ["Days to sell unknown without listing age / DOM feed."] : []),
      ],
      serv_steps: input.trail,
      second_pass: input.secondPass,
      no_serv_step: !input.ranJudge && !input.ranDecide,
      serv_spend: {
        calls: input.journal.servCalls,
        costNote: `Resale SERV call cap ${input.journal.servCallCap}; recorded ${input.journal.servCalls}.`,
      },
    }),
  };
}

/**
 * Pick best flip + alternatives. Always returns a verdict (never a dead end).
 * Optional `phase` + `checkpoint` split the SERV chain across stepped job requests.
 */
export async function runResaleSettleServ(input: {
  candidates: ResaleCandidatePnl[];
  budgetUsd: number;
  timeToSellPref?: "any" | "faster" | "unknown";
  servKey?: string;
  servBaseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  /** When set, skip remaining SERV stages once the wall-clock budget is gone. */
  deadline?: ResaleDeadline;
  /**
   * Settle slice for stepped jobs.
   * `all` (default) runs the full chain in one call.
   */
  phase?: ResaleSettlePhase;
  /** Prior phase snapshot — required for pick_challenge / shopper phases. */
  checkpoint?: ResaleSettleCheckpoint | null;
  /**
   * SERV HTTP calls already counted on the plan journal (or other prior phase).
   * Global Resale cap is priorServCalls + settle journal.servCalls.
   */
  priorServCalls?: number;
}): Promise<ResaleSettleServResult> {
  const recordedAt = new Date().toISOString();
  const phase: ResaleSettlePhase = input.phase ?? "all";
  const stepped = phase !== "all";
  const fetchImpl = input.fetchImpl ?? fetch;
  const deadline = input.deadline;
  const priorServCalls = Math.max(0, Math.floor(input.priorServCalls ?? 0));

  /** Stepped jobs: only skip SERV when the per-step deadline is truly expired. */
  const stageOk = (needMs: number, timeoutMs: number | null): boolean => {
    if (timeoutMs == null) return false;
    if (!deadline) return true;
    if (stepped) return !deadline.expired();
    return deadline.allow(needMs);
  };
  /** True when another settle SERV HTTP call fits under the global Resale cap. */
  const hasServSlot = (journal: ResaleDecisionJournal): boolean =>
    priorServCalls + journal.servCalls < journal.servCallCap;
  const totalServCalls = (journal: ResaleDecisionJournal): number =>
    priorServCalls + journal.servCalls;
  const remainingServSlots = (journal: ResaleDecisionJournal): number =>
    Math.max(0, journal.servCallCap - totalServCalls(journal));
  const callCapSkipLine = (journal: ResaleDecisionJournal): string =>
    `call cap reached (${totalServCalls(journal)}/${journal.servCallCap})`;
  const callCapSkipWhy = (journal: ResaleDecisionJournal): string =>
    `plan ${priorServCalls} + settle ${journal.servCalls} = ${journal.servCallCap}`;

  const resumeFrom =
    input.checkpoint &&
    (phase === "pick" ||
      phase === "challenge" ||
      phase === "pick_challenge" ||
      phase === "shopper") &&
    input.checkpoint.phaseCompleted !== "empty"
      ? input.checkpoint
      : null;

  let trail: AgentTrailStep[] = resumeFrom ? [...resumeFrom.trail] : [];
  let proofRecords: DecisionProofRecord[] = resumeFrom?.proofRecords ? [...resumeFrom.proofRecords] : [];
  let journal = resumeFrom ? resumeFrom.journal : emptyResaleJournal(RESALE_SERV_CALL_CAP);
  const ranked = resumeFrom ? resumeFrom.rankedAll : sortByProfit(input.candidates);
  const shortlist = resumeFrom ? resumeFrom.shortlist : ranked.slice(0, RESALE_SERV_JUDGE_MAX);

  if (shortlist.length === 0) {
    journal = appendJournalStep(journal, {
      kind: "stop_or_widen",
      actor: "code",
      decided: "Stop — no flip candidates cleared economics",
      why: "No listings in this scan cleared similar-listing P&L. Raise budget or clear filters; this is still a verdict, not a dead end.",
      inputsUsed: [`budgetUsd:${input.budgetUsd}`],
      changed: null,
      model: null,
      responseId: null,
      recordedAt,
      rejected: null,
    });
    const agentVerdict = emptyAgentVerdict({
      verdict: "pass",
      confidence: "low",
      unknowns: [
        "No flip candidates cleared similar-listing economics in this search. Budget or filters may be too tight — try a higher budget or nationwide radius.",
      ],
      no_serv_step: true,
      second_pass: {
        status: "not_run",
        action: null,
        objection: "Second check not run: no candidate to challenge.",
        evidenceIds: [],
        confidenceBefore: null,
        confidenceAfter: null,
      },
      serv_steps: [
        {
          decided: "No candidates — pass",
          why: "Code found no usable flip P&L rows.",
          changed: null,
          recordedAt,
        },
      ],
    });
    const checkpoint: ResaleSettleCheckpoint = {
      phaseCompleted: "empty",
      journal,
      rankedAll: [],
      ordered: [],
      shortlist: [],
      best: null,
      alternatives: [],
      verdictAction: "pass",
      confidence: "Low",
      agentVerdict,
      trail: [],
      secondPass: {
        status: "not_run",
        action: null,
        objection: "Second check not run: no candidate to challenge.",
        evidenceIds: [],
        confidenceBefore: null,
        confidenceAfter: null,
      },
      agentConfidence: "low",
      ranJudge: false,
      ranDecide: false,
      trace: null,
      proofRecords: [],
      budgetUsd: input.budgetUsd,
      timeToSellPref: input.timeToSellPref,
    };
    return buildSettleResult({
      best: null,
      alternatives: [],
      agentVerdict,
      journal,
      trace: null,
      proofRecords: [],
      verdictAction: "pass",
      confidence: "Low",
      ranJudge: false,
      ranDecide: false,
      checkpoint,
    });
  }

  const bundle = evidenceBundleFromCandidates(shortlist, [
    "check:price_comps",
    "check:vin_decode",
    "check:recalls",
    "check:complaints",
  ]);
  let working = resumeFrom ? resumeFrom.ordered : shortlist;
  let ranJudge = resumeFrom?.ranJudge ?? false;
  let ordered = resumeFrom ? resumeFrom.ordered : shortlist;
  let best = resumeFrom?.best ?? shortlist[0]!;
  let verdictAction: ResaleSettleServResult["verdictAction"] =
    resumeFrom?.verdictAction ?? flipMarginPublishedAction(best).action;
  let secondPass: AgentSecondPassResult = resumeFrom?.secondPass ?? {
    status: input.servKey?.trim() ? "not_run" : "skipped_no_key",
    action: null,
    objection: input.servKey?.trim()
      ? "Second check not run yet."
      : "Second check not run: SERV_API_KEY is not configured on this deployment.",
    evidenceIds: [],
    confidenceBefore: confidenceFromPnl(best),
    confidenceAfter: null,
  };
  let agentConfidence = resumeFrom?.agentConfidence ?? confidenceFromPnl(best);
  let ranDecide = resumeFrom?.ranDecide ?? false;
  let trace: ShopperServTrace | null = resumeFrom?.trace ?? null;

  const runTriageDeep = phase === "all" || phase === "triage_deep";
  const runPick =
    phase === "all" || phase === "pick" || phase === "pick_challenge";
  const runChallenge =
    phase === "all" || phase === "challenge" || phase === "pick_challenge";
  const runShopperPhase = phase === "all" || phase === "shopper";

  // --- Triage + deep (skipped when resuming pick/shopper) ---
  let selectedCheckIds = ["price_comps", "history"];
  if (runTriageDeep && !resumeFrom) {
  journal = appendJournalStep(journal, {
    kind: "rank",
    actor: "code",
    decided: `Ranked ${shortlist.length} candidates by mid expected profit`,
    why: `Top: ${carLabel(shortlist[0]!)} (code P&L only).`,
    inputsUsed: shortlist.map((item) => `pnl:${item.vin}`),
    changed: null,
    model: null,
    responseId: null,
    recordedAt,
    rejected: null,
  });

  // --- Triage (resale_triage) ---
  const triageTimeoutMs = deadline
    ? resaleCallTimeoutMs(profile("resale_triage").timeoutMs, deadline)
    : profile("resale_triage").timeoutMs;
  if (
    input.servKey?.trim() &&
    hasServSlot(journal) &&
    triageTimeoutMs != null &&
    stageOk(RESALE_STAGE_BUDGET_MS.triage, triageTimeoutMs)
  ) {
    const allowedCheckIds = ["price_comps", "vin_decode", "recalls", "complaints", "history"];
    const allowedVins = shortlist.map((item) => item.vin.toUpperCase());
    const triageEvidenceIds = [
      ...bundle.evidenceIds,
      ...allowedCheckIds.map((id) => `check:${id}`),
      "check:history",
    ];
    const facts = {
      allowedVins,
      allowedCheckIds,
      allowedEvidenceIds: triageEvidenceIds,
      evidence: triageEvidenceIds.map((id) => ({
        id,
        text: id.startsWith("check:")
          ? `Allowlisted check ${id.slice("check:".length)}`
          : id.startsWith("pnl:")
            ? `Code P&L for ${id.slice("pnl:".length)}`
            : `Allowlisted VIN ${id.replace(/^vin:/, "")}`,
      })),
      candidates: shortlist.map((item) => ({
        vin: item.vin.toUpperCase(),
        profitMidUsd: item.profitMidUsd,
        compCount: item.compCount,
        confidence: item.confidence,
        askingUsd: item.askingUsd,
      })),
    };
    const triageBundle = {
      ...bundle,
      vins: allowedVins,
      evidenceIds: triageEvidenceIds,
      numberFacts: facts,
    };
    try {
      const allowVin = new Set(allowedVins);
      const allowCheck = new Set(allowedCheckIds);
      const attempt = await runResaleServWithRejectRetry({
        profileId: "resale_triage",
        facts,
        deps: {
          fetch: fetchImpl,
          apiKey: input.servKey,
          baseUrl: input.servBaseUrl,
          model: input.model,
          timeoutMs: triageTimeoutMs,
        },
        deadline,
        canRetry: remainingServSlots(journal) > 1,
        validatePayload: (payload, result) => {
          const deep = stringArrayField(payload, "deepCheckVins").map(normalizeVin);
          const skip = stringArrayField(payload, "skipVins").map(normalizeVin);
          const checks = stringArrayField(payload, "checkIds").map(normalizeCheckId);
          const note = typeof payload?.note === "string" ? payload.note : "";
          const evidenceIds = softFilterEvidenceIds(
            [...checks.map((id) => `check:${id}`), ...(note.match(/(?:vin|pnl|check):[A-Za-z0-9_-]+/g) ?? [])],
            triageEvidenceIds,
          );
          const base = validationFromCall({
            result,
            payload,
            text: note,
            vins: [...deep, ...skip],
            evidenceIds,
            bundle: triageBundle,
          });
          if (!base.ok) return base;
          const deepOk = deep.filter((vin) => allowVin.has(vin));
          const safeChecks = checks.filter((id) => allowCheck.has(id));
          if (deepOk.length === 0 && safeChecks.length === 0) {
            return {
              ok: false,
              reason: "rejected: unsupported reference",
              detail:
                "Triage payload unusable — deepCheckVins/checkIds must copy exact allowlisted values from facts.",
            };
          }
          return { ok: true };
        },
      });
      const judged = attempt.result;
      ranJudge = true;
      const payload = attempt.payload;
      const validation = attempt.validation;
      const deep = stringArrayField(payload, "deepCheckVins").map(normalizeVin);
      const skip = stringArrayField(payload, "skipVins").map(normalizeVin);
      const checks = stringArrayField(payload, "checkIds").map(normalizeCheckId);
      const note = typeof payload?.note === "string" ? payload.note : "";
      if (attempt.attempt === 2) {
        journal = appendJournalStep(journal, {
          kind: "fallback",
          actor: "SERV",
          decided: "Triage first response rejected — retried once with validation error",
          why: "Reject-retry within step budget.",
          inputsUsed: shortlist.map((item) => `vin:${item.vin}`),
          changed: null,
          model: modelFrom(judged.proof, input.model),
          responseId: null,
          recordedAt,
          rejected: "rejected: unsupported reference",
        });
      }
      if (!judged.ok || !payload || !validation.ok) {
        const fail = journalWhyFromServAttempt({
          result: judged,
          validation,
          payload,
          missingPayloadFallback: "Triage call failed or payload unusable.",
        });
        const servNote = note.trim()
          ? ` SERV note: ${redactSecretsOnly(stripUnsupportedNumbers(note, triageBundle))}`
          : "";
        journal = appendJournalStep(journal, {
          kind: "fallback",
          actor: "SERV",
          decided: "Triage rejected or unavailable — code shortlist stands",
          why: `${fail.why}${servNote}`,
          inputsUsed: shortlist.map((item) => `vin:${item.vin}`),
          changed: null,
          model: modelFrom(judged.proof, input.model),
          responseId: responseIdFrom(judged.proof, false),
          recordedAt,
          rejected: fail.rejected,
        });
      } else {
        const deepOk = deep.filter((vin) => allowVin.has(vin));
        const skipOk = skip.filter((vin) => allowVin.has(vin));
        if (deepOk.length > 0) {
          working = shortlist.filter((item) => deepOk.includes(item.vin.toUpperCase()));
        }
        const safeChecks = checks.filter((id) => allowCheck.has(id));
        if (safeChecks.length > 0) selectedCheckIds = safeChecks;
        const triageWhy = note.trim()
          ? redactSecretsOnly(note)
          : "Triage used allowlisted VINs and check ids only.";
        journal = appendJournalStep(journal, {
          kind: "triage",
          actor: "SERV",
          decided: `Deep-check ${deepOk.length || shortlist.length} VIN(s); skip ${skipOk.length}; checks ${safeChecks.join(", ") || "none"}`,
          why: triageWhy,
          inputsUsed: [...deepOk.map((vin) => `vin:${vin}`), ...safeChecks.map((id) => `check:${id}`)],
          changed: deepOk.length
            ? `Shortlist narrowed to ${working.map(carLabel).join(", ")}`
            : skipOk.length
              ? `Skipped ${skipOk.join(", ")}`
              : null,
          model: modelFrom(judged.proof, input.model),
          responseId: responseIdFrom(judged.proof),
          recordedAt,
          rejected: null,
        });
        trail.push({
          decided: "Agent triage",
          why: triageWhy,
          changed: deepOk.length ? `Deep-check ${deepOk.join(", ")}` : null,
          model: modelFrom(judged.proof, input.model),
          responseId: responseIdFrom(judged.proof),
          recordedAt,
        });
      }
    } catch (err) {
      journal = appendJournalStep(journal, {
        kind: "fallback",
        actor: "code",
        decided: "Triage threw — code shortlist stands",
        why: err instanceof Error ? err.message : "Triage error.",
        inputsUsed: shortlist.map((item) => `vin:${item.vin}`),
        changed: null,
        model: null,
        responseId: null,
        recordedAt,
        rejected: null,
      });
    }
  } else if (!input.servKey?.trim()) {
    journal = appendJournalStep(journal, {
      kind: "fallback",
      actor: "code",
      decided: "No agent key — code ranking only",
      why: `Top candidate is ${carLabel(shortlist[0]!)} from code P&L.`,
      inputsUsed: shortlist.map((item) => `pnl:${item.vin}`),
      changed: null,
      model: null,
      responseId: null,
      recordedAt,
      rejected: null,
    });
  } else if (
    input.servKey?.trim() &&
    deadline &&
    !stageOk(RESALE_STAGE_BUDGET_MS.triage, triageTimeoutMs)
  ) {
    journal = appendJournalStep(journal, {
      kind: "fallback",
      actor: "code",
      decided: `Triage ${RESALE_TIME_BUDGET_SKIP}`,
      why: `Wall-clock budget remaining ${deadline.remainingMs()}ms — keeping code ranking for ${carLabel(shortlist[0]!)}.`,
      inputsUsed: shortlist.map((item) => `pnl:${item.vin}`),
      changed: null,
      model: null,
      responseId: null,
      recordedAt,
      rejected: null,
    });
  }

  // --- Deep-check (code executes the free public lookups SERV selected) ---
  const deepTargets = (working.length ? working : shortlist).slice(0, RESALE_SERV_JUDGE_MAX);
  const deep = await runResaleDeepChecks({
    candidates: deepTargets,
    checkIds: selectedCheckIds,
    journal,
    fetchImpl,
    nowIso: recordedAt,
    deadline,
    stageCapMs: stepped
      ? Math.max(RESALE_STAGE_BUDGET_MS.deepCheck, deadline?.remainingMs() ?? RESALE_STAGE_BUDGET_MS.deepCheck)
      : RESALE_STAGE_BUDGET_MS.deepCheck,
  });
  journal = deep.journal;
  working = deepTargets.filter((item) => !deep.rejectedVins.has(item.vin));
  if (working.length === 0) {
    working = deepTargets; // keep rejected visible for pass verdict rather than empty dead end
    journal = appendJournalStep(journal, {
      kind: "stop_or_widen",
      actor: "code",
      decided: "All deep-checked candidates were rejected — still return a pass verdict",
      why: "Park-it or hard rejects cleared the shortlist. Widen budget/radius on the next search.",
      inputsUsed: deepTargets.map((item) => `vin:${item.vin}`),
      changed: null,
      model: null,
      responseId: null,
      recordedAt,
      rejected: null,
    });
  }

  if (input.timeToSellPref === "faster") {
    const faster = working.filter((item) => item.speed === "faster" || item.speed === "typical");
    if (faster.length > 0) working = faster;
  }

  // Risk-adjusted rank after deep-checks (code math only; formula stamped on each row).
  ordered = rankByRiskAdjustedProfit(working.length ? working : shortlist, deep.riskByVin);
  const topRank = ordered[0]!;
  const topFormula =
    topRank.riskAdjustedRankFormula ??
    riskAdjustedScore(topRank, deep.riskByVin.get(topRank.vin) ?? 1).formula;
  journal = appendJournalStep(journal, {
    kind: "rank",
    actor: "code",
    decided: `Re-ranked by risk-adjusted expected mid profit`,
    why: `Top after deep-checks: ${carLabel(topRank)}. Formula: ${topFormula}. Risk multipliers come from comps/recalls/history deep-checks.`,
    inputsUsed: ordered.map((item) => `pnl:${item.vin}`),
    changed: ordered[0] && shortlist[0] && ordered[0].vin !== shortlist[0].vin
      ? `Changed lead from ${shortlist[0].vin} to ${ordered[0].vin} after deep-checks`
      : null,
    model: null,
    responseId: null,
    recordedAt,
    rejected: null,
  });
  best = ordered[0]!;
  verdictAction = flipMarginPublishedAction(best).action;
  agentConfidence = confidenceFromPnl(best);
  secondPass = {
    status: input.servKey?.trim() ? "not_run" : "skipped_no_key",
    action: null,
    objection: input.servKey?.trim()
      ? "Second check not run yet."
      : "Second check not run: SERV_API_KEY is not configured on this deployment.",
    evidenceIds: [],
    confidenceBefore: agentConfidence,
    confidenceAfter: null,
  };
  } // end runTriageDeep && !resumeFrom

  if (phase === "triage_deep") {
    const alternatives = pickAlternatives(ranked, best.vin, input.budgetUsd);
    const confidenceLabel =
      agentConfidence === "high" ? "High" : agentConfidence === "medium" ? "Medium" : "Low";
    const agentVerdict = finalizeAgentVerdict({
      best,
      verdictAction,
      agentConfidence,
      trail,
      secondPass,
      journal,
      ranJudge,
      ranDecide,
    });
    const checkpoint: ResaleSettleCheckpoint = {
      phaseCompleted: "triage_deep",
      journal,
      rankedAll: ranked,
      ordered,
      shortlist,
      best,
      alternatives,
      verdictAction,
      confidence: confidenceLabel,
      agentVerdict,
      trail,
      secondPass,
      agentConfidence,
      ranJudge,
      ranDecide,
      trace: null,
      proofRecords,
      budgetUsd: input.budgetUsd,
      timeToSellPref: input.timeToSellPref,
    };
    return buildSettleResult({
      best,
      alternatives,
      agentVerdict,
      journal,
      trace: null,
      proofRecords,
      verdictAction,
      confidence: confidenceLabel,
      ranJudge,
      ranDecide,
      checkpoint,
    });
  }

  // --- Pick (resale_pick) ---
  const pickTimeoutMs = deadline
    ? resaleCallTimeoutMs(profile("resale_pick").timeoutMs, deadline)
    : profile("resale_pick").timeoutMs;
  if (
    runPick &&
    input.servKey?.trim() &&
    hasServSlot(journal) &&
    pickTimeoutMs != null &&
    stageOk(RESALE_STAGE_BUDGET_MS.pick, pickTimeoutMs)
  ) {
    const allowedVins = ordered.map((item) => item.vin.toUpperCase());
    const pickEvidenceIds = [
      ...bundle.evidenceIds,
      ...ordered.flatMap((item) => [`vin:${item.vin.toUpperCase()}`, `pnl:${item.vin.toUpperCase()}`]),
    ];
    const uniquePickEvidence = [...new Set(pickEvidenceIds)];
    const pickFacts = {
      allowedVins,
      allowedEvidenceIds: uniquePickEvidence,
      evidence: uniquePickEvidence.map((id) => ({
        id,
        text: id.startsWith("pnl:")
          ? `Code P&L mid profit for ${id.slice("pnl:".length)}`
          : `Allowlisted VIN ${id.replace(/^vin:/, "")}`,
      })),
      candidates: ordered.map((item) => ({
        vin: item.vin.toUpperCase(),
        profitMidUsd: item.profitMidUsd,
        roiPctMid: item.roiPctMid,
        compCount: item.compCount,
        confidence: item.confidence,
        askingUsd: item.askingUsd,
        fairValueUsd: item.resaleMidUsd,
      })),
    };
    const pickBundle = {
      ...bundle,
      vins: allowedVins,
      evidenceIds: uniquePickEvidence,
      numberFacts: pickFacts,
    };
    try {
      const allow = new Set(allowedVins);
      const attempt = await runResaleServWithRejectRetry({
        profileId: "resale_pick",
        facts: pickFacts,
        deps: {
          fetch: fetchImpl,
          apiKey: input.servKey,
          baseUrl: input.servBaseUrl,
          model: input.model,
          timeoutMs: pickTimeoutMs,
        },
        deadline,
        canRetry: remainingServSlots(journal) > 1,
        validatePayload: (payload, result) => {
          const pickVinRaw = typeof payload?.pickVin === "string" ? normalizeVin(payload.pickVin) : null;
          const note = typeof payload?.note === "string" ? payload.note : "";
          const evidenceIds = softFilterEvidenceIds(stringArrayField(payload, "evidenceIds"), uniquePickEvidence);
          const base = validationFromCall({
            result,
            payload,
            text: note,
            vins: pickVinRaw ? [pickVinRaw] : [],
            evidenceIds,
            bundle: pickBundle,
          });
          if (!base.ok) return base;
          if (!pickVinRaw || !allow.has(pickVinRaw)) {
            return {
              ok: false,
              reason: "rejected: unsupported reference",
              detail: "Pick payload missing allowlisted VIN. Copy pickVin exactly from facts.allowedVins.",
            };
          }
          return { ok: true };
        },
      });
      const picked = attempt.result;
      const payload = attempt.payload;
      const validation = attempt.validation;
      const pickVin = typeof payload?.pickVin === "string" ? normalizeVin(payload.pickVin) : null;
      const action = typeof payload?.action === "string" ? payload.action : null;
      const note = typeof payload?.note === "string" ? payload.note : "";
      const evidenceIds = softFilterEvidenceIds(stringArrayField(payload, "evidenceIds"), uniquePickEvidence);
      if (attempt.attempt === 2) {
        journal = appendJournalStep(journal, {
          kind: "fallback",
          actor: "SERV",
          decided: "Pick first response rejected — retried once with validation error",
          why: "Reject-retry within step budget.",
          inputsUsed: ordered.map((item) => `vin:${item.vin}`),
          changed: null,
          model: modelFrom(picked.proof, input.model),
          responseId: null,
          recordedAt,
          rejected: "rejected: unsupported reference",
        });
      }
      if (picked.ok && payload && validation.ok && pickVin && allow.has(pickVin)) {
        const prior = best.vin;
        best = ordered.find((item) => item.vin.toUpperCase() === pickVin) ?? best;
        const proposed: FlipPublishedAction =
          action === "buy" || action === "negotiate" || action === "pass" || action === "needs_inspection"
            ? action
            : verdictAction;
        journal = appendJournalStep(journal, {
          kind: "pick",
          actor: "SERV",
          decided: `Pick ${carLabel(best)} → ${proposed}`,
          why: note || "Pick used allowlisted VIN and code P&L facts.",
          inputsUsed: [`vin:${best.vin}`, ...evidenceIds],
          changed: prior !== best.vin ? `Changed pick from ${prior} to ${best.vin}` : null,
          model: modelFrom(picked.proof, input.model),
          responseId: responseIdFrom(picked.proof),
          recordedAt,
          rejected: null,
        });
        trail.push({
          decided: `SERV pick → ${proposed}`,
          why: note || "Allowlisted pick.",
          changed: prior !== best.vin ? `Changed pick from ${prior} to ${best.vin}` : null,
          model: modelFrom(picked.proof, input.model),
          responseId: responseIdFrom(picked.proof),
          recordedAt,
        });
        const published = applyFlipPublishedAction({
          proposed,
          candidate: best,
          source: "SERV",
          journal,
          trail,
          recordedAt,
          model: modelFrom(picked.proof, input.model),
          responseId: responseIdFrom(picked.proof),
        });
        verdictAction = published.action;
        journal = published.journal;
        trail = published.trail;
      } else {
        const fail = journalWhyFromServAttempt({
          result: picked,
          validation,
          payload,
          missingPayloadFallback: "Pick payload missing allowlisted VIN.",
        });
        journal = appendJournalStep(journal, {
          kind: "fallback",
          actor: "SERV",
          decided: `Pick rejected — code keeps ${carLabel(best)}`,
          why: fail.why,
          inputsUsed: ordered.map((item) => `vin:${item.vin}`),
          changed: null,
          model: modelFrom(picked.proof, input.model),
          responseId: responseIdFrom(picked.proof, false),
          recordedAt,
          rejected: fail.rejected,
        });
      }
    } catch (err) {
      journal = appendJournalStep(journal, {
        kind: "fallback",
        actor: "code",
        decided: `Pick unavailable — code keeps ${carLabel(best)}`,
        why: err instanceof Error ? err.message : "Pick error.",
        inputsUsed: [`vin:${best.vin}`],
        changed: null,
        model: null,
        responseId: null,
        recordedAt,
        rejected: null,
      });
    }
  }

  if (
    runPick &&
    input.servKey?.trim() &&
    hasServSlot(journal) &&
    deadline &&
    !stageOk(RESALE_STAGE_BUDGET_MS.pick, pickTimeoutMs) &&
    !journal.steps.some((s) => s.kind === "pick" && s.actor === "SERV")
  ) {
    journal = appendJournalStep(journal, {
      kind: "fallback",
      actor: "code",
      decided: `Pick ${RESALE_TIME_BUDGET_SKIP}`,
      why: `Wall-clock budget remaining ${deadline.remainingMs()}ms — code pick ${carLabel(best)} stands.`,
      inputsUsed: [`vin:${best.vin}`],
      changed: null,
      model: null,
      responseId: null,
      recordedAt,
      rejected: null,
    });
  }

  if (phase === "pick") {
    const alternatives = pickAlternatives(ranked, best.vin, input.budgetUsd);
    const confidenceLabel =
      agentConfidence === "high" ? "High" : agentConfidence === "medium" ? "Medium" : "Low";
    const agentVerdict = finalizeAgentVerdict({
      best,
      verdictAction,
      agentConfidence,
      trail,
      secondPass,
      journal,
      ranJudge,
      ranDecide,
    });
    const checkpoint: ResaleSettleCheckpoint = {
      phaseCompleted: "pick",
      journal,
      rankedAll: ranked,
      ordered,
      shortlist,
      best,
      alternatives,
      verdictAction,
      confidence: confidenceLabel,
      agentVerdict,
      trail,
      secondPass,
      agentConfidence,
      ranJudge,
      ranDecide,
      trace: null,
      proofRecords,
      budgetUsd: input.budgetUsd,
      timeToSellPref: input.timeToSellPref,
    };
    return buildSettleResult({
      best,
      alternatives,
      agentVerdict,
      journal,
      trace: null,
      proofRecords,
      verdictAction,
      confidence: confidenceLabel,
      ranJudge,
      ranDecide,
      checkpoint,
    });
  }

  // --- Challenge (resale_challenge) ---
  const challengeTimeoutMs = deadline
    ? resaleCallTimeoutMs(profile("resale_challenge").timeoutMs, deadline)
    : profile("resale_challenge").timeoutMs;
  if (
    runChallenge &&
    input.servKey?.trim() &&
    hasServSlot(journal) &&
    challengeTimeoutMs != null &&
    stageOk(RESALE_STAGE_BUDGET_MS.challenge, challengeTimeoutMs)
  ) {
    const allowedVins = ordered.map((item) => item.vin.toUpperCase());
    const challengeEvidenceIds = [
      ...new Set([
        ...bundle.evidenceIds,
        ...ordered.flatMap((item) => [`vin:${item.vin.toUpperCase()}`, `pnl:${item.vin.toUpperCase()}`]),
      ]),
    ];
    const challengeFacts = {
      primaryPickVin: best.vin.toUpperCase(),
      allowedVins,
      allowedEvidenceIds: challengeEvidenceIds,
      allowedActions: ["buy", "negotiate", "pass", "needs_inspection"],
      primaryAction: verdictAction,
      evidence: challengeEvidenceIds.map((id) => ({
        id,
        text: id.startsWith("pnl:")
          ? `Code P&L mid profit for ${id.slice("pnl:".length)}`
          : `Allowlisted VIN ${id.replace(/^vin:/, "")}`,
      })),
      candidates: ordered.map((item) => ({
        vin: item.vin.toUpperCase(),
        profitMidUsd: item.profitMidUsd,
        compCount: item.compCount,
        confidence: item.confidence,
      })),
    };
    const challengeBundle = {
      ...bundle,
      vins: allowedVins,
      evidenceIds: challengeEvidenceIds,
      numberFacts: challengeFacts,
    };
    try {
      const allow = new Set(allowedVins);
      const attempt = await runResaleServWithRejectRetry({
        profileId: "resale_challenge",
        facts: challengeFacts,
        deps: {
          fetch: fetchImpl,
          timeoutMs: challengeTimeoutMs,
          apiKey: input.servKey,
          baseUrl: input.servBaseUrl,
          model: input.model,
        },
        deadline,
        canRetry: remainingServSlots(journal) > 1,
        validatePayload: (payload, result) => {
          const pickVinRaw = typeof payload?.pickVin === "string" ? normalizeVin(payload.pickVin) : null;
          const objection = typeof payload?.objection === "string" ? payload.objection : null;
          const evidenceIds = softFilterEvidenceIds(stringArrayField(payload, "evidenceIds"), challengeEvidenceIds);
          const base = validationFromCall({
            result,
            payload,
            text: objection,
            vins: pickVinRaw ? [pickVinRaw] : [],
            evidenceIds,
            bundle: challengeBundle,
          });
          if (!base.ok) return base;
          if (!pickVinRaw || !allow.has(pickVinRaw)) {
            return {
              ok: false,
              reason: "rejected: unsupported reference",
              detail: "Challenge payload unusable — pickVin must be copied from facts.allowedVins.",
            };
          }
          return { ok: true };
        },
      });
      const challenged = attempt.result;
      ranDecide = true;
      const payload = attempt.payload;
      const validation = attempt.validation;
      const agrees = payload?.agrees === true;
      const pickVin = typeof payload?.pickVin === "string" ? normalizeVin(payload.pickVin) : null;
      const action = typeof payload?.action === "string" ? payload.action : null;
      const objection = typeof payload?.objection === "string" ? payload.objection : null;
      const evidenceIds = softFilterEvidenceIds(stringArrayField(payload, "evidenceIds"), challengeEvidenceIds);
      if (attempt.attempt === 2) {
        journal = appendJournalStep(journal, {
          kind: "fallback",
          actor: "SERV",
          decided: "Challenge first response rejected — retried once with validation error",
          why: "Reject-retry within step budget.",
          inputsUsed: [`vin:${best.vin}`],
          changed: null,
          model: modelFrom(challenged.proof, input.model),
          responseId: null,
          recordedAt,
          rejected: "rejected: unsupported reference",
        });
      }
      if (challenged.ok && payload && validation.ok && pickVin && allow.has(pickVin)) {
        const prior = best.vin;
        if (!agrees) {
          best = ordered.find((item) => item.vin.toUpperCase() === pickVin) ?? best;
          const proposed: FlipPublishedAction =
            action === "buy" || action === "negotiate" || action === "pass" || action === "needs_inspection"
              ? action
              : verdictAction;
          agentConfidence = agentConfidence === "high" ? "medium" : agentConfidence === "medium" ? "low" : "low";
          journal = appendJournalStep(journal, {
            kind: "challenge",
            actor: "SERV",
            decided: `Challenge revised pick to ${carLabel(best)} → ${proposed}`,
            why: objection ?? "Challenger disagreed with evidence-backed reasons.",
            inputsUsed: [`vin:${best.vin}`, ...evidenceIds],
            changed: prior !== best.vin ? `Changed pick from ${prior} to ${best.vin} because ${objection ?? "challenge"}` : `Revised action to ${proposed}`,
            model: modelFrom(challenged.proof, input.model),
            responseId: responseIdFrom(challenged.proof),
            recordedAt,
            rejected: null,
          });
          const published = applyFlipPublishedAction({
            proposed,
            candidate: best,
            source: "SERV",
            journal,
            trail,
            recordedAt,
            model: modelFrom(challenged.proof, input.model),
            responseId: responseIdFrom(challenged.proof),
          });
          verdictAction = published.action;
          journal = published.journal;
          trail = published.trail;
          secondPass = {
            status: "disagreed",
            action: verdictAction,
            objection: objection ?? "Challenger revised the pick using allowlisted evidence.",
            evidenceIds,
            confidenceBefore: confidenceFromPnl(ordered.find((i) => i.vin === prior) ?? best),
            confidenceAfter: agentConfidence,
            profile: "resale_challenge",
            responseId: responseIdFrom(challenged.proof),
          };
        } else {
          secondPass = {
            status: "agreed",
            action: verdictAction,
            objection: null,
            evidenceIds,
            confidenceBefore: agentConfidence,
            confidenceAfter: agentConfidence,
            profile: "resale_challenge",
            responseId: responseIdFrom(challenged.proof),
          };
          journal = appendJournalStep(journal, {
            kind: "challenge",
            actor: "SERV",
            decided: "Challenge agreed with the pick",
            why: "Independent review agreed using allowlisted evidence ids.",
            inputsUsed: [`vin:${best.vin}`, ...evidenceIds],
            changed: null,
            model: modelFrom(challenged.proof, input.model),
            responseId: responseIdFrom(challenged.proof),
            recordedAt,
            rejected: null,
          });
        }
        trail.push({
          decided: agrees ? "SERV challenge agreed" : "SERV challenge revised pick",
          why: objection ?? "Challenge completed.",
          changed: !agrees && prior !== best.vin ? `Changed pick from ${prior} to ${best.vin}` : null,
          model: modelFrom(challenged.proof, input.model),
          responseId: responseIdFrom(challenged.proof),
          recordedAt,
        });
      } else {
        const fail = journalWhyFromServAttempt({
          result: challenged,
          validation,
          payload,
          missingPayloadFallback: "Challenge payload unusable.",
        });
        secondPass = {
          status: "ignored_malformed",
          action: null,
          objection: fail.why,
          evidenceIds: [],
          confidenceBefore: agentConfidence,
          confidenceAfter: agentConfidence,
        };
        journal = appendJournalStep(journal, {
          kind: "fallback",
          actor: "SERV",
          decided: "Challenge rejected — first pick stands",
          why: fail.why,
          inputsUsed: [`vin:${best.vin}`],
          changed: null,
          model: modelFrom(challenged.proof, input.model),
          responseId: responseIdFrom(challenged.proof, false),
          recordedAt,
          rejected: fail.rejected,
        });
      }
    } catch {
      secondPass = {
        status: "unavailable",
        action: null,
        objection: "Second check did not finish. The first verdict stands.",
        evidenceIds: [],
        confidenceBefore: agentConfidence,
        confidenceAfter: agentConfidence,
      };
    }
  }

  if (
    runChallenge &&
    input.servKey?.trim() &&
    hasServSlot(journal) &&
    deadline &&
    !stageOk(RESALE_STAGE_BUDGET_MS.challenge, challengeTimeoutMs) &&
    secondPass.status === "not_run"
  ) {
    secondPass = {
      status: "not_run",
      action: null,
      objection: `Challenge ${RESALE_TIME_BUDGET_SKIP}. The first verdict stands.`,
      evidenceIds: [],
      confidenceBefore: agentConfidence,
      confidenceAfter: agentConfidence,
    };
    journal = appendJournalStep(journal, {
      kind: "fallback",
      actor: "code",
      decided: `Challenge ${RESALE_TIME_BUDGET_SKIP}`,
      why: `Wall-clock budget remaining ${deadline.remainingMs()}ms — first pick stands.`,
      inputsUsed: [`vin:${best.vin}`],
      changed: null,
      model: null,
      responseId: null,
      recordedAt,
      rejected: null,
    });
  }

  if (phase === "challenge" || phase === "pick_challenge") {
    const alternatives = pickAlternatives(ranked, best.vin, input.budgetUsd);
    const confidenceLabel =
      agentConfidence === "high" ? "High" : agentConfidence === "medium" ? "Medium" : "Low";
    const agentVerdict = finalizeAgentVerdict({
      best,
      verdictAction,
      agentConfidence,
      trail,
      secondPass,
      journal,
      ranJudge,
      ranDecide,
    });
    const checkpoint: ResaleSettleCheckpoint = {
      phaseCompleted: phase === "challenge" ? "challenge" : "pick_challenge",
      journal,
      rankedAll: ranked,
      ordered,
      shortlist,
      best,
      alternatives,
      verdictAction,
      confidence: confidenceLabel,
      agentVerdict,
      trail,
      secondPass,
      agentConfidence,
      ranJudge,
      ranDecide,
      trace: null,
      proofRecords,
      budgetUsd: input.budgetUsd,
      timeToSellPref: input.timeToSellPref,
    };
    return buildSettleResult({
      best,
      alternatives,
      agentVerdict,
      journal,
      trace: null,
      proofRecords,
      verdictAction,
      confidence: confidenceLabel,
      ranJudge,
      ranDecide,
      checkpoint,
    });
  }

  // Optional shopper decide path for ComputedReport parity (counts toward cap when key present and budget remains).
  // Decide timeout is clamped here; challenge is re-clamped inside runShopperVerdictServ after decide returns.
  const shopperTimeoutDecide = deadline
    ? resaleCallTimeoutMs(profile("verdict_decide").timeoutMs, deadline)
    : profile("verdict_decide").timeoutMs;
  if (runShopperPhase) {
    const skipShopper = (
      decided: string,
      why: string,
      status?: "skipped_no_key" | "skipped_call_cap" | "skipped_time_budget",
    ) => {
      journal = appendJournalStep(journal, {
        kind: "fallback",
        actor: "code",
        decided,
        why,
        inputsUsed: [`vin:${best.vin}`],
        changed: null,
        model: null,
        responseId: null,
        recordedAt,
        rejected: null,
      });
      // Only emit a proof row for pre-shopper skips — after runShopperVerdictServ we already have its rows.
      if (status) {
        proofRecords = [
          ...proofRecords,
          buildDecisionProofRecord({
            purpose: "verdict_decide",
            rubricId: VERDICT_RUBRIC_ID,
            status,
            recordedAt,
            inputs: { vin: best.vin, phase: "resale_shopper" },
            detail: why,
          }),
        ];
      }
    };
    if (!input.servKey?.trim()) {
      skipShopper(
        "Verdict decide skipped: SERV not configured",
        "SERV_API_KEY is not configured — pick/challenge stand without shopper decide.",
        "skipped_no_key",
      );
    } else if (!hasServSlot(journal)) {
      skipShopper(
        `Verdict decide skipped: ${callCapSkipLine(journal)}`,
        callCapSkipWhy(journal),
        "skipped_call_cap",
      );
    } else if (shopperTimeoutDecide == null || !stageOk(RESALE_STAGE_BUDGET_MS.shopper, shopperTimeoutDecide)) {
      skipShopper(
        `Verdict decide skipped: ${RESALE_TIME_BUDGET_SKIP}`,
        `Wall-clock budget remaining ${deadline?.remainingMs() ?? 0}ms — resale pick/challenge stand without shopper SERV.`,
        "skipped_time_budget",
      );
    } else {
      const report = buildFlipReport(best, input.budgetUsd, ranked);
      const shopperSlots = remainingServSlots(journal);
      const shopper = await runShopperVerdictServ({
        report,
        mandate: {
          budgetUsd: input.budgetUsd,
          budgetKnown: true,
          targetProfitUsd: ASSUMPTIONS.flipDesiredProfitUsd,
        },
        servKey: input.servKey,
        servBaseUrl: input.servBaseUrl,
        model: input.model,
        fetchImpl,
        deadline,
        decideTimeoutMs: shopperTimeoutDecide,
        maxAdditionalServCalls: shopperSlots,
      });
      proofRecords = [...proofRecords, ...shopper.proofRecords];
      if (shopper.trace && shopper.trace.calls.length > 0) {
        ranDecide = true;
        trace = shopper.trace;
        const action = shopper.decision.finalAction;
        if (action === "buy" || action === "negotiate" || action === "pass" || action === "needs_inspection") {
          const published = applyFlipPublishedAction({
            proposed: action,
            candidate: best,
            source: "SERV",
            journal,
            trail,
            recordedAt: shopper.trace.recordedAt,
            model: shopper.trace.calls[0]?.model ?? input.model ?? null,
            responseId: shopper.trace.calls[0]?.responseId ?? null,
          });
          verdictAction = published.action;
          journal = published.journal;
          trail = published.trail;
        }
        if (shopper.agentVerdict.confidence) agentConfidence = shopper.agentVerdict.confidence;
        if (shopper.agentVerdict.second_pass && shopper.agentVerdict.second_pass.status !== "not_run") {
          const challengeCall = shopper.trace.calls.find((call) => call.profile === "verdict_challenge");
          secondPass = {
            ...shopper.agentVerdict.second_pass,
            profile: shopper.agentVerdict.second_pass.profile ?? "verdict_challenge",
            responseId:
              shopper.agentVerdict.second_pass.responseId ?? challengeCall?.responseId ?? null,
          };
        }
        for (const call of shopper.trace.calls) {
          const fail = call.ok
            ? null
            : journalWhyFromShopperCall({
                ok: call.ok,
                error: call.error,
                latencyMs: call.latencyMs,
              });
          const decideWhy = decideWhyWithGateResult(shopper.decision);
          journal = appendJournalStep(journal, {
            kind: call.profile === "verdict_decide" ? "pick" : "challenge",
            actor: "SERV",
            decided:
              call.profile === "verdict_decide"
                ? `Verdict decide → ${verdictAction}`
                : `Verdict challenge → ${call.ok ? "ok" : "fail"}`,
            why: call.ok
              ? call.profile === "verdict_decide"
                ? decideWhy
                : secondPass.objection ?? "Shopper challenge."
              : fail?.why ?? "Shopper SERV call failed.",
            inputsUsed: [`vin:${best.vin}`, `check:${call.profile}`],
            changed: null,
            model: call.model ?? input.model ?? null,
            responseId: call.responseId,
            recordedAt: shopper.trace.recordedAt,
            rejected: call.ok ? null : fail?.rejected ?? "call_failed",
          });
          trail.push({
            decided:
              call.profile === "verdict_decide"
                ? `Verdict decide → ${verdictAction}`
                : `Verdict challenge → ${call.ok ? "ok" : "fail"}`,
            why: call.ok
              ? call.profile === "verdict_decide"
                ? decideWhy
                : secondPass.objection ?? "Shopper challenge."
              : fail?.why ?? "Shopper SERV call failed.",
            changed: null,
            model: call.model ?? input.model ?? null,
            responseId: call.responseId,
            recordedAt: shopper.trace.recordedAt,
          });
        }
      } else {
        const decideStep = shopper.steps.find((s) => s.id === "serv_verdict_decide");
        const detail =
          decideStep?.detail?.trim() ||
          shopper.steps.map((s) => `${s.id}:${s.status}`).join(", ") ||
          "no SERV trace recorded";
        skipShopper(`Verdict decide skipped: ${detail}`, "Shopper decide did not record a SERV call.");
      }
      const challengeStep = shopper.steps.find((s) => s.id === "serv_verdict_challenge");
      const challengeCallRan = Boolean(
        shopper.trace?.calls.some((call) => call.profile === "verdict_challenge"),
      );
      if (!challengeCallRan && challengeStep && challengeStep.status !== "ok") {
        const reason =
          challengeStep.detail?.trim() ||
          challengeStep.status ||
          "Shopper challenge was not run after decide.";
        if (challengeStep.status === "skipped_time_budget" || reason === RESALE_TIME_BUDGET_SKIP) {
          skipShopper(
            `Verdict challenge skipped: ${RESALE_TIME_BUDGET_SKIP}`,
            `Wall-clock budget remaining ${deadline?.remainingMs() ?? 0}ms after decide — shopper challenge skipped.`,
          );
        } else if (challengeStep.status === "skipped_call_cap") {
          skipShopper(
            `Verdict challenge skipped: ${callCapSkipLine(journal)}`,
            `${callCapSkipWhy(journal)}. ${reason}`,
          );
        } else {
          skipShopper(`Verdict challenge skipped: ${reason}`, reason);
        }
      }
    }
  }

  const alternatives = pickAlternatives(ranked, best.vin, input.budgetUsd);
  const confidenceLabel =
    agentConfidence === "high" ? "High" : agentConfidence === "medium" ? "Medium" : "Low";

  const agentVerdict = finalizeAgentVerdict({
    best,
    verdictAction,
    agentConfidence,
    trail,
    secondPass,
    journal,
    ranJudge,
    ranDecide,
  });

  const checkpoint: ResaleSettleCheckpoint = {
    phaseCompleted: "shopper",
    journal,
    rankedAll: ranked,
    ordered,
    shortlist,
    best,
    alternatives,
    verdictAction,
    confidence: confidenceLabel,
    agentVerdict,
    trail,
    secondPass,
    agentConfidence,
    ranJudge,
    ranDecide,
    trace,
    proofRecords,
    budgetUsd: input.budgetUsd,
    timeToSellPref: input.timeToSellPref,
  };

  return buildSettleResult({
    best,
    alternatives,
    agentVerdict,
    journal,
    trace,
    proofRecords,
    verdictAction,
    confidence: confidenceLabel,
    ranJudge,
    ranDecide,
    checkpoint,
  });
}
