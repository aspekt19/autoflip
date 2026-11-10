/**
 * Shared shopper SERV path used by full reports (assemble) and Check:
 * ordered gates → verdict_decide → TS clamp → verdict_challenge.
 * Never invents a trail — callers build agentVerdict from this result only.
 */
import { buildAgentVerdictFromReport } from "@/domain/agent-trail";
import {
  moreConservativeConfidence,
  type AgentVerdict,
  type AgentVerdictConfidence,
} from "@/domain/agent-verdict-schema";
import type { DecisionAction } from "@/domain/decision-action";
import type { ComputedReport } from "@/domain/types";
import type { MandateInput } from "@/domain/verdict-gates";
import {
  resolveVerdictDecision,
  verdictDecisionFacts,
  type VerdictDecisionRecord,
} from "@/domain/verdict-decide";
import {
  resaleCallTimeoutMs,
  RESALE_TIME_BUDGET_SKIP,
  type ResaleDeadline,
} from "@/domain/resale-deadline";
import { collectReportEvidenceIds, runReportVerdictChallenge } from "@/server/agent-second-pass";
import { profile, runServ, type ServProof } from "@/server/serv";

/** Format OpenServ usage for the trail spend line. Never invent a dollar amount. */
function usageSpendNote(proofs: Array<ServProof | null>): string | null {
  const bits: string[] = [];
  let prompt = 0;
  let completion = 0;
  let total = 0;
  let costUsd: number | null = null;
  let sawUsage = false;
  for (const proof of proofs) {
    const usage = proof?.openserv?.usage;
    if (!usage || typeof usage !== "object") continue;
    sawUsage = true;
    const row = usage as Record<string, unknown>;
    const p = Number(row.prompt_tokens ?? row.promptTokens ?? 0);
    const c = Number(row.completion_tokens ?? row.completionTokens ?? 0);
    const t = Number(row.total_tokens ?? row.totalTokens ?? p + c);
    if (Number.isFinite(p)) prompt += p;
    if (Number.isFinite(c)) completion += c;
    if (Number.isFinite(t)) total += t;
    const cost = row.cost ?? row.cost_usd ?? row.total_cost;
    if (typeof cost === "number" && Number.isFinite(cost)) {
      costUsd = (costUsd ?? 0) + cost;
    }
  }
  if (!sawUsage) return null;
  if (costUsd != null) bits.push(`$${costUsd.toFixed(4)} from response usage`);
  if (total > 0) bits.push(`${total} tokens (${prompt} in / ${completion} out)`);
  return bits.length ? bits.join(" · ") : null;
}

export type ShopperServTraceCall = {
  profile: "verdict_decide" | "verdict_challenge";
  ok: boolean;
  model: string | null;
  responseId: string | null;
  rawResponse: string | null;
  latencyMs: number | null;
  error: string | null;
};

export type ShopperServTrace = {
  recordedAt: string;
  model: string | null;
  calls: ShopperServTraceCall[];
};

export type ShopperVerdictServResult = {
  decision: VerdictDecisionRecord;
  agentVerdict: AgentVerdict;
  decideProof: ServProof | null;
  challengeProof: ServProof | null;
  /** Present when any SERV HTTP was attempted; null when skipped (no key / withheld). */
  trace: ShopperServTrace | null;
  steps: Array<{ id: string; status: string; detail?: string }>;
};

function responseIdFrom(proof: ServProof | null): string | null {
  const id = proof?.openserv?.id;
  return typeof id === "string" && id.trim() ? id : null;
}

function traceCall(
  profile: ShopperServTraceCall["profile"],
  input: {
    ok: boolean;
    model: string | null;
    proof: ServProof | null;
    raw: string | null;
    error: string | null;
  },
): ShopperServTraceCall {
  return {
    profile,
    ok: input.ok,
    model: input.model,
    responseId: responseIdFrom(input.proof),
    rawResponse: input.raw,
    latencyMs: input.proof?.latencyMs ?? null,
    error: input.error,
  };
}

/**
 * Run the production shopper decide + challenge sequence against a ComputedReport.
 */
