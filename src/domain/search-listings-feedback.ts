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
   * Provenance role — not a hardcoded key list.
   * hard: shopper set this (origin=user on the stored form bag / UserIntent).
   * relaxable: SERV chose this filter; may change after empty/weak results.
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

/**
 * Form-bag key → search_listings filter keys (naming bridge only).
 * Hardness still comes only from origin=user provenance — not from this map.
 */
const FORM_KEY_TO_SEARCH_KEYS: Record<string, readonly SearchFilterKey[]> = {
  bodyStyles: ["bodyStyle", "bodyFamily"],
};

function isUserOriginCell(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const row = raw as { origin?: unknown; provenance?: unknown };
  const origin = typeof row.origin === "string" ? row.origin : row.provenance;
  return origin === "user" || origin === "form";
}

/**
 * Derive hard search filter keys from the stored user form bag / UserIntent fields.
 * Only origin=user (legacy form) cells count — everything SERV chose is relaxable.
 * No hardcoded HARD_KEYS policy list.
 */
export function hardSearchKeysFromUserBag(
  bag: Record<string, unknown> | null | undefined,
): Set<SearchFilterKey> {
  const hard = new Set<SearchFilterKey>();
  if (!bag) return hard;
  for (const [key, raw] of Object.entries(bag)) {
    if (!isUserOriginCell(raw)) continue;
    const aliased = FORM_KEY_TO_SEARCH_KEYS[key];
    if (aliased) {
      for (const searchKey of aliased) hard.add(searchKey);
      continue;
    }
    if ((FINGERPRINT_KEYS as readonly string[]).includes(key)) {
      hard.add(key as SearchFilterKey);
    }
  }
  return hard;
}

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
  userHardKeys?: ReadonlySet<SearchFilterKey> | readonly SearchFilterKey[] | null,
): {
  searched: Record<string, string | number>;
  roles: SearchConstraintRole[];
  hardKeys: SearchFilterKey[];
  relaxableKeys: SearchFilterKey[];
} {
  const hardSet =
    userHardKeys instanceof Set
      ? userHardKeys
      : new Set<SearchFilterKey>(userHardKeys ?? []);
  const row = params && typeof params === "object" && !Array.isArray(params) ? params : {};
  const searched: Record<string, string | number> = {};
  const roles: SearchConstraintRole[] = [];
  for (const key of FINGERPRINT_KEYS) {
    const value = normalizeFilterValue(key, row[key]);
    if (value == null) continue;
    searched[key] = value;
    const kind = hardSet.has(key) ? "hard" : "relaxable";
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
