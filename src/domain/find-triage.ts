/**
 * C2 Find triage — SERV find_triage output types and validation.
 * Keys must be in the pool; shortlist is clamped to 3–8; evidence ids are filtered.
 */

export const FIND_TRIAGE_REJECT_REASONS = [
  "over_budget_soft",
  "wrong_body",
  "wrong_drivetrain",
  "high_risk",
  "overpriced",
  "weak_fit",
  "duplicate",
] as const;
export type FindTriageRejectReason = (typeof FIND_TRIAGE_REJECT_REASONS)[number];

export const FIND_TRIAGE_CHECKS = ["vin_decode_consistency", "read_listing_page"] as const;
export type FindTriageCheck = (typeof FIND_TRIAGE_CHECKS)[number];

export type FindTriageShortlistItem = {
  key: string;
  reason: string;
  evidenceIds: string[];
};

export type FindTriageRejectedItem = {
  key: string;
  reason: FindTriageRejectReason;
};

export type FindTriagePerCarCheck = {
  key: string;
  check: FindTriageCheck;
};

export type FindTriageRevisit = {
  needed: boolean;
  why: string | null;
  addModels: Array<{ make: string; model: string }>;
  widenRadiusMiles: number | null;
};

export type FindTriage = {
  shortlist: FindTriageShortlistItem[];
  rejected: FindTriageRejectedItem[];
  perCarChecks: FindTriagePerCarCheck[];
  revisit: FindTriageRevisit;
};

export type FindTriageIssue = { field: string; message: string };

export type ValidateFindTriageResult =
  | { ok: true; triage: FindTriage; dropped: string[] }
  | { ok: false; issues: FindTriageIssue[] };

export type ValidateFindTriageContext = {
  poolKeys: ReadonlySet<string> | readonly string[];
  allowedEvidenceIds: ReadonlySet<string> | readonly string[];
  /** When true, a revisit was already used this Find — force needed false. */
  revisitAlreadyUsed?: boolean;
};

const REJECT_SET = new Set<string>(FIND_TRIAGE_REJECT_REASONS);
const CHECK_SET = new Set<string>(FIND_TRIAGE_CHECKS);

const SHORTLIST_MIN = 3;
const SHORTLIST_MAX = 8;

function asSet(input: ReadonlySet<string> | readonly string[]): Set<string> {
  return input instanceof Set ? new Set(input) : new Set(input);
}

