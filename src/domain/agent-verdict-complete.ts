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
 *
 * A pass that has BOTH a written nothing-fits reason and journaled searches is
 * accepted — including after identical empty searches. Code never forces SERV
 * to change filters; duplicateSearch feedback on the tool is observational only.
 */

export type AgentSearchJournalRow = {
  /** Tool args as sent (zip, radius, price, body, …). */
  params: Record<string, unknown> | null;
  /** Listings returned after funnel (or provider count when funnel absent). */
  resultCount: number;
  /** Optional per-filter funnel steps from search_listings. */
  funnel?: Array<{ step: string; count: number }> | null;
  /** Provider HTTP status when search_listings failed upstream (0 = network/timeout). */
  providerStatus?: number | null;
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

export function searchesDocumented(searches: readonly AgentSearchJournalRow[]): boolean {
  if (searches.length === 0) return false;
  return searches.every((s) => s.params != null && Number.isFinite(s.resultCount));
}

/** True when every journaled search kept zero listings (empty inventory after search). */
export function searchesAllEmpty(searches: readonly AgentSearchJournalRow[]): boolean {
  return searchesDocumented(searches) && searches.every((s) => s.resultCount === 0);
}

/**
 * Honest nothing-fits reason from the code search journal when SERV stops without a terminal.
 * Used only after a terminal nudge failed — never invents inventory outcomes.
 */
export function honestNothingFitsReasonFromSearches(
  searches: readonly AgentSearchJournalRow[],
): string {
  const evidence = formatSearchJournalEvidence(searches);
  if (!searchesDocumented(searches)) {
    return "SERV stopped without submit_picks or submit_nothing_fits, and no search_listings calls were journaled.";
  }
  if (searchesAllEmpty(searches)) {
    return `Live search returned no listings that fit after ${searches.length} search_listings call(s). Code journal:\n${evidence}`;
  }
  return `SERV stopped without submit_picks or submit_nothing_fits after searching. Code journal:\n${evidence}`;
}

/**
 * Code-owned search_listings evidence for repair / nothing-fits.
 * SERV must not re-document these rows — reference them in the reason only.
 */
export function formatSearchJournalEvidence(
  searches: readonly AgentSearchJournalRow[],
): string {
  if (searches.length === 0) {
    return "(no search_listings calls journaled yet — run search_listings before submit_nothing_fits / empty submit_picks)";
  }
  return searches
    .map((row, i) => {
      const params = row.params ?? {};
      const label = [
        params.zip != null ? `zip=${String(params.zip)}` : null,
        params.radiusMi != null ? `radius=${String(params.radiusMi)}mi` : null,
        params.priceMaxUsd != null ? `priceMax=$${String(params.priceMaxUsd)}` : null,
        params.bodyStyle != null ? `body=${String(params.bodyStyle)}` : null,
        params.bodyFamily != null ? `bodyFamily=${String(params.bodyFamily)}` : null,
        params.yearMin != null ? `yearMin=${String(params.yearMin)}` : null,
        params.make != null ? `make=${String(params.make)}` : null,
        params.model != null ? `model=${String(params.model)}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      const http =
        row.providerStatus != null && Number.isFinite(row.providerStatus)
          ? ` http=${row.providerStatus}`
          : "";
      const funnel =
        row.funnel && row.funnel.length > 0
          ? `; funnel ${row.funnel.map((s) => `${s.step}=${s.count}`).join(" → ")}`
          : "";
      return `search_${i + 1}: ${label || "open filters"}; kept=${row.resultCount}${http}${funnel}`;
    })
    .join("\n");
}

/** Repair payload when a boundary check fails — exact problem + code journal evidence. */
export function boundaryRepairMessage(input: {
  issues: readonly string[] | readonly { message: string }[];
  searches: readonly AgentSearchJournalRow[];
  hint?: string;
}): string {
  const issues = input.issues.map((row) => (typeof row === "string" ? row : row.message));
  const lines = [
    "Boundary check failed — repair and call a terminal tool (submit_picks or submit_nothing_fits).",
    input.hint?.trim() || null,
    "Issues:",
    ...issues.map((msg) => `- ${msg}`),
    "Code-journaled search_listings evidence (do not re-document; use only in your reason):",
    formatSearchJournalEvidence(input.searches),
  ].filter((line): line is string => Boolean(line && line.trim()));
  return lines.join("\n");
}

/**
 * Whether a verdict is complete for scoring / verdictReached.
 *
 * Nothing-fits evidence for searches comes from the code journal (params, counts,
 * HTTP status). SERV supplies the written reason; it must not re-document searches.
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
      "Empty picks require an explicit nothing-fits reason (passReason / summary). Code already journals search_listings — state why nothing fit; do not re-list search params.",
    );
  }
  if (!searchesDocumented(input.searches)) {
    issues.push(
      "Nothing-fits requires prior search_listings calls in the code journal (params + result count + HTTP status when present). Run search_listings first; code attaches the evidence automatically.",
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