export async function runShopperVerdictServ(input: {
  report: ComputedReport;
  mandate?: MandateInput;
  userLookup?: string;
  servKey?: string;
  servBaseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  /**
   * Screening confidence from Check/report code (High/Medium/Low mapped to agent).
   * Trail confidence never exceeds this — SERV agreement must not flip Low → High.
   */
  screeningConfidence?: AgentVerdictConfidence | null;
  /**
   * SERV transport for decide + challenge.
   * Production Check uses production (empty/timeout retry on challenge).
   * Unit tests inject experiment_single_attempt so unlisted models and single-shot mocks work.
   */
  transportPolicy?: "production" | "experiment_single_attempt";
  /** Optional wall-clock deadline (Resale path) — challenge is re-clamped after decide. */
  deadline?: ResaleDeadline;
  /** Explicit decide timeout (already clamped to remaining budget by caller). */
  decideTimeoutMs?: number | null;
  /**
   * Optional pre-clamped challenge timeout. When `deadline` is set, challenge is
   * re-clamped to `deadline.remainingMs()` immediately before the call instead.
   */
  challengeTimeoutMs?: number | null;
}): Promise<ShopperVerdictServResult> {
  const mandate = input.mandate ?? {};
  const fetchImpl = input.fetchImpl ?? fetch;
  const model = input.model ?? null;
  const transportPolicy = input.transportPolicy ?? "production";
  const recordedAt = new Date().toISOString();
  const steps: ShopperVerdictServResult["steps"] = [];
  const callTraces: ShopperServTraceCall[] = [];

  const previewDecision = resolveVerdictDecision({
    report: input.report,
    servText: null,
    servOk: false,
    hasServKey: false,
    mandate,
  });
  steps.push({
    id: "ordered_gates",
    status: previewDecision.gateRun.withheld ? "withheld" : "passed",
    detail: previewDecision.gateRun.gates.map((gate) => `${gate.id}:${gate.status}`).join(", "),
  });

  let verdictServText: string | null = null;
  let verdictServOk = false;
  let decideProof: ServProof | null = null;

  if (previewDecision.gateRun.withheld) {
    steps.push({
      id: "serv_verdict_decide",
      status: "skipped_withheld",
      detail: previewDecision.withholdReason ?? "Verdict withheld by ordered gates.",
    });
  } else if (input.servKey && input.decideTimeoutMs !== null) {
    const decisionFacts = verdictDecisionFacts(input.report, mandate);
    const judged = await runServ(
      "verdict_decide",
      {
        user: JSON.stringify({
          facts: decisionFacts,
          userLookup: input.userLookup ?? null,
        }),
      },
      {
        fetch: fetchImpl,
        apiKey: input.servKey,
        baseUrl: input.servBaseUrl,
        model: input.model,
        transportPolicy,
        ...(typeof input.decideTimeoutMs === "number" ? { timeoutMs: input.decideTimeoutMs } : {}),
      },
    );
    decideProof = judged.proof;
    verdictServOk = judged.ok;
    verdictServText = judged.ok ? judged.text : null;
    callTraces.push(
      traceCall("verdict_decide", {
        ok: judged.ok,
        model: judged.ok ? judged.model : model,
        proof: judged.proof,
        raw: judged.ok ? judged.text : null,
        error: judged.ok ? null : judged.error,
      }),
    );
    steps.push({
      id: "serv_verdict_decide",
      status: judged.ok ? "ok" : "fallback",
      detail: judged.ok ? judged.shadowOutcome : judged.error,
    });
  } else if (input.servKey && input.decideTimeoutMs === null) {
    steps.push({
      id: "serv_verdict_decide",
      status: "skipped_time_budget",
      detail: "not run (time budget)",
    });
  } else {
    steps.push({ id: "serv_verdict_decide", status: "skipped_no_key" });
  }

  const decision = previewDecision.gateRun.withheld
    ? previewDecision
    : resolveVerdictDecision({
        report: input.report,
        servText: verdictServText,
        servOk: verdictServOk,
        hasServKey: Boolean(input.servKey),
        mandate,
      });

  steps.push({
    id: "verdict_guardrails",
    status: decision.gateRun.withheld
      ? "withheld"
      : decision.overrideReasons.length > 0
        ? "overrode"
        : "passed",
    detail:
      decision.overrideReasons.slice(0, 3).join(" | ") ||
      `final=${decision.finalAction}; source=${decision.source}`,
  });

  let challengeProof: ServProof | null = null;
  const primaryForChallenge: Exclude<DecisionAction, "withheld"> | null =
    decision.finalAction === "withheld" ? null : (decision.finalAction as Exclude<DecisionAction, "withheld">);
  const challengeConfidence: AgentVerdictConfidence =
    decision.source === "serv" && decision.overrideReasons.length === 0 ? "high" : "medium";

  // Re-clamp after decide — remaining budget may be below challenge's useful minimum.
  const challengeTimeoutMs = input.deadline
    ? resaleCallTimeoutMs(profile("verdict_challenge").timeoutMs, input.deadline)
    : input.challengeTimeoutMs === undefined
      ? profile("verdict_challenge").timeoutMs
      : input.challengeTimeoutMs;
  const challengeBudgetSkipped = challengeTimeoutMs === null;
  const challengeSkipped = decision.gateRun.withheld || !decision.servChoice || challengeBudgetSkipped;
  if (challengeBudgetSkipped) {
    steps.push({
      id: "serv_verdict_challenge",
      status: "skipped_time_budget",
      detail: RESALE_TIME_BUDGET_SKIP,
    });
  }
  const challenge = challengeSkipped
    ? {
        result: {
          status: "not_run" as const,
          action: null,
          objection: challengeBudgetSkipped ? RESALE_TIME_BUDGET_SKIP : null,
          evidenceIds: [] as string[],
          confidenceBefore: null,
          confidenceAfter: null,
        },
        proof: null as ServProof | null,
        rawText: null as string | null,
      }
    : await runReportVerdictChallenge({
        report: input.report,
        primaryAction: primaryForChallenge,
        confidence: challengeConfidence,
        allowedActions: decision.allowedActions.filter(
          (action): action is Exclude<DecisionAction, "withheld"> => action !== "withheld",
        ),
        hasBudget: true,
        servKey: input.servKey,
        servBaseUrl: input.servBaseUrl,
        model: input.model,
        fetchImpl,
        transportPolicy,
        ...(typeof challengeTimeoutMs === "number" ? { timeoutMs: challengeTimeoutMs } : {}),
      });
  challengeProof = challenge.proof;

  if (challenge.proof || challenge.rawText || challenge.result.status === "unavailable") {
    callTraces.push(
      traceCall("verdict_challenge", {
        ok: challenge.result.status === "agreed" || challenge.result.status === "disagreed",
        model: challenge.proof?.modelReported ?? model,
        proof: challenge.proof,
        raw: challenge.rawText,
        error:
          challenge.result.status === "unavailable"
            ? challenge.result.objection
            : challenge.result.status.startsWith("ignored")
              ? challenge.result.status
              : null,
      }),
    );
  }

  if (challenge.result.status === "not_run") {
    // withheld — no second call
  } else if (challenge.result.status === "unavailable") {
    steps.push({
      id: "serv_verdict_challenge",
      status: "unavailable",
      detail: challenge.result.objection ?? "Second check did not finish.",
    });
  } else if (challenge.result.status === "skipped_no_budget" || challenge.result.status === "skipped_no_key") {
    steps.push({
      id: "serv_verdict_challenge",
      status: "skipped",
      detail: challenge.result.objection ?? challenge.result.status,
    });
  } else if (challenge.result.status === "ignored_malformed" || challenge.result.status === "ignored_no_evidence") {
    steps.push({
      id: "serv_verdict_challenge",
      status: "ignored",
      detail: challenge.result.status,
    });
  } else {
    steps.push({
      id: "serv_verdict_challenge",
      status: challenge.result.status,
      detail: challenge.result.objection ?? challenge.result.action ?? undefined,
    });
  }

  const evidencePack = collectReportEvidenceIds(input.report);
  const agentReasons = input.report.reasons.slice(0, 4).map((text, index) => ({
    evidenceId: `ev_reason_${index}`,
    text,
  }));
  const agentRisks = input.report.flags
    .filter((flag) => flag.level === "stop" || flag.level === "caution")
    .slice(0, 4)
    .map((flag, index) => ({
      evidenceId: `ev_flag_${index}`,
      text: flag.text,
    }));

  const hadServStep = Boolean(verdictServOk && decision.servChoice);
  const servFailed = Boolean(input.servKey) && !decision.gateRun.withheld && !hadServStep;
  const recordedModel =
    callTraces.find((call) => call.model)?.model ?? (model && callTraces.length > 0 ? model : null);
  const usageNote = usageSpendNote([decideProof, challengeProof]);
  const costBits: string[] = [];
  if (recordedModel) costBits.push(recordedModel);
  if (callTraces.length > 0) costBits.push(recordedAt);
  if (usageNote) costBits.push(usageNote);
  if (servFailed) costBits.push("Agent step unavailable — price rules only");

  const decideResponseId =
    typeof decideProof?.openserv?.id === "string" && decideProof.openserv.id.trim()
      ? decideProof.openserv.id.trim()
      : null;
  const challengeResponseId =
    typeof challengeProof?.openserv?.id === "string" && challengeProof.openserv.id.trim()
      ? challengeProof.openserv.id.trim()
      : null;
  const recordedSteps = hadServStep
    ? [
        {
          decided: `Lemonless AI chose ${decision.finalAction}.`,
          why: decision.note?.trim() || "The agent reviewed code-computed facts under hard gates.",
          changed:
            decision.servChoice && decision.servChoice !== decision.finalAction
              ? `Model returned ${decision.servChoice}; gates kept ${decision.finalAction}.`
              : null,
          model: decideProof?.modelReported ?? recordedModel,
          responseId: decideResponseId,
          recordedAt,
        },
        ...(challenge.result.status !== "not_run"
          ? [
              {
                decided:
                  challenge.result.status === "agreed"
                    ? "Second check agreed with the verdict."
                    : challenge.result.status === "disagreed"
                      ? `Second check disagreed${
                          challenge.result.action
                            ? ` (would ${challenge.result.action === "needs_inspection" ? "needs inspection" : challenge.result.action})`
                            : ""
                        }.`
                      : `Second check: ${challenge.result.status}.`,
                why: challenge.result.objection?.trim() || "Independent review of the same evidence.",
                changed:
                  challenge.result.confidenceBefore &&
                  challenge.result.confidenceAfter &&
                  challenge.result.confidenceBefore !== challenge.result.confidenceAfter
                    ? `Confidence lowered from ${challenge.result.confidenceBefore} to ${challenge.result.confidenceAfter}.`
                    : null,
                model: challengeProof?.modelReported ?? recordedModel,
                responseId: challengeResponseId,
                recordedAt,
              },
            ]
          : []),
      ]
    : [];

  const agentOnlyConfidence =
    challenge.result.confidenceAfter ??
    (decision.gateRun.withheld ? null : challengeConfidence);
  // Single source of truth with Check screening: never show trail High when screening is Low.
  const syncedConfidence = moreConservativeConfidence(input.screeningConfidence, agentOnlyConfidence);

  let agentVerdict = buildAgentVerdictFromReport({
    verdict: decision.finalAction,
    confidence: syncedConfidence,
    reasons: agentReasons.filter((row) => evidencePack.ids.has(row.evidenceId)),
    risks: agentRisks.filter((row) => evidencePack.ids.has(row.evidenceId)),
    unknowns: input.report.dataNotes.slice(0, 4),
    primaryNote: decision.note,
    primarySource: hadServStep ? decision.source : "deterministic_fallback",
    secondPass: hadServStep ? challenge.result : { status: "not_run", action: null, objection: null, evidenceIds: [], confidenceBefore: null, confidenceAfter: null },
    servCalls: callTraces.length,
    costNote: costBits.length ? costBits.join(" · ") : null,
    hadServStep,
  });
  agentVerdict = { ...agentVerdict, serv_steps: recordedSteps };

  if (servFailed) {
    agentVerdict = {
      ...agentVerdict,
      no_serv_step: true,
      verdict: null,
      confidence: null,
      serv_steps: [],
      second_pass: {
        status: "not_run",
        action: null,
        objection: null,
        evidenceIds: [],
        confidenceBefore: null,
        confidenceAfter: null,
      },
      unknowns: ["Agent step unavailable — price rules only"],
      serv_spend: {
        calls: callTraces.length,
        costNote: costBits.join(" · "),
      },
    };
  }

  return {
    decision,
    agentVerdict,
    decideProof,
    challengeProof,
    trace: callTraces.length > 0 ? { recordedAt, model: recordedModel, calls: callTraces } : null,
    steps,
  };
}
