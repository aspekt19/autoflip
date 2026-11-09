/**
 * Resale SERV settle: flip_judge shortlist filter → verdict_decide + challenge on the best flip.
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
import { quotedNumbersStayIn } from "@/domain/decision-note";
import type { ResaleCandidatePnl } from "@/domain/resale-pnl";
import type { ComputedReport, Listing, Verdict } from "@/domain/types";
import { runShopperVerdictServ, type ShopperServTrace } from "@/server/shopper-verdict-serv";
import { runServ, type ServProof } from "@/server/serv";

const RESALE_SERV_JUDGE_MAX = 3;

export type ResaleSettleServResult = {
  best: ResaleCandidatePnl | null;
  alternatives: ResaleCandidatePnl[];
  agentVerdict: AgentVerdict;
  trace: ShopperServTrace | null;
  /** Honest always-on verdict label for the UI. */
  verdictAction: "buy" | "negotiate" | "pass" | "needs_inspection";
  confidence: "High" | "Medium" | "Low";
  ranJudge: boolean;
  ranDecide: boolean;
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

function responseIdFrom(proof: ServProof | null): string | null {
  const id = proof?.openserv?.id;
  return typeof id === "string" && id.trim() ? id : null;
}

function buildFlipReport(candidate: ResaleCandidatePnl, budgetUsd: number): ComputedReport {
  const subject: Listing = candidate.listing;
  const fair = candidate.resaleMidUsd;
  const ask = candidate.askingUsd;
  const priceGap = fair != null && fair > 0 ? (ask - fair) / fair : null;
  let verdict: Verdict = "insufficient_data";
  if (fair != null && priceGap != null) {
    if (priceGap <= ASSUMPTIONS.goodDealGap) verdict = "good_deal";
    else if (priceGap <= ASSUMPTIONS.fairGap) verdict = "fair";
    else if (priceGap <= ASSUMPTIONS.overpricedGap) verdict = "overpriced";
    else verdict = "walk_away";
  }
  return {
    mode: "flip",
    subject,
    verdict,
    score: candidate.score,
    reasons: [
      candidate.profitMidUsd != null
        ? `Code estimate mid profit $${candidate.profitMidUsd.toLocaleString("en-US")} from ${candidate.compCount} similar listings.`
        : "Profit band incomplete — similar listings were thin.",
      candidate.negotiateBasis,
      candidate.resaleChannelBasis,
    ],
    flags: [],
    questions: candidate.checkBeforeBuying.slice(0, 6),
    comps: [],
    compScope: "Resale search similar asks in this scan",
    percentile: null,
    fairValueUsd: fair,
    fairRangeLowUsd: candidate.resaleLowUsd,
    fairRangeHighUsd: candidate.resaleHighUsd,
    fairConfidence: candidate.compCount >= 5 ? "reasonable" : candidate.compCount >= 3 ? "rough" : "not_available",
    compMethodNote:
      "Adjusted similar listing asks (mileage/year/trim) via evaluateListingPrice — not identical-car matching or closed sales.",
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
    flip: null,
    assumptions: { ...ASSUMPTIONS },
    dataNotes: candidate.risks.slice(0, 8),
    sample: false,
    mandate: {
      budgetUsd,
      budgetKnown: true,
      targetProfitUsd: null,
      repairAbility: "unknown",
    },
  };
}

function parseFlipJudgment(
  text: string,
  facts: Array<{ vin: string } & Record<string, unknown>>,
): Map<string, { verdict: "alert" | "skip"; note: string }> | null {
  try {
    const parsed = JSON.parse(text) as { decisions?: Array<{ vin?: string; verdict?: string; note?: string }> };
    if (!Array.isArray(parsed.decisions)) return null;
    const allowed = JSON.stringify(facts);
    const known = new Set(facts.map((item) => item.vin));
    const decisions = new Map<string, { verdict: "alert" | "skip"; note: string }>();
    for (const decision of parsed.decisions) {
      if (!decision.vin || !known.has(decision.vin)) continue;
      if (decision.verdict !== "alert" && decision.verdict !== "skip") continue;
      const note = typeof decision.note === "string" ? decision.note : "";
      const safe = !note.trim() || quotedNumbersStayIn(note, allowed);
      decisions.set(decision.vin, { verdict: decision.verdict, note: safe ? note : "" });
    }
    return decisions;
  } catch {
    return null;
  }
}

function sortByProfit(items: ResaleCandidatePnl[]): ResaleCandidatePnl[] {
  return [...items].sort((a, b) => (b.profitMidUsd ?? Number.NEGATIVE_INFINITY) - (a.profitMidUsd ?? Number.NEGATIVE_INFINITY));
}

