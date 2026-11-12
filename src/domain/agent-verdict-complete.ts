/**
 * Scoring / repair gate for agent submit_picks.
 *
 * verdictReached for scoring means:
 *   - at least one chosen (non-pass) listing with a tool-known VIN, OR
 *   - an explicit "nothing fits" result that documents every search SERV ran
 *     (params + counts) and specific reasons for rejected candidates (or
 *     explains zero inventory after those searches).
 *
 * A bare pass with no vehicle and no documented reasons is incomplete and must
 * go back to SERV for a repair turn — it must not score as verdictReached.
 * Identical repeated zero-result searches without a filter change are incomplete —
 * SERV must change approach (code never auto-relaxes).
 */

import { allSearchesIdentical } from "./search-listings-feedback";

export type AgentSearchJournalRow = {
  /** Tool args as sent (zip, radius, price, body, …). */
  params: Record<string, unknown> | null;
  /** Listings returned after funnel (or provider count when funnel absent). */
  resultCount: number;
  /** Optional per-filter funnel steps from search_listings. */
  funnel?: Array<{ step: string; count: number }> | null;
};

export type AgentRejectReason = {
  vin?: string | null;
  reason: string;
};

export type ScoringVerdictShape = {
  picks: Array<{ vin: string; action: string; why?: string }>;
  /** Find: passReason. Resale: summary when picks are empty. */
  nothingFitsReason: string | null;
  relaxedConditions?: Array<{ name: string; why: string }>;
};

export type ScoringVerdictCompleteInput = {
  verdict: ScoringVerdictShape;
  searches: readonly AgentSearchJournalRow[];
  rejectedCandidates?: readonly AgentRejectReason[];
};

export type ScoringVerdictCompleteResult =
  | { complete: true; kind: "chosen" | "nothing_fits" }
  | { complete: false; issues: string[] };

const PLACEHOLDER_RE = /^(redacted|n\/a|na|none|tbd|todo|\.+|unknown)$/i;

/** True when a relaxation name/why is usable (not a content-filter placeholder). */
export function isRealRelaxationText(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (t.length < 2) return false;
  return !PLACEHOLDER_RE.test(t);
}

/** Filter model-emitted relaxations; drop placeholders. */
export function filterRealRelaxedConditions<T extends { name: string; why: string }>(
  rows: readonly T[],
): T[] {
  return rows.filter((r) => isRealRelaxationText(r.name) && isRealRelaxationText(r.why));
}

/**
 * Synthesize relaxation lines from search_listings journal when the model
 * emitted placeholders or omitted them. Not secret — store real text.
 */
export function synthesizeRelaxedConditionsFromSearches(
  searches: readonly AgentSearchJournalRow[],
): Array<{ name: string; why: string }> {
  const out: Array<{ name: string; why: string }> = [];
  for (const [i, row] of searches.entries()) {
    const params = row.params ?? {};
    const label = [
      params.zip != null ? `zip=${String(params.zip)}` : null,
      params.radiusMi != null ? `radius=${String(params.radiusMi)}mi` : null,
      params.priceMaxUsd != null ? `priceMax=$${String(params.priceMaxUsd)}` : null,
      params.bodyStyle != null ? `body=${String(params.bodyStyle)}` : null,
      params.bodyFamily != null ? `bodyFamily=${String(params.bodyFamily)}` : null,
      params.yearMin != null ? `yearMin=${String(params.yearMin)}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    const funnel =
      row.funnel && row.funnel.length > 0
        ? row.funnel.map((s) => `${s.step}=${s.count}`).join(" → ")
        : null;
    out.push({
      name: `search_${i + 1}`,
      why: funnel
        ? `Ran search (${label || "open filters"}); funnel ${funnel}; kept ${row.resultCount}.`
        : `Ran search (${label || "open filters"}); ${row.resultCount} listing(s) kept.`,
    });
  }
  return out;
}

function actionablePicks(verdict: ScoringVerdictShape): ScoringVerdictShape["picks"] {
  return verdict.picks.filter((p) => {
    const action = (p.action ?? "").trim().toLowerCase();
    return action !== "" && action !== "pass";
  });
}

function searchesDocumented(searches: readonly AgentSearchJournalRow[]): boolean {
  if (searches.length === 0) return false;
  return searches.every((s) => s.params != null && Number.isFinite(s.resultCount));
}

/**
 * Whether a verdict is complete for scoring / verdictReached.
 */
export function scoringVerdictComplete(
  input: ScoringVerdictCompleteInput,
): ScoringVerdictCompleteResult {
  const chosen = actionablePicks(input.verdict);
  if (chosen.length > 0) {
    return { complete: true, kind: "chosen" };
  }

  const issues: string[] = [];
  const reason = (input.verdict.nothingFitsReason ?? "").trim();
  if (!reason) {
    issues.push(
      "Empty picks require an explicit nothing-fits reason (passReason / summary) listing why no car was chosen and what searches were tried.",
    );
  }
  if (!searchesDocumented(input.searches)) {
    issues.push(
      "Nothing-fits requires documenting every search_listings call (params + result count) in the journal.",
    );
  }

  const allZero = input.searches.length > 0 && input.searches.every((s) => s.resultCount === 0);
  if (allZero && allSearchesIdentical(input.searches)) {
    issues.push(
      "Identical zero-result searches were repeated without changing filters. Change at least one relaxable filter and re-search (or explain a real blocker) — code will not auto-relax; do not pass after only duplicate searches.",
    );
  }

  const rejects = input.rejectedCandidates ?? [];
  const anyInventory = input.searches.some((s) => s.resultCount > 0);
  if (anyInventory && rejects.length === 0) {
    // Also accept per-pick pass whys on the verdict itself.
    const passWhys = input.verdict.picks.filter((p) => (p.why ?? "").trim().length > 0);
    if (passWhys.length === 0) {
      issues.push(
        "Nothing-fits with candidates considered requires specific rejection reasons per candidate (or pass whys).",
      );
    }
  }

  if (issues.length > 0) return { complete: false, issues };
  return { complete: true, kind: "nothing_fits" };
}

/** Live-eval / harness: ok only when a car is chosen or a complete nothing-fits. */
export function liveEvalOutcomeOk(input: {
  failure: unknown | null;
  chosenVin: string | null | undefined;
  verdictReached: boolean;
  scoring: ScoringVerdictCompleteResult | null;
}): { ok: boolean; chosenListingCount: number } {
  if (input.failure) return { ok: false, chosenListingCount: 0 };
  const chosenListingCount = input.chosenVin?.trim() ? 1 : 0;
  if (chosenListingCount > 0) return { ok: true, chosenListingCount };
  if (input.verdictReached && input.scoring?.complete && input.scoring.kind === "nothing_fits") {
    return { ok: true, chosenListingCount: 0 };
  }
  return { ok: false, chosenListingCount: 0 };
}
