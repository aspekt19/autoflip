/**
 * Honest search_listings feedback for SERV.
 *
 * Code never auto-relaxes filters. Tool results must tell SERV what was searched,
 * funnel stage counts, which active filters are hard vs relaxable, and when a call
 * is an identical duplicate of an earlier search in the same run.
 */

/** Minimal journal row shape (avoids importing agent-verdict-complete). */
export type SearchJournalLike = {
  params: Record<string, unknown> | null;
  resultCount: number;
  funnel?: Array<{ step: string; count: number }> | null;
};

/** Filter keys SERV may pass to search_listings. */
export type SearchFilterKey =
  | "make"
  | "model"
  | "bodyStyle"
  | "bodyFamily"
  | "priceMaxUsd"
  | "milesMax"
  | "yearMin"
  | "yearMax"
  | "zip"
  | "radiusMi"
  | "transmission"
  | "fuel"
  | "drivetrain";

export type SearchConstraintRole = {
  key: SearchFilterKey;
  /** Value SERV passed on this call (normalized). */
  value: string | number;
  /**
   * Structural role — not query-specific.
   * hard: shopper budget/location; keep unless the shopper note allows otherwise.
   * relaxable: search choice SERV may change after empty/weak results.
   */
  kind: "hard" | "relaxable";
};

/** Fields that identify the inventory ask (pagination is not a strategy change). */
const FINGERPRINT_KEYS: SearchFilterKey[] = [
  "make",
  "model",
  "bodyStyle",
  "bodyFamily",
  "priceMaxUsd",
  "milesMax",
  "yearMin",
  "yearMax",
  "zip",
  "radiusMi",
  "transmission",
  "fuel",
  "drivetrain",
];

/** Hard unless the shopper's note allows otherwise — still SERV's call, never code-auto. */
const HARD_KEYS = new Set<SearchFilterKey>(["priceMaxUsd", "zip"]);

function normalizeFilterValue(key: SearchFilterKey, raw: unknown): string | number | null {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.round(raw);
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return null;
    if (key === "zip") return t.slice(0, 5);
    if (
      key === "priceMaxUsd" ||
      key === "milesMax" ||
      key === "yearMin" ||
      key === "yearMax" ||
      key === "radiusMi"
    ) {
      const n = Number(t.replace(/[^0-9.]/g, ""));
      return Number.isFinite(n) && n > 0 ? Math.round(n) : t.toLowerCase();
    }
    return t.toLowerCase();
  }
  return null;
}

/** Stable fingerprint of search filters (ignores limit/page/sort). */
export function fingerprintSearchFilters(params: Record<string, unknown> | null | undefined): string {
  const row = params && typeof params === "object" && !Array.isArray(params) ? params : {};
  const parts: string[] = [];
  for (const key of FINGERPRINT_KEYS) {
    const value = normalizeFilterValue(key, row[key]);
    if (value == null) continue;
    parts.push(`${key}=${value}`);
  }
  return parts.join("|") || "open";
}

/** Active filters with hard vs relaxable roles for SERV's eyes. */
export function classifySearchConstraints(
  params: Record<string, unknown> | null | undefined,
): {
  searched: Record<string, string | number>;
  roles: SearchConstraintRole[];
  hardKeys: SearchFilterKey[];
  relaxableKeys: SearchFilterKey[];
} {
  const row = params && typeof params === "object" && !Array.isArray(params) ? params : {};
  const searched: Record<string, string | number> = {};
  const roles: SearchConstraintRole[] = [];
  for (const key of FINGERPRINT_KEYS) {
    const value = normalizeFilterValue(key, row[key]);
    if (value == null) continue;
    searched[key] = value;
    const kind = HARD_KEYS.has(key) ? "hard" : "relaxable";
    roles.push({ key, value, kind });
  }
  return {
    searched,
    roles,
    hardKeys: roles.filter((r) => r.kind === "hard").map((r) => r.key),
    relaxableKeys: roles.filter((r) => r.kind === "relaxable").map((r) => r.key),
  };
}

export type DuplicateSearchInfo = {
  duplicate: true;
  priorCallIndex: number;
  fingerprint: string;
  message: string;
};

/** When this fingerprint already appeared, tell SERV to change approach. */
export function duplicateSearchInfo(
  fingerprint: string,
  priorFingerprints: readonly string[],
): DuplicateSearchInfo | null {
  const priorCallIndex = priorFingerprints.indexOf(fingerprint);
  if (priorCallIndex < 0) return null;
  return {
    duplicate: true,
    priorCallIndex: priorCallIndex + 1,
    fingerprint,
    message:
      `Identical search filters as call #${priorCallIndex + 1} (fingerprint=${fingerprint}). ` +
      "Change at least one relaxable filter (radius, body, model, year, miles, transmission, fuel, drivetrain) before searching again — code will not auto-relax.",
  };
}

/**
 * Cars found for eval/reporting: max provider/funnel-kept count across documented
 * search_listings journal rows (not a hardcoded 0).
 */
export function carsFoundFromSearchJournal(searches: readonly SearchJournalLike[]): number {
  let max = 0;
  for (const row of searches) {
    const fromCount = Number.isFinite(row.resultCount) ? row.resultCount : 0;
    const fromFunnel =
      row.funnel?.reduce((m, step) => (Number.isFinite(step.count) ? Math.max(m, step.count) : m), 0) ??
      0;
    max = Math.max(max, fromCount, fromFunnel);
  }
  return max;
}

/** True when every documented search used the same filters. */
export function allSearchesIdentical(searches: readonly SearchJournalLike[]): boolean {
  if (searches.length < 2) return false;
  const first = fingerprintSearchFilters(searches[0]?.params);
  return searches.every((s) => fingerprintSearchFilters(s.params) === first);
}

/** Rebuild fingerprints from journal tool args (checkpoint resume). */
export function fingerprintsFromSearchJournal(searches: readonly SearchJournalLike[]): string[] {
  return searches.map((s) => fingerprintSearchFilters(s.params));
}
