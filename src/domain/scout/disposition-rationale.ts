/**
 * Structured reject/replace validation — unsupported gov alone is never car-bad proof.
 * Unknown-title / unknown-history default forbids are NOT independent adverse evidence.
 */
import type { GateResult } from "@/domain/verdict-gates";
import type { ScoutCandidate, ScoutToolOutcome } from "./types";

/** Real adverse evidence kinds — excludes default unknown-title / unknown-history forbids. */
export type AdverseEvidenceKind =
  | "bad_title_brand"
  | "over_budget"
  | "over_miles"
  | "flip_excluded"
  | "missing_asking_price"
  | "hard_mandate_forbid";

export type AdverseEvidenceFact = {
  kind: AdverseEvidenceKind;
  gateId?: string;
  detail: string;
};

export type DispositionValidation =
  | {
      ok: true;
      mode: "adverse_evidence" | "uncertainty_progress";
      adverse: AdverseEvidenceFact[];
    }
  | {
      ok: false;
      code:
        | "unsupported_gov_alone_forbidden"
        | "reject_lacks_adverse_evidence"
        | "replace_gov_alone_car_bad_forbidden";
      message: string;
      adverse: AdverseEvidenceFact[];
    };

const UNKNOWN_TITLE_RE =
  /not scanned|status unknown|unknown \(not a safety pass\)|buy forbidden until evidenced/i;
const BAD_TITLE_RE = /salvage|flood|lemon|rebuilt|junk|branded title|theft|totaled/i;
const OVER_BUDGET_RE = /exceeds personal budget|over budget|price exceeds/i;
const OVER_MILES_RE = /exceeds.*miles|over miles|mileage cap/i;

function isDefaultUnknownTitleForbid(g: GateResult): boolean {
  return g.id === "safety_red_flags" && g.status === "forbid" && UNKNOWN_TITLE_RE.test(g.reason);
}

function isUnknownHistoryWithhold(g: GateResult): boolean {
  return (
    g.id === "data_sufficiency" &&
    g.status === "withhold" &&
    /history status (unknown|partial)/i.test(g.reason)
  );
}

/** Collect structured adverse facts — unknown title/history defaults do not qualify. */
export function collectAdverseEvidence(c: ScoutCandidate): AdverseEvidenceFact[] {
  const out: AdverseEvidenceFact[] = [];

  if (c.listing.priceUsd == null) {
    out.push({
      kind: "missing_asking_price",
      detail: "Asking price missing — economics cannot be investigated honestly.",
    });
  }

  if (c.flip?.excluded) {
    out.push({
      kind: "flip_excluded",
      detail: `Flip excluded: ${c.flip.excludeReason ?? "excluded"}`,
    });
  }

  for (const g of c.gates ?? []) {
    if (isDefaultUnknownTitleForbid(g)) continue;
    if (isUnknownHistoryWithhold(g)) continue;

    if (g.id === "safety_red_flags" && g.status === "forbid") {
      if (BAD_TITLE_RE.test(g.reason) || !UNKNOWN_TITLE_RE.test(g.reason)) {
        out.push({ kind: "bad_title_brand", gateId: g.id, detail: g.reason });
      }
      continue;
    }

    if (g.id === "mandate_fit" && g.status === "forbid") {
      if (OVER_BUDGET_RE.test(g.reason) || /budget/i.test(g.reason)) {
        out.push({ kind: "over_budget", gateId: g.id, detail: g.reason });
      } else if (OVER_MILES_RE.test(g.reason)) {
        out.push({ kind: "over_miles", gateId: g.id, detail: g.reason });
      } else {
        out.push({ kind: "hard_mandate_forbid", gateId: g.id, detail: g.reason });
      }
      continue;
    }

    if (g.status === "forbid") {
      out.push({ kind: "hard_mandate_forbid", gateId: g.id, detail: g.reason });
    }
  }

  // Evidence facts may record verified bad title from a prior tool.
  for (const e of c.evidence ?? []) {
    if (
      e.kind === "verified" &&
      (e.key.includes("title") || e.key.includes("brand")) &&
      BAD_TITLE_RE.test(`${e.note ?? ""} ${JSON.stringify(e.value)}`)
    ) {
      out.push({
        kind: "bad_title_brand",
        detail: e.note ?? "Verified adverse title/brand evidence.",
      });
    }
  }

  return out;
}