function filterEvidenceIds(claimed: unknown, allowed: Set<string>, dropped: string[], field: string): string[] {
  if (!Array.isArray(claimed)) return [];
  const out: string[] = [];
  for (const raw of claimed) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!id) continue;
    if (!allowed.has(id)) {
      dropped.push(`${field}:${id}`);
      continue;
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Validate and sanitize a raw find_triage payload.
 * Unknown top-level / row keys are ignored (dropped). Shortlist must end with
 * min(3, poolSize)–8 pool keys — small pools may return 2 keys when that is all that exists.
 */
export function validateFindTriage(
  input: unknown,
  ctx: ValidateFindTriageContext,
): ValidateFindTriageResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, issues: [{ field: "triage", message: "find_triage must be an object." }] };
  }
  const raw = input as Record<string, unknown>;
  const pool = asSet(ctx.poolKeys);
  const allowed = asSet(ctx.allowedEvidenceIds);
  const dropped: string[] = [];
  // Tolerate unknown top-level keys — do not fail the whole triage for extras.
  const shortlistMin = Math.min(SHORTLIST_MIN, Math.max(1, pool.size));

  const shortlistRaw = Array.isArray(raw.shortlist) ? raw.shortlist : [];
  const shortlist: FindTriageShortlistItem[] = [];
  const seen = new Set<string>();
  for (const [index, item] of shortlistRaw.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const key = typeof row.key === "string" ? row.key.trim() : "";
    if (!key || !pool.has(key)) {
      dropped.push(`shortlist[${index}].key`);
      continue;
    }
    if (seen.has(key)) {
      dropped.push(`shortlist[${index}].duplicate`);
      continue;
    }
    seen.add(key);
    const reason = typeof row.reason === "string" ? row.reason.trim().slice(0, 280) : "";
    shortlist.push({
      key,
      reason: reason || "Shortlisted.",
      evidenceIds: filterEvidenceIds(row.evidenceIds, allowed, dropped, `shortlist[${index}].evidenceIds`),
    });
    if (shortlist.length >= SHORTLIST_MAX) break;
  }

  if (shortlist.length < shortlistMin) {
    return {
      ok: false,
      issues: [
        {
          field: "shortlist",
          message: `find_triage.shortlist needs ${shortlistMin}–${SHORTLIST_MAX} pool keys (got ${shortlist.length}; pool has ${pool.size}).`,
        },
      ],
    };
  }

  const shortlistKeys = new Set(shortlist.map((row) => row.key));
  const rejected: FindTriageRejectedItem[] = [];
  const rejectedRaw = Array.isArray(raw.rejected) ? raw.rejected : [];
  for (const [index, item] of rejectedRaw.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const key = typeof row.key === "string" ? row.key.trim() : "";
    if (!key || !pool.has(key) || shortlistKeys.has(key)) {
      dropped.push(`rejected[${index}].key`);
      continue;
    }
    const reason = typeof row.reason === "string" ? row.reason.trim() : "";
    if (!REJECT_SET.has(reason)) {
      dropped.push(`rejected[${index}].reason`);
      continue;
    }
    rejected.push({ key, reason: reason as FindTriageRejectReason });
  }

  const perCarChecks: FindTriagePerCarCheck[] = [];
  const checksRaw = Array.isArray(raw.perCarChecks) ? raw.perCarChecks : [];
  for (const [index, item] of checksRaw.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const key = typeof row.key === "string" ? row.key.trim() : "";
    if (!key || !shortlistKeys.has(key)) {
      dropped.push(`perCarChecks[${index}].key`);
      continue;
    }
    const check = typeof row.check === "string" ? row.check.trim() : "";
    if (!CHECK_SET.has(check)) {
      dropped.push(`perCarChecks[${index}].check`);
      continue;
    }
    if (perCarChecks.some((c) => c.key === key && c.check === check)) continue;
    perCarChecks.push({ key, check: check as FindTriageCheck });
  }

  const revisitRaw =
    raw.revisit && typeof raw.revisit === "object" && !Array.isArray(raw.revisit)
      ? (raw.revisit as Record<string, unknown>)
      : {};
  let needed = revisitRaw.needed === true;
  if (needed && ctx.revisitAlreadyUsed) {
    dropped.push("revisit.needed");
    needed = false;
  }
  const why =
    typeof revisitRaw.why === "string" && revisitRaw.why.trim()
      ? revisitRaw.why.trim().slice(0, 280)
      : null;
  const addModels: Array<{ make: string; model: string }> = [];
  if (needed && Array.isArray(revisitRaw.addModels)) {
    for (const item of revisitRaw.addModels) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      const make = typeof row.make === "string" ? row.make.trim() : "";
      const model = typeof row.model === "string" ? row.model.trim() : "";
      if (!make || !model) continue;
      addModels.push({ make, model });
    }
  }
  const widenRaw =
    typeof revisitRaw.widenRadiusMiles === "number" && Number.isFinite(revisitRaw.widenRadiusMiles)
      ? Math.round(revisitRaw.widenRadiusMiles)
      : null;
  const widenRadiusMiles = needed && widenRaw != null && widenRaw > 0 ? widenRaw : null;

  return {
    ok: true,
    triage: {
      shortlist,
      rejected,
      perCarChecks,
      revisit: {
        needed,
        why: needed ? why : null,
        addModels: needed ? addModels : [],
        widenRadiusMiles,
      },
    },
    dropped,
  };
}
