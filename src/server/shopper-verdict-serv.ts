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
import {
  isServDecisionAction,
  verdictFromAction,
  type DecisionAction,
} from "@/domain/decision-action";
import type { ComputedReport } from "@/domain/types";
import type { MandateInput } from "@/domain/verdict-gates";
import {
  resolveVerdictDecision,
  verdictDecisionFacts,
  type VerdictDecisionRecord,
  decideWhyWithGateResult,
} from "@/domain/verdict-decide";
import { clampDecision } from "@/domain/verdict-guardrails";
import {
  resaleCallTimeoutMs,
  RESALE_TIME_BUDGET_SKIP,
  type ResaleDeadline,
} from "@/domain/resale-deadline";
import {
  buildDecisionProofRecord,
  clampFromDecision,
  VERDICT_RUBRIC_ID,
  type DecisionProofRecord,
} from "@/domain/decision-proof-record";
import { providerResponseIdFromCall } from "@/domain/serv-response-id";
import { collectReportEvidenceIds, runReportVerdictChallenge } from "@/server/agent-second-pass";
import { chatCompletionContent, profile, runServ, type ServProof } from "@/server/serv";

/** Prefer chat-completions message content for trail rawResponse (not output_text). */
function rawResponseFromProof(proof: ServProof | null, fallbackText: string | null): string | null {
  const fromChoices = chatCompletionContent(proof?.openserv);
  if (fromChoices) return fromChoices;
  if (fallbackText?.trim()) return fallbackText.trim();
  return null;
}

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
  /** One proof record per decide/challenge (or honest skip). */
  proofRecords: DecisionProofRecord[];
};

