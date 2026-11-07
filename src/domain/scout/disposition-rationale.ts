/**
 * Structured reject/replace validation — unsupported gov alone is never car-bad proof.
 * Unknown-title / unknown-history default forbids are NOT independent adverse evidence.
 * Adverse actions must cite matching evidence/gate/economics provenance — incidental
 * forbids do not unlock arbitrary planner reason text.
 */
import type { GateResult } from "@/domain/verdict-gates";
import { isUsableAskingPriceUsd } from "./asking-price";
import type { ScoutCandidate, ScoutToolOutcome } from "./types";

/** Real adverse evidence kinds — excludes default unknown-title / unknown-history forbids. */
export type AdverseEvidenceKind =
  | "bad_title_brand"
  | "over_budget"
  | "over_miles"
  | "flip_excluded"
  | "missing_asking_price"
  /** Flip profit estimate from asking comps + assumed costs — not observed hard budget. */
  | "economics_estimate"
  /** NHTSA park-it/park-outside make/model/year campaign — not VIN unrepaired or title brand. */
  | "nhtsa_park_it";

/** How the adverse fact was established — estimate paths require explicit disclosure. */
export type AdverseEvidenceEpistemic = "observed_hard" | "estimate_assumptions";

export type AdverseEvidenceFact = {
  kind: AdverseEvidenceKind;
  epistemic: AdverseEvidenceEpistemic;
  gateId?: string;
  detail: string;
};

/** Planner citation — must match a collected adverse fact. */
export type CitedEvidenceRef = {
  kind: AdverseEvidenceKind;
  gateId?: string;
};

export type DispositionRationaleRecord = {
  kind: "adverse_evidence" | "uncertainty_progress";
  /** Endorsed grounded reason — never raw unsupported-gov car-bad model text. */
  groundedReason: string;
  citedEvidence: AdverseEvidenceFact[];
  /** Planner free-text retained for audit only — not the endorsed API reason. */
  plannerReasonRaw: string;
  assumptionsDisclosed: boolean;
};

export type DispositionValidation =
  | {
      ok: true;
      mode: "adverse_evidence" | "uncertainty_progress";
      adverse: AdverseEvidenceFact[];
      cited: AdverseEvidenceFact[];
      groundedReason: string;
      assumptionsDisclosed: boolean;
    }
  | {
      ok: false;
      code:
        | "unsupported_gov_alone_forbidden"
        | "reject_lacks_adverse_evidence"
        | "reject_rationale_not_grounded"
        | "replace_gov_alone_car_bad_forbidden"
        | "replace_rationale_not_grounded"
        | "economics_assumptions_not_disclosed";
      message: string;
      adverse: AdverseEvidenceFact[];
    };

const UNKNOWN_TITLE_RE =
  /not scanned|status unknown|unknown \(not a safety pass\)|buy forbidden until evidenced/i;