/**
 * Pick best flip + alternatives. Always returns a verdict (never a dead end).
 */
export async function runResaleSettleServ(input: {
  candidates: ResaleCandidatePnl[];
  budgetUsd: number;
  timeToSellPref?: "any" | "faster" | "unknown";
  servKey?: string;
  servBaseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}): Promise<ResaleSettleServResult> {
  const recordedAt = new Date().toISOString();
  const trail: AgentTrailStep[] = [];
  const fetchImpl = input.fetchImpl ?? fetch;
  const ranked = sortByProfit(input.candidates);
  const shortlist = ranked.slice(0, RESALE_SERV_JUDGE_MAX);

  if (shortlist.length === 0) {
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
    });
    return {
      best: null,
      alternatives: [],
      agentVerdict,
      trace: null,
      verdictAction: "pass",
      confidence: "Low",
      ranJudge: false,
      ranDecide: false,
    };
  }

  let working = shortlist;
  let ranJudge = false;
  let judgeProof: ServProof | null = null;

  if (input.servKey?.trim() && shortlist.length > 0) {
    const facts = shortlist.map((item) => ({
      vin: item.vin,
      year: item.listing.year,
      make: item.listing.make,
      model: item.listing.model,
      askingUsd: item.askingUsd,
      fairValueUsd: item.resaleMidUsd,
      compCount: item.compCount,
      profitLowUsd: item.profitLowUsd,
      profitMidUsd: item.profitMidUsd,
      profitHighUsd: item.profitHighUsd,
      confidence: item.confidence,
      speed: item.speed,
      speedBasis: item.daysToSellBasis,
    }));
    try {
      const judged = await runServ("flip_judge", { user: JSON.stringify({ facts, rulesNote: null }) }, {
        fetch: fetchImpl,
        apiKey: input.servKey,
        baseUrl: input.servBaseUrl,
        model: input.model,
      });
      judgeProof = judged.proof;
      ranJudge = true;
      const decisions = judged.ok ? parseFlipJudgment(judged.text, facts) : null;
      if (decisions && decisions.size > 0) {
        const alerted = shortlist.filter((item) => decisions.get(item.vin)?.verdict === "alert");
        const skipped = shortlist.filter((item) => decisions.get(item.vin)?.verdict === "skip");
        if (alerted.length > 0) working = alerted;
        trail.push({
          decided: alerted.length
            ? `SERV flagged ${alerted.length} of ${shortlist.length} candidates as worth a closer look`
            : `SERV skipped all ${shortlist.length} shortlist cars — code still ranks the top estimate`,
          why: alerted.length
            ? alerted.map((item) => decisions.get(item.vin)?.note || carLabel(item)).join("; ")
            : skipped.map((item) => decisions.get(item.vin)?.note || carLabel(item)).join("; ") ||
              "No usable alert notes; ranking falls back to code profit mid.",
          changed: alerted.length ? `Shortlist narrowed to ${alerted.map(carLabel).join(", ")}` : null,
          model: input.model || judged.proof.modelReported || judged.proof.modelRequested || null,
          responseId: responseIdFrom(judged.proof),
          recordedAt,
        });
      } else {
        trail.push({
          decided: "SERV flip judge unavailable — code ranking stands",
          why: judged.ok
            ? "Judge payload could not be parsed against allowlisted VINs."
            : "Judge call failed or timed out.",
          changed: null,
          model: input.model || judged.proof.modelReported || judged.proof.modelRequested || null,
          responseId: responseIdFrom(judged.proof),
          recordedAt,
        });
      }
    } catch (err) {
      trail.push({
        decided: "SERV flip judge unavailable — code ranking stands",
        why: err instanceof Error ? err.message : "Judge call threw.",
        changed: null,
        model: input.model ?? null,
        responseId: null,
        recordedAt,
      });
    }
  } else {
    trail.push({
      decided: "No SERV key — code ranked by expected mid profit",
      why: `Top candidate is ${carLabel(shortlist[0]!)} from code P&L only.`,
      changed: null,
      recordedAt,
    });
  }

  if (input.timeToSellPref === "faster") {
    const faster = working.filter((item) => item.speed === "faster" || item.speed === "typical");
    if (faster.length > 0) working = faster;
  }

  const ordered = sortByProfit(working.length ? working : shortlist);
  const best = ordered[0]!;
  const alternatives = sortByProfit(ranked.filter((item) => item.vin !== best.vin)).slice(0, 4);

  let ranDecide = false;
  let trace: ShopperServTrace | null = null;
  let secondPass: AgentSecondPassResult = {
    status: "not_run",
    action: null,
    objection: "Second check not run.",
    evidenceIds: [],
    confidenceBefore: null,
    confidenceAfter: null,
  };
  let verdictAction: ResaleSettleServResult["verdictAction"] = "negotiate";
  let agentConfidence = confidenceFromPnl(best);

  if (input.servKey?.trim()) {
    const report = buildFlipReport(best, input.budgetUsd);
    const shopper = await runShopperVerdictServ({
      report,
      mandate: { budgetUsd: input.budgetUsd, budgetKnown: true },
      servKey: input.servKey,
      servBaseUrl: input.servBaseUrl,
      model: input.model,
      fetchImpl,
    });
    ranDecide = Boolean(shopper.trace);
    trace = shopper.trace;
    secondPass =
      shopper.agentVerdict.second_pass ??
      ({
        status: "not_run",
        action: null,
        objection: "Second check not run: shopper SERV returned no challenge record.",
        evidenceIds: [],
        confidenceBefore: null,
        confidenceAfter: null,
      } satisfies AgentSecondPassResult);

    const action = shopper.decision.finalAction;
    if (action === "buy" || action === "negotiate" || action === "pass" || action === "needs_inspection") {
      verdictAction = action;
    }
    if (shopper.agentVerdict.confidence) agentConfidence = shopper.agentVerdict.confidence;

    for (const call of shopper.trace?.calls ?? []) {
      trail.push({
        decided:
          call.profile === "verdict_decide"
            ? `Verdict decide → ${verdictAction}`
            : `Verdict challenge → ${call.ok ? "completed" : "failed"}`,
        why:
          call.profile === "verdict_decide"
            ? shopper.decision.note ?? "Decide used code-computed fair value and profit facts only."
            : secondPass.objection ?? "Challenge finished.",
        changed:
          call.profile === "verdict_challenge" && secondPass.status === "disagreed"
            ? `Challenger would ${secondPass.action ?? "change the action"}`
            : null,
        model: call.model ?? input.model ?? null,
        responseId: call.responseId,
        recordedAt: shopper.trace?.recordedAt ?? recordedAt,
      });
    }
    if (!shopper.trace) {
      trail.push({
        decided: `Deterministic verdict → ${verdictAction}`,
        why: shopper.decision.note ?? shopper.decision.withholdReason ?? "No SERV decide call; code guardrails chose the action.",
        changed: null,
        recordedAt,
      });
    }
  } else {
    verdictAction = best.profitMidUsd != null && best.profitMidUsd > 0 ? "negotiate" : "needs_inspection";
    secondPass = {
      status: "skipped_no_key",
      action: null,
      objection: "Second check not run: SERV_API_KEY is not configured on this deployment.",
      evidenceIds: [],
      confidenceBefore: null,
      confidenceAfter: null,
    };
    trail.push({
      decided: `Code verdict → ${verdictAction}`,
      why:
        best.profitMidUsd != null && best.profitMidUsd > 0
          ? `Mid profit estimate $${best.profitMidUsd.toLocaleString("en-US")} — negotiate path without inventing a guarantee.`
          : "Mid profit is thin or unknown — inspection-first path.",
      changed: null,
      recordedAt,
    });
  }

  // Ignore unused judgeProof reference for lint if needed
  void judgeProof;

  const confidenceLabel =
    agentConfidence === "high" ? "High" : agentConfidence === "medium" ? "Medium" : "Low";

  const agentVerdict: AgentVerdict = {
    ...emptyAgentVerdict({
      pick: { key: best.vin, label: carLabel(best) },
      verdict: verdictAction,
      confidence: agentConfidence,
      reasons: [
        {
          evidenceId: "pnl_mid",
          text:
            best.profitMidUsd != null
              ? `Expected mid net profit about $${best.profitMidUsd.toLocaleString("en-US")} (estimate from similar listings minus labeled costs).`
              : "Profit mid unavailable — similar listings were thin.",
        },
        { evidenceId: "comps", text: `${best.compCount} similar listings in this scan.` },
      ],
      risks: best.risks.slice(0, 4).map((text, i) => ({ evidenceId: `risk_${i}`, text })),
      unknowns: [
        ...(best.salesTaxUsd == null ? ["Sales tax unknown without listing state."] : []),
        "Title/registration dollar amount unknown.",
        ...(best.estimatedDaysToSell == null ? ["Days to sell unknown without listing age / DOM feed."] : []),
      ],
      serv_steps: trail,
      second_pass: secondPass,
      no_serv_step: !ranJudge && !ranDecide,
      serv_spend: {
        calls: (ranJudge ? 1 : 0) + (trace?.calls.length ?? 0),
        costNote: null,
      },
    }),
  };

  return {
    best,
    alternatives,
    agentVerdict,
    trace,
    verdictAction,
    confidence: confidenceLabel,
    ranJudge,
    ranDecide,
  };
}
