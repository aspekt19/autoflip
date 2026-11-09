/**
 * Shared shopper SERV path used by full reports (assemble) and Check:
 * ordered gates → verdict_decide → TS clamp → verdict_challenge.
 * Never invents a trail — callers build agentVerdict from this result only.
 */
import { buildAgentVerdictFromReport } from "@/domain/agent-trail";
import type { AgentVerdict, AgentVerdictConfidence } from "@/domain/agent-verdict-schema";
import type { DecisionAction } from "@/domain/decision-action";
import type { ComputedReport } from "@/domain/types";
import type { MandateInput } from "@/domain/verdict-gates";
import {
  resolveVerdictDecision,
  verdictDecisionFacts,
  type VerdictDecisionRecord,
} from "@/domain/verdict-decide";
import { collectReportEvidenceIds, runReportVerdictChallenge } from "@/server/agent-second-pass";
import { runServ, type ServProof } from "@/server/serv";

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
}): Promise<ShopperVerdictServResult> {
  const mandate = input.mandate ?? {};
  const fetchImpl = input.fetchImpl ?? fetch;
  const model = input.model ?? null;
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
  } else if (input.servKey) {
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
        transportPolicy: "experiment_single_attempt",
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

  const challengeSkipped = decision.gateRun.withheld || !decision.servChoice;
  const challenge = challengeSkipped
    ? {
        result: {
          status: "not_run" as const,
          action: null,
          objection: null,
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
        transportPolicy: "experiment_single_attempt",
      });
  challengeProof = challenge.proof;

  if (challenge.proof || challenge.rawText) {
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
  const costBits: string[] = [];
  if (recordedModel) costBits.push(recordedModel);
  if (callTraces.length > 0) costBits.push(recordedAt);
  if (servFailed) costBits.push("Agent step unavailable — price rules only");

  const recordedSteps = hadServStep
    ? [
        ...(decision.note
          ? [
              {
                decided: decision.finalAction,
                why: decision.note,
                changed:
                  decision.servChoice && decision.servChoice !== decision.finalAction
                    ? `Model returned ${decision.servChoice}; gates kept ${decision.finalAction}.`
                    : null,
              },
            ]
          : []),
        ...(challenge.rawText
          ? [
              {
                decided: challenge.result.status,
                why: challenge.result.objection ?? challenge.rawText,
                changed: null,
              },
            ]
          : []),
      ]
    : [];

  let agentVerdict = buildAgentVerdictFromReport({
    verdict: decision.finalAction,
    confidence:
      challenge.result.confidenceAfter ??
      (decision.gateRun.withheld ? null : challengeConfidence),
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