function responseIdFrom(proof: ServProof | null, ok: boolean): string | null {
  return providerResponseIdFromCall({
    ok,
    id: typeof proof?.openserv?.id === "string" ? proof.openserv.id : null,
  });
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
    responseId: responseIdFrom(input.proof, input.ok),
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
  /**
   * Remaining SERV HTTP slots for this shopper sequence (decide + challenge).
   * When 1, decide may run and challenge is skipped for call cap.
   * When 0, decide is skipped for call cap (caller usually journals first).
   */
  maxAdditionalServCalls?: number;
  /**
   * Resale only. Call gpt-6.1-sol with no feature suffix and no prompt-guard or shadow tool.
   * Those extras made the live review return no usable JSON, and code then published High confidence.
   */
  bareModel?: boolean;
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
  const remainingCalls =
    typeof input.maxAdditionalServCalls === "number"
      ? Math.max(0, Math.floor(input.maxAdditionalServCalls))
      : Number.POSITIVE_INFINITY;
  const decideCapSkipped = remainingCalls < 1;

  if (previewDecision.gateRun.withheld) {
    steps.push({
      id: "serv_verdict_decide",
      status: "skipped_withheld",
      detail: previewDecision.withholdReason ?? "Verdict withheld by ordered gates.",
    });
  } else if (decideCapSkipped) {
    steps.push({
      id: "serv_verdict_decide",
      status: "skipped_call_cap",
      detail: "call cap reached",
    });
  } else if (input.servKey && input.decideTimeoutMs !== null) {
    const decisionFacts = verdictDecisionFacts(input.report, mandate);
    const decideDeps = {
      fetch: fetchImpl,
      apiKey: input.servKey,
      baseUrl: input.servBaseUrl,
      model: input.model,
      transportPolicy,
      ...(input.bareModel ? { bareRetry: true, disableFeatureSuffix: true } : {}),
      ...(typeof input.decideTimeoutMs === "number" ? { timeoutMs: input.decideTimeoutMs } : {}),
    };
    const decideUser = {
      user: JSON.stringify({
        facts: decisionFacts,
        userLookup: input.userLookup ?? null,
      }),
    };
    let judged = await runServ("verdict_decide", decideUser, decideDeps);
    // Null-content refusal: one honest retry when a slot remains (never invent a verdict).
    const firstError = judged.ok ? null : judged.error;
    const nullContentRefusal =
      !judged.ok &&
      (judged.failureDiag?.reasonCode === "message_content_null_refusal_field" ||
        judged.failureDiag?.reasonCode === "message_refusal_field_empty_content" ||
        /message_content_null_refusal_field|structured refusal/i.test(firstError ?? ""));
    if (nullContentRefusal && remainingCalls >= 2) {
      callTraces.push(
        traceCall("verdict_decide", {
          ok: false,
          model: judged.proof?.modelReported ?? judged.proof?.modelRequested ?? model,
          proof: judged.proof,
          raw: rawResponseFromProof(judged.proof, null),
          error: firstError,
        }),
      );
      steps.push({
        id: "serv_verdict_decide",
        status: "retry",
        detail: `Null-content refusal (${judged.failureDiag?.reasonCode ?? "message_content_null_refusal_field"}) — retrying once.`,
      });
      judged = await runServ(
        "verdict_decide",
        {
          user: JSON.stringify({
            facts: decisionFacts,
            userLookup: input.userLookup ?? null,
            previousRejection:
              "Previous response had null content with a refusal field. Return schema JSON only.",
          }),
        },
        decideDeps,
      );
    }
    decideProof = judged.proof;
    verdictServOk = judged.ok;
    verdictServText = judged.ok ? judged.text : null;
    const failHonesty = judged.ok
      ? null
      : judged.failureDiag?.honesty || judged.failureDiag?.reasonCode || judged.error || null;
    callTraces.push(
      traceCall("verdict_decide", {
        ok: judged.ok,
        model: judged.proof?.modelReported ?? judged.proof?.modelRequested ?? (judged.ok ? judged.model : model),
        proof: judged.proof,
        raw: rawResponseFromProof(judged.proof, judged.ok ? judged.text : null),
        error: judged.ok ? null : failHonesty,
      }),
    );
    steps.push({
      id: "serv_verdict_decide",
      status: judged.ok ? "ok" : "failed",
      detail: judged.ok ? judged.shadowOutcome : failHonesty ?? "SERV did not finish",
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

  let decision: VerdictDecisionRecord = previewDecision.gateRun.withheld
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
  // Decide consumed one slot when an HTTP call was attempted.
  const challengeCapSkipped =
    Number.isFinite(remainingCalls) && callTraces.length >= remainingCalls;
  let challengeSkipStatus: string | null = null;
  let challengeSkipDetail: string | null = null;
  if (challengeBudgetSkipped) {
    challengeSkipStatus = "skipped_time_budget";
    challengeSkipDetail = RESALE_TIME_BUDGET_SKIP;
  } else if (decision.gateRun.withheld) {
    challengeSkipStatus = "skipped_withheld";
    challengeSkipDetail =
      decision.withholdReason ?? "Verdict withheld by ordered gates — challenge not run.";
  } else if (decideCapSkipped) {
    challengeSkipStatus = "skipped_call_cap";
    challengeSkipDetail = "call cap reached before decide";
  } else if (challengeCapSkipped) {
    challengeSkipStatus = "skipped_call_cap";
    challengeSkipDetail = "call cap reached after decide";
  } else if (!decision.servChoice) {
    challengeSkipStatus = "skipped_no_choice";
    challengeSkipDetail = "Decide returned no usable choice — challenge not run.";
  }
  const challengeSkipped = challengeSkipStatus != null;
  if (challengeSkipStatus) {
    steps.push({
      id: "serv_verdict_challenge",
      status: challengeSkipStatus,
      detail: challengeSkipDetail ?? challengeSkipStatus,
    });
  }
  const challenge = challengeSkipped
    ? {
        result: {
          status: "not_run" as const,
          action: null,
          objection: challengeSkipDetail,
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
        bareModel: input.bareModel === true,
      });
  challengeProof = challenge.proof;

  if (challenge.proof || challenge.rawText || challenge.result.status === "unavailable") {
    callTraces.push(
      traceCall("verdict_challenge", {
        ok: challenge.result.status === "agreed" || challenge.result.status === "disagreed",
        model: challenge.proof?.modelReported ?? model,
        proof: challenge.proof,
        raw: rawResponseFromProof(challenge.proof, challenge.rawText),
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

  // Snapshot decide outcome before challenge may revise the final action.
  const decideDecision: VerdictDecisionRecord = decision;
  const decideRaw =
    callTraces.find((call) => call.profile === "verdict_decide")?.rawResponse?.trim() || null;
  const challengeRaw =
    callTraces.find((call) => call.profile === "verdict_challenge")?.rawResponse?.trim() || null;

  // Line 3: challenge disagreement with a valid reason + allowlisted action becomes
  // the final action under the same guardrails (code ranking/decide is input, not final word).
  let challengePriorAction: DecisionAction | null = null;
  if (
    challenge.result.status === "disagreed" &&
    challenge.result.action &&
    isServDecisionAction(challenge.result.action) &&
    !decision.gateRun.withheld &&
    decision.allowedActions.includes(challenge.result.action)
  ) {
    challengePriorAction = decision.finalAction;
    const clamped = clampDecision(challenge.result.action, decision.guardrails);
    decision = {
      ...decision,
      servChoice: challenge.result.action,
      finalAction: clamped.finalAction,
      finalVerdict: verdictFromAction(clamped.finalAction, input.report.verdict),
      source: clamped.overridden ? "guardrail_clamp" : "serv",
      overrideReasons: clamped.overrideReasons,
      note: challenge.result.objection?.trim() || decision.note,
    };
    if (clamped.overrideReasons.length > 0) {
      steps.push({
        id: "verdict_guardrails",
        status: "overrode",
        detail: clamped.overrideReasons.slice(0, 3).join(" | "),
      });
    }
  }

  const hadServStep = Boolean(verdictServOk && decideDecision.servChoice);
  const servFailed = Boolean(input.servKey) && !decision.gateRun.withheld && !hadServStep;
  const recordedModel =
    callTraces.find((call) => call.model)?.model ?? (model && callTraces.length > 0 ? model : null);
  const usageNote = usageSpendNote([decideProof, challengeProof]);
  const costBits: string[] = [];
  if (recordedModel) costBits.push(recordedModel);
  if (callTraces.length > 0) costBits.push(recordedAt);
  if (usageNote) costBits.push(usageNote);
  if (servFailed) {
    const failWhy =
      callTraces.find((call) => call.error)?.error?.trim() ||
      steps.find((step) => step.id === "serv_verdict_decide" && step.status !== "ok")?.detail ||
      "SERV did not finish";
    costBits.push(`Agent step failed: ${failWhy}`);
  }

  const decideResponseId = responseIdFrom(decideProof, verdictServOk);
  const challengeOk =
    challenge.result.status === "agreed" || challenge.result.status === "disagreed";
  const challengeResponseId = responseIdFrom(challengeProof, challengeOk);
  const decideFacts = verdictDecisionFacts(input.report, mandate);
  const proofRecords: DecisionProofRecord[] = [];

  if (previewDecision.gateRun.withheld) {
    proofRecords.push(
      buildDecisionProofRecord({
        purpose: "verdict_decide",
        rubricId: VERDICT_RUBRIC_ID,
        status: "skipped_withheld",
        model: recordedModel,
        recordedAt,
        inputs: decideFacts,
        detail: previewDecision.withholdReason ?? "Verdict withheld by ordered gates.",
      }),
    );
  } else if (decideCapSkipped) {
    proofRecords.push(
      buildDecisionProofRecord({
        purpose: "verdict_decide",
        rubricId: VERDICT_RUBRIC_ID,
        status: "skipped_call_cap",
        model: recordedModel,
        recordedAt,
        inputs: decideFacts,
        detail: "call cap reached",
      }),
    );
  } else if (!input.servKey) {
    proofRecords.push(
      buildDecisionProofRecord({
        purpose: "verdict_decide",
        rubricId: VERDICT_RUBRIC_ID,
        status: "skipped_no_key",
        recordedAt,
        inputs: decideFacts,
        detail: "SERV_API_KEY is not configured on this deployment.",
      }),
    );
  } else if (servFailed) {
    const failCall = callTraces.find((call) => call.profile === "verdict_decide" && call.error);
    const failWhy = failCall?.error?.trim() || "SERV did not finish";
    proofRecords.push(
      buildDecisionProofRecord({
        purpose: "verdict_decide",
        rubricId: VERDICT_RUBRIC_ID,
        status: "failed",
        model: failCall?.model ?? decideProof?.modelReported ?? recordedModel,
        recordedAt,
        inputs: decideFacts,
        detail: failWhy,
        rawResponse: failCall?.rawResponse ?? decideRaw,
      }),
    );
  } else if (hadServStep) {
    proofRecords.push(
      buildDecisionProofRecord({
        purpose: "verdict_decide",
        rubricId: VERDICT_RUBRIC_ID,
        status: "ok",
        responseId: decideResponseId,
        model: decideProof?.modelReported ?? recordedModel,
        recordedAt,
        inputs: decideFacts,
        verdict: decideDecision.finalAction,
        clamp: clampFromDecision({
          servChoice: decideDecision.servChoice,
          finalAction: decideDecision.finalAction,
          overrideReasons: decideDecision.overrideReasons,
        }),
        detail: decideDecision.note,
        rawResponse: decideRaw,
      }),
    );
  }

  if (hadServStep && challenge.result.status !== "not_run") {
    const challengeStatus =
      challenge.result.status === "agreed" || challenge.result.status === "disagreed"
        ? ("ok" as const)
        : challenge.result.status === "unavailable"
          ? ("error" as const)
          : ("unknown" as const);
    const challengeClamp =
      challengePriorAction != null
        ? clampFromDecision({
            servChoice: challenge.result.action,
            finalAction: decision.finalAction,
            overrideReasons: decision.overrideReasons,
          })
        : null;
    proofRecords.push(
      buildDecisionProofRecord({
        purpose: "verdict_challenge",
        rubricId: VERDICT_RUBRIC_ID,
        status: challengeStatus,
        responseId: challengeResponseId,
        model: challengeProof?.modelReported ?? recordedModel,
        recordedAt,
        inputs: {
          primaryAction: decideDecision.finalAction,
          evidenceIds: challenge.result.evidenceIds,
        },
        verdict:
          challengeStatus === "ok"
            ? decision.finalAction !== "withheld"
              ? decision.finalAction
              : challenge.result.action ?? challenge.result.status
            : null,
        clamp: challengeClamp,
        detail: challenge.result.objection,
        rawResponse: challengeRaw,
      }),
    );
  }

  const recordedSteps = hadServStep
    ? [
        {
          decided: `Lemonless AI chose ${decideDecision.finalAction}.`,
          why: decideWhyWithGateResult(
            decideDecision,
            "The agent reviewed code-computed facts under hard gates.",
          ),
          changed:
            decideDecision.servChoice && decideDecision.servChoice !== decideDecision.finalAction
              ? `Model returned ${decideDecision.servChoice}; gates kept ${decideDecision.finalAction}.`
              : null,
          model: decideProof?.modelReported ?? recordedModel,
          responseId: decideResponseId,
          recordedAt,
          rawResponse: decideRaw,
        },
        ...(challenge.result.status !== "not_run"
          ? [
              {
                decided:
                  challenge.result.status === "agreed"
                    ? "Second check agreed with the verdict."
                    : challenge.result.status === "disagreed"
                      ? challengePriorAction != null
                        ? `Second check changed the verdict to ${decision.finalAction}.`
                        : `Second check disagreed${
                            challenge.result.action
                              ? ` (wanted ${challenge.result.action === "needs_inspection" ? "needs inspection" : challenge.result.action})`
                              : ""
                          }.`
                      : `Second check: ${challenge.result.status}.`,
                why: challenge.result.objection?.trim() || "Independent review of the same evidence.",
                changed: (() => {
                  const bits: string[] = [];
                  if (
                    challengePriorAction != null &&
                    challengePriorAction !== decision.finalAction
                  ) {
                    bits.push(`Changed from ${challengePriorAction} to ${decision.finalAction}.`);
                  } else if (
                    challengePriorAction != null &&
                    challenge.result.action &&
                    challenge.result.action !== decision.finalAction
                  ) {
                    bits.push(
                      `Second check chose ${challenge.result.action}; gates kept ${decision.finalAction}.`,
                    );
                  }
                  if (
                    challenge.result.confidenceBefore &&
                    challenge.result.confidenceAfter &&
                    challenge.result.confidenceBefore !== challenge.result.confidenceAfter
                  ) {
                    bits.push(
                      `Confidence lowered from ${challenge.result.confidenceBefore} to ${challenge.result.confidenceAfter}.`,
                    );
                  }
                  return bits.length ? bits.join(" ") : null;
                })(),
                model: challengeProof?.modelReported ?? recordedModel,
                responseId: challengeResponseId,
                recordedAt,
                rawResponse: challengeRaw,
              },
            ]
          : []),
      ]
    : servFailed
      ? [
          {
            decided: "Agent step failed.",
            why:
              callTraces.find((call) => call.error)?.error?.trim() ||
              "SERV did not finish. No tidy fallback verdict was invented.",
            changed: null,
            model: recordedModel,
            responseId: null,
            recordedAt,
          },
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
  // secondPass.confidenceAfter must not re-inflate past screening/synced confidence
  // (e.g. stop-level flags already lowered screening High → Medium).
  agentVerdict = {
    ...agentVerdict,
    confidence: syncedConfidence,
    serv_steps: recordedSteps,
  };

  if (servFailed) {
    // Principle 3: keep the real error on the trail; never invent a tidy fallback verdict.
    const failWhy =
      callTraces.find((call) => call.error)?.error?.trim() || "SERV did not finish";
    agentVerdict = {
      ...agentVerdict,
      no_serv_step: false,
      verdict: null,
      confidence: null,
      second_pass: {
        status: "not_run",
        action: null,
        objection: failWhy,
        evidenceIds: [],
        confidenceBefore: null,
        confidenceAfter: null,
      },
      unknowns: [`Agent step failed: ${failWhy}`, "unknown"],
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
    proofRecords,
  };
}
