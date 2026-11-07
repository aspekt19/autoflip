/**
 * Structured Scout run diagnostics — complementary to PR #68 planner-parse
 * sanitization (schema_mismatch / usage / redaction). No secrets, VINs, URLs,
 * or raw planner prose. Counts + enums only.
 */
import { assessListingAskingPrice } from "./asking-price";
import { isFreeGovToolId } from "./free-gov";
import type { ScoutCandidate, ScoutRunResult, ScoutToolOutcome } from "./types";

export type ScoutTerminationCause =
  | "candidate_cap"
  | "planner_finalize"
  | "planner_abstain"
  | "wall_budget"
  | "tool_budget"
  | "serv_budget"
  | "no_progress"
  | "inventory_empty"
  | "inventory_error"
  | "serv_error"
  | "invariant"
  | "other";

export type ScoutRunDiagnostics = {
  terminationCause: ScoutTerminationCause;
  /** Provenance reason length only — never the reason text. */
  terminationReasonChars: number | null;
  evidenceRetention: {
    investigationCount: number;
    investigationWithGovEvidence: number;
    govToolOutcomeSuccesses: number;
    govEvidenceFactCountOnInvestigation: number;
  };
  askingPrice: {
    poolUsableForShortlist: number;
    poolUnusable: number;
    byStatus: Record<string, number>;
  };
};

function govEvidenceKeys(c: ScoutCandidate): string[] {
  return (c.evidence ?? [])
    .map((e) => e.key)
    .filter(
      (k) =>
        k === "nhtsa_park_it" ||
        k === "evidence.gov_recalls" ||
        k === "evidence.gov_vpic" ||
        k === "evidence.gov_safety" ||
        k === "evidence.gov_fuel",
    );
}

function inferTerminationCause(result: Pick<
  ScoutRunResult,
  "state" | "failReason" | "provenance" | "message"
>): ScoutTerminationCause {
  const last = result.provenance[result.provenance.length - 1] ?? null;
  const prior = result.provenance[result.provenance.length - 2] ?? null;
  const reasons = [prior?.reason, last?.reason, result.message]
    .filter((r): r is string => typeof r === "string")
    .join(" | ")
    .toLowerCase();

  if (/candidate cap reached/i.test(reasons)) return "candidate_cap";
  if (result.state === "abstained" || /honest abstain|abstain/i.test(reasons)) {
    return "planner_abstain";
  }
  if (result.state === "completed" && /finaliz/i.test(reasons)) return "planner_finalize";
  if (result.failReason === "budget_exhausted") {
    if (/wall/i.test(reasons)) return "wall_budget";
    if (/tool/i.test(reasons)) return "tool_budget";
    if (/serv/i.test(reasons)) return "serv_budget";
    if (/no[- ]progress|identical/i.test(reasons)) return "no_progress";
    return "other";
  }
  if (/no[- ]progress|identical action/i.test(reasons)) return "no_progress";
  if (result.failReason === "inventory_empty") return "inventory_empty";
  if (
    result.failReason === "inventory_unconfigured" ||
    result.failReason === "provider_unavailable"
  ) {
    return "inventory_error";
  }
  if (
    result.failReason === "serv_refused" ||
    result.failReason === "serv_timeout" ||
    result.failReason === "serv_unavailable"
  ) {
    return "serv_error";
  }
  if (result.failReason === "invariant_violation") return "invariant";
  if (result.state === "completed") return "planner_finalize";
  return "other";
}

export function buildScoutRunDiagnostics(input: {
  candidates: ScoutCandidate[];
  investigation: ScoutCandidate[];
  toolOutcomes: ScoutToolOutcome[];
  state: ScoutRunResult["state"];
  failReason: ScoutRunResult["failReason"];
  provenance: ScoutRunResult["provenance"];
  message: string | null;
  /** Optional override when the runner knows the cause exactly. */
  terminationCause?: ScoutTerminationCause;
}): ScoutRunDiagnostics {
  const investigation = input.investigation;
  const withGov = investigation.filter((c) => govEvidenceKeys(c).length > 0);
  const govFactCount = investigation.reduce((n, c) => n + govEvidenceKeys(c).length, 0);
  const govSuccesses = input.toolOutcomes.filter(
    (o) =>
      isFreeGovToolId(o.toolId) &&
      o.ok &&
      (o.status === "success" || o.status === "empty"),
  ).length;

  const byStatus: Record<string, number> = {};
  let poolUsable = 0;
  let poolUnusable = 0;
  for (const c of input.candidates) {
    const a = assessListingAskingPrice(c.listing);
    byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
    if (a.usableForShortlist) poolUsable += 1;
    else poolUnusable += 1;
  }

  const cause =
    input.terminationCause ??
    inferTerminationCause({
      state: input.state,
      failReason: input.failReason,
      provenance: input.provenance,
      message: input.message,
    });

  const termStep =
    input.provenance.find((p) => /candidate cap reached|finaliz|abstain|wall|budget/i.test(p.reason)) ??
    input.provenance[input.provenance.length - 1] ??
    null;

  return {
    terminationCause: cause,
    terminationReasonChars: termStep?.reason ? termStep.reason.length : null,
    evidenceRetention: {
      investigationCount: investigation.length,
      investigationWithGovEvidence: withGov.length,
      govToolOutcomeSuccesses: govSuccesses,
      govEvidenceFactCountOnInvestigation: govFactCount,
    },
    askingPrice: {
      poolUsableForShortlist: poolUsable,
      poolUnusable,
      byStatus,
    },
  };
}
