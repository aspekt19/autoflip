/**
 * Run the independent verdict_challenge SERV profile and apply domain rules.
 * Counts as one paid SERV call. Skips cleanly when no key or caller says no budget.
 */

import { applyAgentSecondPass } from "@/domain/agent-second-pass";
import { ASSUMPTIONS } from "@/domain/assumptions";
import type { AgentSecondPassResult, AgentVerdictConfidence } from "@/domain/agent-verdict-schema";
import type { DecisionAction } from "@/domain/decision-action";
import {
  secondCheckUnavailableLabel,
  secondCheckUnavailableRawDump,
  shortSecondCheckUnavailableReason,
} from "@/domain/second-check-unavailable";
import { providerResponseIdFromCall } from "@/domain/serv-response-id";
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
  const ask = report.subject.priceUsd;
  if (report.mode === "flip") {
    if (report.fairValueUsd != null) {
      push(
        "ev_resale_mid",
        `Resale mid estimate from similar asks: ${report.fairValueUsd}. This is a resale mid, not a buy-side fair value.`,
      );
    } else {
      push("ev_resale_mid_missing", "Not enough similar cars for a resale mid estimate.");
    }
    if (ask != null) {
      push("ev_asking", `Asking price (buy-side): ${ask}.`);
    }
    if (report.flip) {
      push(
        "ev_flip_margin",
        `Conservative flip margin (risk-adjusted): ${report.flip.marginUsd}. Adequate buy margin threshold: ${ASSUMPTIONS.flipDesiredProfitUsd} (flipDesiredProfitUsd). Thin margin threshold: ${ASSUMPTIONS.flipThinMarginUsd} (flipThinMarginUsd).`,
      );
      push("ev_flip_target_buy", `Target buy for the profit goal: ${report.flip.targetBuyUsd}.`);
    }
    if (report.priceGap != null) {
      push(
        "ev_ask_vs_resale_mid",
        `Ask versus resale mid gap (positive means ask above resale mid): ${report.priceGap}.`,
      );
    }
  } else if (report.fairValueUsd != null) {
    push("ev_fair_value", `Fair value from similar listings: ${report.fairValueUsd}.`);
  } else {
    push("ev_fair_value_missing", "Not enough similar cars for a fair value.");
  }
  if (report.mode !== "flip" && report.priceGap != null) {
    push("ev_price_gap", `Asking price gap versus fair value: ${report.priceGap}.`);
  }
  push(
    "ev_comp_count",
    `Similar listing count: ${report.compSampleSize ?? report.comps.length}.`,
  );
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
  /** Clamped wall-clock timeout for this challenge call (AbortSignal via runServ). */
  timeoutMs?: number;
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
    ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
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
    // Error-body ids are never provider response ids.
    const short = shortSecondCheckUnavailableReason({
      error: judged.error,
      upstream: judged.upstream,
      status: judged.status,
      reasonCode: judged.failureDiag?.reasonCode,
    });
    const rawDump = secondCheckUnavailableRawDump([
      judged.error?.trim() || null,
      judged.upstream ? `upstream=${judged.upstream}` : null,
      judged.status ? `http=${judged.status}` : null,
      judged.failureDiag?.reasonCode ? `diag=${judged.failureDiag.reasonCode}` : null,
      "no response id",
      typeof judged.proof?.latencyMs === "number" ? `${judged.proof.latencyMs}ms` : null,
      "The first verdict stands.",
    ]);
    return {
      result: {
        status: "unavailable",
        action: null,
        objection: secondCheckUnavailableLabel(short),
        rawDump,
        evidenceIds: [],
        confidenceBefore: input.confidence,
        confidenceAfter: input.confidence,
      },
      proof: judged.proof,
      rawText: null,
    };
  }

  const responseId = providerResponseIdFromCall({
    ok: true,
    id: typeof judged.proof?.openserv?.id === "string" ? judged.proof.openserv.id : null,
  });
  const result = applyAgentSecondPass({
    primaryAction: input.primaryAction,
    confidence: input.confidence,
    rawText: judged.text,
    allowedEvidenceIds: ids,
    profile: "verdict_challenge",
    responseId,
  });
  return { result, proof: judged.proof, rawText: judged.text };
}