export function hasUnsupportedGovOutcome(
  vin: string,
  outcomes: ScoutToolOutcome[],
): boolean {
  return outcomes.some(
    (o) =>
      o.vin === vin &&
      (o.toolId === "evidence.gov_recalls" || o.toolId === "evidence.gov_fuel") &&
      (o.capability === "unsupported" || o.status === "unsupported"),
  );
}

/**
 * Validate reject/replace against structured candidate evidence.
 * Reject requires adverse facts. Replace without adverse facts is uncertainty_progress
 * unless unsupported gov is being used as a car-bad conclusion (blocked).
 */
export function validateDispositionAction(input: {
  action: "reject" | "replace";
  vin: string;
  reason: string;
  candidate: ScoutCandidate | undefined;
  recentOutcomes: ScoutToolOutcome[];
  /** Structured intent from planner — preferred over reason text. */
  rationaleKind?: "adverse_evidence" | "uncertainty_progress";
}): DispositionValidation {
  const adverse = input.candidate ? collectAdverseEvidence(input.candidate) : [];
  const govUnsupported = hasUnsupportedGovOutcome(input.vin, input.recentOutcomes);
  const kind = input.rationaleKind;

  if (input.action === "reject") {
    if (kind === "uncertainty_progress") {
      return {
        ok: false,
        code: "reject_lacks_adverse_evidence",
        message: "Reject cannot use uncertainty_progress — abstain or replace instead.",
        adverse,
      };
    }
    // After unsupported gov, reject requires explicit adverse_evidence rationale + real adverse facts.
    // Prevents gov-only car-bad reject when unknown-title/default gates or incidental forbids exist.
    if (govUnsupported && kind !== "adverse_evidence") {
      return {
        ok: false,
        code: "unsupported_gov_alone_forbidden",
        message:
          "Reject blocked after unsupported gov: set rationaleKind=adverse_evidence with structured adverse facts (unknown title/history and unsupported gov do not count).",
        adverse,
      };
    }
    if (adverse.length > 0 && (kind === "adverse_evidence" || (!govUnsupported && kind == null))) {
      return { ok: true, mode: "adverse_evidence", adverse };
    }
    return {
      ok: false,
      code: govUnsupported ? "unsupported_gov_alone_forbidden" : "reject_lacks_adverse_evidence",
      message:
        "Reject blocked: no structured adverse evidence (unknown-title/history forbids and unsupported gov do not count).",
      adverse,
    };
  }

  // replace
  if (kind === "uncertainty_progress") {
    return { ok: true, mode: "uncertainty_progress", adverse };
  }
  if (govUnsupported && kind == null) {
    return {
      ok: false,
      code: "replace_gov_alone_car_bad_forbidden",
      message:
        "Replace blocked: after unsupported gov, set rationaleKind=uncertainty_progress for honest try-next, or rationaleKind=adverse_evidence with real adverse facts.",
      adverse,
    };
  }
  if (kind === "adverse_evidence") {
    if (adverse.length === 0) {
      return {
        ok: false,
        code: "replace_gov_alone_car_bad_forbidden",
        message:
          "Replace blocked: rationaleKind=adverse_evidence but no structured adverse facts (unknown title/gov unsupported do not count).",
        adverse,
      };
    }
    return { ok: true, mode: "adverse_evidence", adverse };
  }
  if (adverse.length > 0) {
    return { ok: true, mode: "adverse_evidence", adverse };
  }
  return { ok: true, mode: "uncertainty_progress", adverse };
}

/** @deprecated Prefer collectAdverseEvidence / validateDispositionAction. */
export function candidateHasIndependentRejectFacts(c: ScoutCandidate): boolean {
  return collectAdverseEvidence(c).length > 0;
}

/** @deprecated Prefer validateDispositionAction. */
export function isUnsupportedGovAloneRejectReason(reason: string): boolean {
  const r = reason.toLowerCase();
  return /unsupported\s+gov|gov[_\s]?recall|gov[_\s]?fuel|gov lookup not executed|gov unsupported|car is bad/.test(
    r,
  );
}