const BAD_TITLE_RE = /salvage|flood|lemon|rebuilt|junk|branded title|theft|totaled/i;
const OVER_BUDGET_RE = /exceeds personal budget|over budget|price exceeds/i;
const OVER_MILES_RE = /exceeds.*miles|over miles|mileage cap/i;
const ECONOMICS_ESTIMATE_RE =
  /estimated mid profit|estimate from asking comps|assumed costs|clears target/i;

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

  if (c.listing.priceUsd == null || !isUsableAskingPriceUsd(c.listing.priceUsd)) {
    out.push({
      kind: "missing_asking_price",
      epistemic: "observed_hard",
      // Align with constraintQualification.price — planners often cite gateId "price".
      // Pipeline disposition only: unusable ask ≠ vehicle-defect / car-bad proof.
      gateId: "price",
      detail:
        c.listing.priceUsd == null
          ? "Asking price missing — economics cannot be investigated honestly."
          : `Asking price ${c.listing.priceUsd} is below usable retail floor — treated as missing/unusable (not invented upward).`,
    });
  }

  if (c.flip?.excluded) {
    out.push({
      kind: "flip_excluded",
      epistemic: "observed_hard",
      detail: `Flip excluded: ${c.flip.excludeReason ?? "excluded"}`,
    });
  }

  for (const g of c.gates ?? []) {
    if (isDefaultUnknownTitleForbid(g)) continue;
    if (isUnknownHistoryWithhold(g)) continue;

    if (g.id === "safety_red_flags" && g.status === "forbid") {
      if (BAD_TITLE_RE.test(g.reason)) {
        out.push({
          kind: "bad_title_brand",
          epistemic: "observed_hard",
          gateId: g.id,
          detail: g.reason,
        });
      }
      // Other safety_red_flags forbids that are not bad-title and not default-unknown
      // stay non-adverse unless verified evidence below records them.
      continue;
    }

    if (g.id === "mandate_fit" && g.status === "forbid") {
      if (OVER_BUDGET_RE.test(g.reason) || (/budget/i.test(g.reason) && !ECONOMICS_ESTIMATE_RE.test(g.reason))) {
        out.push({
          kind: "over_budget",
          epistemic: "observed_hard",
          gateId: g.id,
          detail: g.reason,
        });
      } else if (OVER_MILES_RE.test(g.reason)) {
        out.push({
          kind: "over_miles",
          epistemic: "observed_hard",
          gateId: g.id,
          detail: g.reason,
        });
      } else if (ECONOMICS_ESTIMATE_RE.test(g.reason) || /profit/i.test(g.reason)) {
        out.push({
          kind: "economics_estimate",
          epistemic: "estimate_assumptions",
          gateId: g.id,
          detail: g.reason,
        });
      }
      // Unclassified mandate_fit forbid: do not treat as free adverse unlock.
      continue;
    }

    // Do not treat every remaining gate forbid as adverse — that unlocked arbitrary text.
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
        epistemic: "observed_hard",
        detail: e.note ?? "Verified adverse title/brand evidence.",
      });
    }
    if (e.key === "nhtsa_park_it" && e.kind === "verified") {
      out.push({
        kind: "nhtsa_park_it",
        epistemic: "observed_hard",
        gateId: "nhtsa_park_it",
        detail:
          e.note ??
          "NHTSA park-it/park-outside campaign for make/model/year — not VIN unrepaired proof; title/NMVTIS unknown.",
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
      (o.toolId === "evidence.gov_recalls" ||
        o.toolId === "evidence.gov_fuel" ||
        o.toolId === "evidence.gov_vpic" ||
        o.toolId === "evidence.gov_safety") &&
      (o.capability === "unsupported" ||
        o.status === "unsupported" ||
        o.capability === "failed" ||
        o.status === "failed"),
  );
}

function resolveCitedFacts(
  adverse: AdverseEvidenceFact[],
  cited: CitedEvidenceRef[] | undefined,
): { ok: true; matched: AdverseEvidenceFact[] } | { ok: false; message: string } {
  if (!cited || cited.length === 0) {
    return {
      ok: false,
      message:
        "adverse_evidence requires citedEvidence refs matching structured adverse facts (gate/economics/title) — presence of any forbid does not unlock arbitrary reason text.",
    };
  }
  const matched: AdverseEvidenceFact[] = [];
  for (const ref of cited) {
    // Kind must match. GateId is required only when BOTH sides declare one —
    // planners often invent a field name (e.g. price) when the fact omitted gateId;
    // that must not deny an otherwise grounded missing_asking_price cite.
    const hit = adverse.find((a) => {
      if (a.kind !== ref.kind) return false;
      const refGate = ref.gateId == null || ref.gateId === "" ? null : ref.gateId;
      const factGate = a.gateId == null || a.gateId === "" ? null : a.gateId;
      if (refGate == null || factGate == null) return true;
      return refGate === factGate;
    });
    if (!hit) {
      return {
        ok: false,
        message: `citedEvidence ${ref.kind}${ref.gateId ? `@${ref.gateId}` : ""} does not match collected adverse facts.`,
      };
    }
    if (!matched.includes(hit)) matched.push(hit);
  }
  return { ok: true, matched };
}

function buildGroundedAdverseReason(
  cited: AdverseEvidenceFact[],
  assumptionsDisclosed: boolean,
): string {
  const parts = cited.map((f) => `${f.kind}(${f.epistemic}): ${f.detail}`);
  const base = `[adverse_evidence] ${parts.join(" | ")}`;
  if (cited.some((f) => f.epistemic === "estimate_assumptions")) {
    return assumptionsDisclosed
      ? `${base} — assumptions disclosed (estimate, not verified hard fact).`
      : base;
  }
  return base;
}

export function buildUncertaintyGroundedReason(): string {
  return "[uncertainty_progress] Advancing without car-bad claim — unsupported/incomplete evidence is not proof the vehicle is bad.";
}

/**
 * Validate reject/replace against structured candidate evidence.
 * Reject/replace with adverse_evidence must cite matching facts; incidental forbids
 * do not endorse unrelated planner text. uncertainty_progress uses a grounded reason
 * (planner free-text is audit-only).
 */
export function validateDispositionAction(input: {
  action: "reject" | "replace";
  vin: string;
  reason: string;
  candidate: ScoutCandidate | undefined;
  recentOutcomes: ScoutToolOutcome[];
  rationaleKind?: "adverse_evidence" | "uncertainty_progress";
  citedEvidence?: CitedEvidenceRef[];
  /** Required when citing economics_estimate / estimate_assumptions facts. */
  assumptionsDisclosed?: boolean;
}): DispositionValidation {
  const adverse = input.candidate ? collectAdverseEvidence(input.candidate) : [];
  const govUnsupported = hasUnsupportedGovOutcome(input.vin, input.recentOutcomes);
  const kind = input.rationaleKind;
  const assumptionsDisclosed = input.assumptionsDisclosed === true;

  if (input.action === "reject") {
    if (kind === "uncertainty_progress") {
      return {
        ok: false,
        code: "reject_lacks_adverse_evidence",
        message: "Reject cannot use uncertainty_progress — abstain or replace instead.",
        adverse,
      };
    }

    // Reject always requires adverse_evidence mode + cited matching facts.
    if (kind != null && kind !== "adverse_evidence") {
      return {
        ok: false,
        code: "reject_lacks_adverse_evidence",
        message: "Reject requires rationaleKind=adverse_evidence with citedEvidence.",
        adverse,
      };
    }

    if (govUnsupported && kind !== "adverse_evidence") {
      return {
        ok: false,
        code: "unsupported_gov_alone_forbidden",
        message:
          "Reject blocked after unsupported gov: set rationaleKind=adverse_evidence with citedEvidence matching structured adverse facts (unknown title/history and unsupported gov do not count).",
        adverse,
      };
    }

    if (adverse.length === 0) {
      return {
        ok: false,
        code: govUnsupported ? "unsupported_gov_alone_forbidden" : "reject_lacks_adverse_evidence",
        message:
          "Reject blocked: no structured adverse evidence (unknown-title/history forbids and unsupported gov do not count).",
        adverse,
      };
    }

    // After gov unsupported, or whenever rationaleKind is adverse_evidence, require cites.
    // Also require cites when kind is omitted but adverse exists — bind reason to evidence.
    if (kind === "adverse_evidence" || govUnsupported || kind == null) {
      const resolved = resolveCitedFacts(adverse, input.citedEvidence);
      if (!resolved.ok) {
        return {
          ok: false,
          code: govUnsupported ? "unsupported_gov_alone_forbidden" : "reject_rationale_not_grounded",
          message: resolved.message,
          adverse,
        };
      }
      if (
        resolved.matched.some((f) => f.epistemic === "estimate_assumptions") &&
        !assumptionsDisclosed
      ) {
        return {
          ok: false,
          code: "economics_assumptions_not_disclosed",
          message:
            "Economics estimate rejection requires assumptionsDisclosed=true (comps + assumed costs are not verified hard facts).",
          adverse,
        };
      }
      return {
        ok: true,
        mode: "adverse_evidence",
        adverse,
        cited: resolved.matched,
        groundedReason: buildGroundedAdverseReason(resolved.matched, assumptionsDisclosed),
        assumptionsDisclosed,
      };
    }

    return {
      ok: false,
      code: "reject_lacks_adverse_evidence",
      message: "Reject blocked: set rationaleKind=adverse_evidence with citedEvidence.",
      adverse,
    };
  }

  // replace
  if (kind === "uncertainty_progress") {
    return {
      ok: true,
      mode: "uncertainty_progress",
      adverse,
      cited: [],
      groundedReason: buildUncertaintyGroundedReason(),
      assumptionsDisclosed: false,
    };
  }

  if (govUnsupported && kind == null) {
    return {
      ok: false,
      code: "replace_gov_alone_car_bad_forbidden",
      message:
        "Replace blocked: after unsupported gov, set rationaleKind=uncertainty_progress for honest try-next, or rationaleKind=adverse_evidence with citedEvidence.",
      adverse,
    };
  }

  if (kind === "adverse_evidence") {
    const resolved = resolveCitedFacts(adverse, input.citedEvidence);
    if (!resolved.ok) {
      return {
        ok: false,
        code: "replace_rationale_not_grounded",
        message: resolved.message,
        adverse,
      };
    }
    if (
      resolved.matched.some((f) => f.epistemic === "estimate_assumptions") &&
      !assumptionsDisclosed
    ) {
      return {
        ok: false,
        code: "economics_assumptions_not_disclosed",
        message:
          "Economics estimate replacement requires assumptionsDisclosed=true (estimate, not verified hard fact).",
        adverse,
      };
    }
    return {
      ok: true,
      mode: "adverse_evidence",
      adverse,
      cited: resolved.matched,
      groundedReason: buildGroundedAdverseReason(resolved.matched, assumptionsDisclosed),
      assumptionsDisclosed,
    };
  }

  // Omitted kind + no gov: if adverse exists without cites, do not auto-endorse as adverse —
  // treat as uncertainty_progress (honest try-next) rather than laundering arbitrary text.
  if (adverse.length > 0 && (input.citedEvidence?.length ?? 0) > 0) {
    const resolved = resolveCitedFacts(adverse, input.citedEvidence);
    if (resolved.ok) {
      if (
        resolved.matched.some((f) => f.epistemic === "estimate_assumptions") &&
        !assumptionsDisclosed
      ) {
        return {
          ok: false,
          code: "economics_assumptions_not_disclosed",
          message:
            "Economics estimate replacement requires assumptionsDisclosed=true (estimate, not verified hard fact).",
          adverse,
        };
      }
      return {
        ok: true,
        mode: "adverse_evidence",
        adverse,
        cited: resolved.matched,
        groundedReason: buildGroundedAdverseReason(resolved.matched, assumptionsDisclosed),
        assumptionsDisclosed,
      };
    }
  }

  return {
    ok: true,
    mode: "uncertainty_progress",
    adverse,
    cited: [],
    groundedReason: buildUncertaintyGroundedReason(),
    assumptionsDisclosed: false,
  };
}

export function applyDispositionRationale(
  cand: ScoutCandidate,
  validation: Extract<DispositionValidation, { ok: true }>,
  plannerReasonRaw: string,
): DispositionRationaleRecord {
  const record: DispositionRationaleRecord = {
    kind: validation.mode,
    groundedReason: validation.groundedReason,
    citedEvidence: validation.cited,
    plannerReasonRaw,
    assumptionsDisclosed: validation.assumptionsDisclosed,
  };
  cand.dispositionRationale = record;
  cand.rejectReason = record.groundedReason;
  return record;
}

/** @deprecated Prefer collectAdverseEvidence / validateDispositionAction. */
export function candidateHasIndependentRejectFacts(c: ScoutCandidate): boolean {
  return collectAdverseEvidence(c).length > 0;
}

/** @deprecated Prefer validateDispositionAction — do not use reason regex for gating. */
export function isUnsupportedGovAloneRejectReason(reason: string): boolean {
  const r = reason.toLowerCase();
  return /unsupported\s+gov|gov[_\s]?recall|gov[_\s]?fuel|gov lookup not executed|gov unsupported|car is bad/.test(
    r,
  );
}
