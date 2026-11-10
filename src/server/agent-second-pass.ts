/**
 * Run the independent verdict_challenge SERV profile and apply domain rules.
 * Counts as one paid SERV call. Skips cleanly when no key or caller says no budget.
 */

import { applyAgentSecondPass } from "@/domain/agent-second-pass";
import type { AgentSecondPassResult, AgentVerdictConfidence } from "@/domain/agent-verdict-schema";
import type { DecisionAction } from "@/domain/decision-action";
import type { ComputedReport } from "@/domain/types";
import { runServ, type ServDeps, type ServProof } from "@/server/serv";

export function collectReportEvidenceIds(report: ComputedReport): {
  ids: Set<string>;
  facts: Array<{ id: string; text: string }>;
} {
  const facts: Array<{ id: string; text: string }> = [];
  const push = (id: string, text: string) => {
    facts.push({ id, text });
  };
  if (report.fairValueUsd != null) {
    push("ev_fair_value", `Fair value from similar listings: ${report.fairValueUsd}.`);
  } else {
    push("ev_fair_value_missing", "Not enough similar cars for a fair value.");
  }
  if (report.priceGap != null) {
    push("ev_price_gap", `Asking price gap versus fair value: ${report.priceGap}.`);
  }
  push("ev_comp_count", `Similar listing count: ${report.comps.length}.`);
  if (report.openParkIt) {
    push("ev_recall_park_it", "An NHTSA park-it campaign exists for this year/make/model.");
  }
  if (report.recallsAvailable) {
    push("ev_recall_count", `NHTSA recall campaigns for this year/make/model: ${report.recalls.length}.`);
  } else {
    push("ev_recall_unavailable", "NHTSA recall lookup was unavailable.");
  }
  if (report.complaintCount != null) {
    push("ev_complaint_count", `NHTSA complaint count for this year/make/model: ${report.complaintCount}.`);
  }
  for (const [index, flag] of report.flags.entries()) {
    push(`ev_flag_${index}`, `${flag.level}: ${flag.text}`);
  }
  for (const [index, note] of report.dataNotes.entries()) {
    push(`ev_note_${index}`, note);
  }
  for (const [index, reason] of report.reasons.entries()) {
    push(`ev_reason_${index}`, reason);
  }
  return { ids: new Set(facts.map((row) => row.id)), facts };
}

export async function runReportVerdictChallenge(input: {
  report: ComputedReport;
  primaryAction: Exclude<DecisionAction, "withheld"> | null;
  confidence: AgentVerdictConfidence | null;
  allowedActions: Array<Exclude<DecisionAction, "withheld">>;
  hasBudget: boolean;
  servKey?: string;
  servBaseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  transportPolicy?: ServDeps["transportPolicy"];
}): Promise<{ result: AgentSecondPassResult; proof: ServProof | null; rawText: string | null }> {
  if (!input.hasBudget) {
    return {
      result: applyAgentSecondPass({
        primaryAction: input.primaryAction,
        confidence: input.confidence,
        rawText: null,
        allowedEvidenceIds: new Set(),
        statusIfNoBudget: "skipped_no_budget",
      }),
      proof: null,
      rawText: null,
    };
  }
  if (!input.servKey) {
    return {
      result: applyAgentSecondPass({
        primaryAction: input.primaryAction,
        confidence: input.confidence,
        rawText: null,
        allowedEvidenceIds: new Set(),
        statusIfNoBudget: "skipped_no_key",
      }),
      proof: null,
      rawText: null,
    };
  }

  const { ids, facts } = collectReportEvidenceIds(input.report);
  const deps: ServDeps = {
    fetch: input.fetchImpl ?? fetch,
    apiKey: input.servKey,
    baseUrl: input.servBaseUrl,
    model: input.model,
    // Prefer production retries for empty/timeout — experiment_single_attempt left
    // challenge as "did not finish" after a response id with an empty body.
    transportPolicy: input.transportPolicy ?? "production",
  };
  const judged = await runServ(
    "verdict_challenge",
    {
      user: JSON.stringify({
        primaryAction: input.primaryAction,
        allowedActions: input.allowedActions,
        evidence: facts,
        allowedEvidenceIds: [...ids],
      }),
    },
    deps,
  );

  if (!judged.ok) {
    const responseId =
      typeof judged.proof?.openserv?.id === "string" && judged.proof.openserv.id.trim()
        ? judged.proof.openserv.id.trim()
        : null;
    const reasonBits = [
      judged.error?.trim() || "Second check did not finish",
      judged.upstream ? `upstream=${judged.upstream}` : null,
      judged.status ? `http=${judged.status}` : null,
      judged.failureDiag?.reasonCode ? `diag=${judged.failureDiag.reasonCode}` : null,
      responseId ? `response ${responseId}` : "no response id",
      typeof judged.proof?.latencyMs === "number" ? `${judged.proof.latencyMs}ms` : null,
    ].filter(Boolean);
    return {
      result: {
        status: "unavailable",
        action: null,
        objection: `${reasonBits.join(" · ")}. The first verdict stands.`,
        evidenceIds: [],
        confidenceBefore: input.confidence,
        confidenceAfter: input.confidence,
      },
      proof: judged.proof,
      rawText: null,
    };
  }

  const result = applyAgentSecondPass({
    primaryAction: input.primaryAction,
    confidence: input.confidence,
    rawText: judged.text,
    allowedEvidenceIds: ids,
  });
  return { result, proof: judged.proof, rawText: judged.text };
}
