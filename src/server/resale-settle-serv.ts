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
import {
  evidenceBundleFromCandidates,
  validateResaleServOutput,
} from "@/domain/resale-serv-validate";
import type { ComputedReport, Listing, Verdict } from "@/domain/types";
import { rankByRiskAdjustedProfit, runResaleDeepChecks } from "@/server/resale-deep-check";
import { runShopperVerdictServ, type ShopperServTrace } from "@/server/shopper-verdict-serv";
import { profile, runServ, type ServProof } from "@/server/serv";
import {
  resaleCallTimeoutMs,
  RESALE_STAGE_BUDGET_MS,
  RESALE_TIME_BUDGET_SKIP,
  type ResaleDeadline,
} from "@/domain/resale-deadline";

const RESALE_SERV_JUDGE_MAX = 3;

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

function modelFrom(proof: ServProof | null, fallback?: string | null): string | null {
  return fallback || proof?.modelReported || proof?.modelRequested || null;
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
        ? `Code estimate mid profit $${candidate.profitMidUsd.toLocaleString("en-US")}${
            candidate.profitScopeLabel ? ` ${candidate.profitScopeLabel}` : ""
          } from ${candidate.compCount} similar listings.`
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

function sortByProfit(items: ResaleCandidatePnl[]): ResaleCandidatePnl[] {
  return [...items].sort((a, b) => {
    const aMid = a.rankingProfitMidUsd ?? a.profitMidUsd ?? Number.NEGATIVE_INFINITY;
    const bMid = b.rankingProfitMidUsd ?? b.profitMidUsd ?? Number.NEGATIVE_INFINITY;
    return bMid - aMid;
  });
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
  /** When set, skip remaining SERV stages once the wall-clock budget is gone. */
  deadline?: ResaleDeadline;
}): Promise<ResaleSettleServResult> {
  const recordedAt = new Date().toISOString();
  const trail: AgentTrailStep[] = [];
  let journal = emptyResaleJournal(RESALE_SERV_CALL_CAP);
  const fetchImpl = input.fetchImpl ?? fetch;
  const ranked = sortByProfit(input.candidates);
  const shortlist = ranked.slice(0, RESALE_SERV_JUDGE_MAX);

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
    return {
      best: null,
      alternatives: [],
      agentVerdict,
      journal,
      trace: null,
      verdictAction: "pass",
      confidence: "Low",
      ranJudge: false,
      ranDecide: false,
    };
  }

  const bundle = evidenceBundleFromCandidates(shortlist, [
    "check:price_comps",
    "check:vin_decode",
    "check:recalls",
    "check:complaints",
  ]);
  let working = shortlist;
  let ranJudge = false;

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
  let selectedCheckIds = ["price_comps", "history"];
  const deadline = input.deadline;
  const triageTimeoutMs = deadline
    ? resaleCallTimeoutMs(profile("resale_triage").timeoutMs, deadline)
    : profile("resale_triage").timeoutMs;
  if (
    input.servKey?.trim() &&
    journal.servCalls < journal.servCallCap &&
    (!deadline || deadline.allow(RESALE_STAGE_BUDGET_MS.triage)) &&
    triageTimeoutMs != null
  ) {
    const allowedCheckIds = ["price_comps", "vin_decode", "recalls", "complaints", "history"];
    const facts = {
      allowedVins: shortlist.map((item) => item.vin),
      allowedCheckIds,
      candidates: shortlist.map((item) => ({
        vin: item.vin,
        profitMidUsd: item.profitMidUsd,
        compCount: item.compCount,
        confidence: item.confidence,
        askingUsd: item.askingUsd,
      })),
    };
    try {
      const judged = await runServ("resale_triage", { user: JSON.stringify({ facts }) }, {
        fetch: fetchImpl,
        apiKey: input.servKey,
        baseUrl: input.servBaseUrl,
        model: input.model,
        timeoutMs: triageTimeoutMs,
      });
      ranJudge = true;
      const payload = judged.ok ? parseJsonObject(judged.text) : null;
      const deep = Array.isArray(payload?.deepCheckVins)
        ? (payload!.deepCheckVins as unknown[]).filter((v): v is string => typeof v === "string")
        : [];
      const skip = Array.isArray(payload?.skipVins)
        ? (payload!.skipVins as unknown[]).filter((v): v is string => typeof v === "string")
        : [];
      const checks = Array.isArray(payload?.checkIds)
        ? (payload!.checkIds as unknown[]).filter((v): v is string => typeof v === "string")
        : [];
      const note = typeof payload?.note === "string" ? payload.note : "";
      const validation = validateResaleServOutput(
        {
          text: note,
          vins: [...deep, ...skip],
          evidenceIds: checks.map((id) => `check:${id}`),
        },
        {
          ...bundle,
          evidenceIds: [...bundle.evidenceIds, ...allowedCheckIds.map((id) => `check:${id}`), "check:history"],
          numberFacts: facts,
        },
      );
      if (!judged.ok || !payload || !validation.ok) {
        journal = appendJournalStep(journal, {
          kind: "fallback",
          actor: "SERV",
          decided: "Triage rejected or unavailable — code shortlist stands",
          why: !validation.ok ? validation.detail : "Triage call failed or payload unusable.",
          inputsUsed: shortlist.map((item) => `vin:${item.vin}`),
          changed: null,
          model: modelFrom(judged.proof, input.model),
          responseId: responseIdFrom(judged.proof),
          recordedAt,
          rejected: !validation.ok ? validation.reason : null,
        });
      } else {
        const allow = new Set(shortlist.map((item) => item.vin));
        const deepOk = deep.filter((vin) => allow.has(vin));
        const skipOk = skip.filter((vin) => allow.has(vin));
        if (deepOk.length > 0) {
          working = shortlist.filter((item) => deepOk.includes(item.vin));
        }
        const safeChecks = checks.filter((id) => allowedCheckIds.includes(id));
        if (safeChecks.length > 0) selectedCheckIds = safeChecks;
        journal = appendJournalStep(journal, {
          kind: "triage",
          actor: "SERV",
          decided: `Deep-check ${deepOk.length || shortlist.length} VIN(s); skip ${skipOk.length}; checks ${safeChecks.join(", ") || "none"}`,
          why: note || "Triage used allowlisted VINs and check ids only.",
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
          why: note || "Allowlisted deep-check selection.",
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
    (triageTimeoutMs == null || !deadline.allow(RESALE_STAGE_BUDGET_MS.triage))
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
    stageCapMs: RESALE_STAGE_BUDGET_MS.deepCheck,
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

  // Risk-adjusted rank after deep-checks (code math only).
  let ordered = rankByRiskAdjustedProfit(working.length ? working : shortlist, deep.riskByVin);
  journal = appendJournalStep(journal, {
    kind: "rank",
    actor: "code",
    decided: `Re-ranked by risk-adjusted expected mid profit`,
    why: `Top after deep-checks: ${carLabel(ordered[0]!)}. Risk multipliers come from comps/recalls/history — not invented.`,
    inputsUsed: ordered.map((item) => `pnl:${item.vin}`),
    changed: ordered[0] && shortlist[0] && ordered[0].vin !== shortlist[0].vin
      ? `Changed lead from ${shortlist[0].vin} to ${ordered[0].vin} after deep-checks`
      : null,
    model: null,
    responseId: null,
    recordedAt,
    rejected: null,
  });
  let best = ordered[0]!;
  let verdictAction: ResaleSettleServResult["verdictAction"] =
    best.profitMidUsd != null && best.profitMidUsd > 0 ? "negotiate" : "needs_inspection";

  // --- Pick (resale_pick) ---
  const pickTimeoutMs = deadline
    ? resaleCallTimeoutMs(profile("resale_pick").timeoutMs, deadline)
    : profile("resale_pick").timeoutMs;
  if (
    input.servKey?.trim() &&
    journal.servCalls < journal.servCallCap &&
    (!deadline || deadline.allow(RESALE_STAGE_BUDGET_MS.pick)) &&
    pickTimeoutMs != null
  ) {
    const pickFacts = {
      allowedVins: ordered.map((item) => item.vin),
      candidates: ordered.map((item) => ({
        vin: item.vin,
        profitMidUsd: item.profitMidUsd,
        roiPctMid: item.roiPctMid,
        compCount: item.compCount,
        confidence: item.confidence,
        askingUsd: item.askingUsd,
        fairValueUsd: item.resaleMidUsd,
      })),
    };
    try {
      const picked = await runServ("resale_pick", { user: JSON.stringify({ facts: pickFacts }) }, {
        fetch: fetchImpl,
        apiKey: input.servKey,
        baseUrl: input.servBaseUrl,
        model: input.model,
        timeoutMs: pickTimeoutMs,
      });
      const payload = picked.ok ? parseJsonObject(picked.text) : null;
      const pickVin = typeof payload?.pickVin === "string" ? payload.pickVin : null;
      const action = typeof payload?.action === "string" ? payload.action : null;
      const note = typeof payload?.note === "string" ? payload.note : "";
      const evidenceIds = Array.isArray(payload?.evidenceIds)
        ? (payload!.evidenceIds as unknown[]).filter((id): id is string => typeof id === "string")
        : [];
      const validation = validateResaleServOutput(
        { text: note, vins: pickVin ? [pickVin] : [], evidenceIds },
        { ...bundle, numberFacts: pickFacts },
      );
      const allow = new Set(ordered.map((item) => item.vin));
      if (picked.ok && payload && validation.ok && pickVin && allow.has(pickVin)) {
        const prior = best.vin;
        best = ordered.find((item) => item.vin === pickVin) ?? best;
        if (action === "buy" || action === "negotiate" || action === "pass" || action === "needs_inspection") {
          verdictAction = action;
        }
        journal = appendJournalStep(journal, {
          kind: "pick",
          actor: "SERV",
          decided: `Pick ${carLabel(best)} → ${verdictAction}`,
          why: note || "Pick used allowlisted VIN and code P&L facts.",
          inputsUsed: [`vin:${best.vin}`, ...evidenceIds],
          changed: prior !== best.vin ? `Changed pick from ${prior} to ${best.vin}` : null,
          model: modelFrom(picked.proof, input.model),
          responseId: responseIdFrom(picked.proof),
          recordedAt,
          rejected: null,
        });
        trail.push({
          decided: `SERV pick → ${verdictAction}`,
          why: note || "Allowlisted pick.",
          changed: prior !== best.vin ? `Changed pick from ${prior} to ${best.vin}` : null,
          model: modelFrom(picked.proof, input.model),
          responseId: responseIdFrom(picked.proof),
          recordedAt,
        });
      } else {
        journal = appendJournalStep(journal, {
          kind: "fallback",
          actor: "SERV",
          decided: `Pick rejected — code keeps ${carLabel(best)}`,
          why: !validation.ok ? validation.detail : "Pick payload missing allowlisted VIN.",
          inputsUsed: ordered.map((item) => `vin:${item.vin}`),
          changed: null,
          model: modelFrom(picked.proof, input.model),
          responseId: responseIdFrom(picked.proof),
          recordedAt,
          rejected: !validation.ok ? validation.reason : "rejected: unsupported reference",
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
    input.servKey?.trim() &&
    journal.servCalls < journal.servCallCap &&
    deadline &&
    (pickTimeoutMs == null || !deadline.allow(RESALE_STAGE_BUDGET_MS.pick)) &&
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

  // --- Challenge (resale_challenge) ---
  let ranDecide = false;
  let trace: ShopperServTrace | null = null;
  let secondPass: AgentSecondPassResult = {
    status: input.servKey?.trim() ? "not_run" : "skipped_no_key",
    action: null,
    objection: input.servKey?.trim()
      ? "Second check not run yet."
      : "Second check not run: SERV_API_KEY is not configured on this deployment.",
    evidenceIds: [],
    confidenceBefore: confidenceFromPnl(best),
    confidenceAfter: null,
  };
  let agentConfidence = confidenceFromPnl(best);

  const challengeTimeoutMs = deadline
    ? resaleCallTimeoutMs(profile("resale_challenge").timeoutMs, deadline)
    : profile("resale_challenge").timeoutMs;
  if (
    input.servKey?.trim() &&
    journal.servCalls < journal.servCallCap &&
    (!deadline || deadline.allow(RESALE_STAGE_BUDGET_MS.challenge)) &&
    challengeTimeoutMs != null
  ) {
    const challengeFacts = {
      primaryPickVin: best.vin,
      allowedVins: ordered.map((item) => item.vin),
      allowedEvidenceIds: bundle.evidenceIds,
      allowedActions: ["buy", "negotiate", "pass", "needs_inspection"],
      primaryAction: verdictAction,
      candidates: ordered.map((item) => ({
        vin: item.vin,
        profitMidUsd: item.profitMidUsd,
        compCount: item.compCount,
        confidence: item.confidence,
      })),
    };
    try {
      const challenged = await runServ("resale_challenge", { user: JSON.stringify({ facts: challengeFacts }) }, {
        fetch: fetchImpl,
        timeoutMs: challengeTimeoutMs,
        apiKey: input.servKey,
        baseUrl: input.servBaseUrl,
        model: input.model,
      });
      ranDecide = true;
      const payload = challenged.ok ? parseJsonObject(challenged.text) : null;
      const agrees = payload?.agrees === true;
      const pickVin = typeof payload?.pickVin === "string" ? payload.pickVin : null;
      const action = typeof payload?.action === "string" ? payload.action : null;
      const objection = typeof payload?.objection === "string" ? payload.objection : null;
      const evidenceIds = Array.isArray(payload?.evidenceIds)
        ? (payload!.evidenceIds as unknown[]).filter((id): id is string => typeof id === "string")
        : [];
      const validation = validateResaleServOutput(
        { text: objection, vins: pickVin ? [pickVin] : [], evidenceIds },
        { ...bundle, numberFacts: challengeFacts },
      );
      const allow = new Set(ordered.map((item) => item.vin));
      if (challenged.ok && payload && validation.ok && pickVin && allow.has(pickVin)) {
        const prior = best.vin;
        if (!agrees) {
          best = ordered.find((item) => item.vin === pickVin) ?? best;
          if (action === "buy" || action === "negotiate" || action === "pass" || action === "needs_inspection") {
            verdictAction = action;
          }
          agentConfidence = agentConfidence === "high" ? "medium" : agentConfidence === "medium" ? "low" : "low";
          secondPass = {
            status: "disagreed",
            action: verdictAction,
            objection: objection ?? "Challenger revised the pick using allowlisted evidence.",
            evidenceIds,
            confidenceBefore: confidenceFromPnl(ordered.find((i) => i.vin === prior) ?? best),
            confidenceAfter: agentConfidence,
          };
          journal = appendJournalStep(journal, {
            kind: "challenge",
            actor: "SERV",
            decided: `Challenge revised pick to ${carLabel(best)} → ${verdictAction}`,
            why: objection ?? "Challenger disagreed with evidence-backed reasons.",
            inputsUsed: [`vin:${best.vin}`, ...evidenceIds],
            changed: prior !== best.vin ? `Changed pick from ${prior} to ${best.vin} because ${objection ?? "challenge"}` : `Revised action to ${verdictAction}`,
            model: modelFrom(challenged.proof, input.model),
            responseId: responseIdFrom(challenged.proof),
            recordedAt,
            rejected: null,
          });
        } else {
          secondPass = {
            status: "agreed",
            action: verdictAction,
            objection: null,
            evidenceIds,
            confidenceBefore: agentConfidence,
            confidenceAfter: agentConfidence,
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
        secondPass = {
          status: "ignored_malformed",
          action: null,
          objection: !validation.ok ? validation.detail : "Challenge payload ignored.",
          evidenceIds: [],
          confidenceBefore: agentConfidence,
          confidenceAfter: agentConfidence,
        };
        journal = appendJournalStep(journal, {
          kind: "fallback",
          actor: "SERV",
          decided: "Challenge rejected — first pick stands",
          why: !validation.ok ? validation.detail : "Challenge payload unusable.",
          inputsUsed: [`vin:${best.vin}`],
          changed: null,
          model: modelFrom(challenged.proof, input.model),
          responseId: responseIdFrom(challenged.proof),
          recordedAt,
          rejected: !validation.ok ? validation.reason : "rejected: unsupported reference",
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
    input.servKey?.trim() &&
    journal.servCalls < journal.servCallCap &&
    deadline &&
    (challengeTimeoutMs == null || !deadline.allow(RESALE_STAGE_BUDGET_MS.challenge)) &&
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

  // Optional shopper decide path for ComputedReport parity (counts toward cap when key present and budget remains).
  const shopperTimeoutDecide = deadline
    ? resaleCallTimeoutMs(profile("verdict_decide").timeoutMs, deadline)
    : profile("verdict_decide").timeoutMs;
  const shopperTimeoutChallenge = deadline
    ? resaleCallTimeoutMs(profile("verdict_challenge").timeoutMs, deadline)
    : profile("verdict_challenge").timeoutMs;
  if (
    input.servKey?.trim() &&
    journal.servCalls < journal.servCallCap &&
    (!deadline || deadline.allow(RESALE_STAGE_BUDGET_MS.shopper)) &&
    shopperTimeoutDecide != null
  ) {
    const report = buildFlipReport(best, input.budgetUsd);
    const shopper = await runShopperVerdictServ({
      report,
      mandate: { budgetUsd: input.budgetUsd, budgetKnown: true },
      servKey: input.servKey,
      servBaseUrl: input.servBaseUrl,
      model: input.model,
      fetchImpl,
      deadline,
      decideTimeoutMs: shopperTimeoutDecide,
      challengeTimeoutMs: shopperTimeoutChallenge,
    });
    if (shopper.trace) {
      ranDecide = true;
      trace = shopper.trace;
      journal = {
        ...journal,
        servCalls: Math.min(journal.servCallCap, journal.servCalls + shopper.trace.calls.length),
      };
      const action = shopper.decision.finalAction;
      if (action === "buy" || action === "negotiate" || action === "pass" || action === "needs_inspection") {
        verdictAction = action;
      }
      if (shopper.agentVerdict.confidence) agentConfidence = shopper.agentVerdict.confidence;
      if (shopper.agentVerdict.second_pass && shopper.agentVerdict.second_pass.status !== "not_run") {
        secondPass = shopper.agentVerdict.second_pass;
      }
      for (const call of shopper.trace.calls) {
        trail.push({
          decided: call.profile === "verdict_decide" ? `Verdict decide → ${verdictAction}` : `Verdict challenge → ${call.ok ? "ok" : "fail"}`,
          why: call.profile === "verdict_decide" ? shopper.decision.note ?? "Shopper decide on code report." : secondPass.objection ?? "Shopper challenge.",
          changed: null,
          model: call.model ?? input.model ?? null,
          responseId: call.responseId,
          recordedAt: shopper.trace.recordedAt,
        });
      }
    }
  } else if (
    input.servKey?.trim() &&
    journal.servCalls < journal.servCallCap &&
    deadline &&
    (shopperTimeoutDecide == null || !deadline.allow(RESALE_STAGE_BUDGET_MS.shopper))
  ) {
    journal = appendJournalStep(journal, {
      kind: "fallback",
      actor: "code",
      decided: `Shopper decide/challenge ${RESALE_TIME_BUDGET_SKIP}`,
      why: `Wall-clock budget remaining ${deadline.remainingMs()}ms — resale pick/challenge stand without shopper SERV.`,
      inputsUsed: [`vin:${best.vin}`],
      changed: null,
      model: null,
      responseId: null,
      recordedAt,
      rejected: null,
    });
  }

  ordered = sortByProfit(ranked.filter((item) => item.vin !== best.vin));
  const alternatives = ordered.slice(0, 4);
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
          text: profitHeadline(best),
        },
        { evidenceId: "comps", text: `${best.compCount} similar listings in this scan.` },
      ],
      risks: best.risks.slice(0, 4).map((text, i) => ({ evidenceId: `risk_${i}`, text })),
      unknowns: [
        ...(best.salesTaxKnown
          ? []
          : ["Sales tax unknown — profit shown before sales tax (state unknown); ranking applies a conservative tax haircut."]),
        "Title/registration dollar amount unknown.",
        ...(best.estimatedDaysToSell == null ? ["Days to sell unknown without listing age / DOM feed."] : []),
      ],
      serv_steps: trail,
      second_pass: secondPass,
      no_serv_step: !ranJudge && !ranDecide,
      serv_spend: {
        calls: journal.servCalls,
        costNote: `Resale SERV call cap ${journal.servCallCap}; recorded ${journal.servCalls}.`,
      },
    }),
  };

  return {
    best,
    alternatives,
    agentVerdict,
    journal,
    trace,
    verdictAction,
    confidence: confidenceLabel,
    ranJudge,
    ranDecide,
  };
}
