/**
 * Find next-check choice parsing / allowlist alignment (ordinary Find).
 *
 * Live PR80 failure: static JSON-schema enum listed ALL FIND_NEXT_CHECK_IDS while
 * runtime allowlist is a ≤6 subset from proposeFindNextChecks. Constrained decoding
 * can emit a schema-valid id that fails clamp → schema_mismatch/check_id_not_in_allowlist.
 *
 * Fix: request schema enum = current allowedChecks only. Known Scout tool aliases map
 * to free_gov_* (same public NHTSA tools) — not blind coerce of arbitrary strings.
 */

import {
  FIND_NEXT_CHECK_IDS,
  clampFindNextCheckId,
  type FindNextCheckId,
} from "./find-next-checks";

/** Documented Scout free-gov toolId → Find checkId (same NHTSA families). */
export const FIND_NEXT_CHECK_SCOUT_ALIASES: Readonly<Record<string, FindNextCheckId>> = {
  "evidence.gov_recalls": "free_gov_recalls",
  "evidence.gov_vpic": "free_gov_vpic",
  "evidence.gov_safety": "free_gov_safety",
  "evidence.gov_fuel": "free_gov_fuel",
  gov_recalls: "free_gov_recalls",
  gov_vpic: "free_gov_vpic",
  gov_safety: "free_gov_safety",
  gov_fuel: "free_gov_fuel",
};

const DENIED_ID_SHAPE = /^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,63}$/;

/** Bound non-secret identifier for diagnostics — never raw model prose. */
export function sanitizeDeniedCheckId(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t) return null;
  if (!DENIED_ID_SHAPE.test(t)) return "<non_conforming_id>";
  return t.slice(0, 64);
}

export function normalizeFindNextCheckChoiceId(raw: string): string {
  const t = raw.trim();
  const aliased = FIND_NEXT_CHECK_SCOUT_ALIASES[t];
  return aliased ?? t;
}

export type FindNextCheckClampDiag = {
  rawCheckId: string | null;
  normalizedCheckId: string | null;
  deniedCheckId: string | null;
  aliasApplied: string | null;
  allowlistIds: FindNextCheckId[];
  clamped: FindNextCheckId | null;
  reasonCode: "ok" | "check_id_not_in_allowlist" | "empty_check_id";
};

export function clampFindNextCheckChoice(
  rawCheckId: string | null | undefined,
  allowed: readonly FindNextCheckId[],
): FindNextCheckClampDiag {
  const allowlistIds = [...allowed];
  if (typeof rawCheckId !== "string" || !rawCheckId.trim()) {
    return {
      rawCheckId: null,
      normalizedCheckId: null,
      deniedCheckId: null,
      aliasApplied: null,
      allowlistIds,
      clamped: null,
      reasonCode: "empty_check_id",
    };
  }
  const raw = rawCheckId.trim();
  const normalized = normalizeFindNextCheckChoiceId(raw);
  const aliasApplied =
    normalized !== raw && FIND_NEXT_CHECK_SCOUT_ALIASES[raw] ? `${raw}→${normalized}` : null;
  const clamped = clampFindNextCheckId(normalized, allowed);
  if (clamped) {
    return {
      rawCheckId: sanitizeDeniedCheckId(raw),
      normalizedCheckId: normalized,
      deniedCheckId: null,
      aliasApplied,
      allowlistIds,
      clamped,
      reasonCode: "ok",
    };
  }
  return {
    rawCheckId: sanitizeDeniedCheckId(raw),
    normalizedCheckId: sanitizeDeniedCheckId(normalized),
    deniedCheckId: sanitizeDeniedCheckId(normalized),
    aliasApplied,
    allowlistIds,
    clamped: null,
    reasonCode: "check_id_not_in_allowlist",
  };
}

/**
 * Strict JSON schema for find_next_check — enum MUST be the live allowlist subset,
 * not the full FIND_NEXT_CHECK_IDS catalog (avoids constrained-decoding off-allowlist picks).
 * targetKeys is required and nullable. When top-5 keys exist, items are that enum (max 3).
 */
export function buildFindNextCheckChoiceSchema(
  allowedIds: readonly FindNextCheckId[],
  targetKeyEnum: readonly string[] = [],
): {
  name: string;
  schema: Record<string, unknown>;
} {
  const ids = allowedIds.length > 0 ? [...allowedIds] : [...FIND_NEXT_CHECK_IDS];
  const keys = [...new Set(targetKeyEnum.map((key) => key.trim()).filter(Boolean))].slice(0, 5);
  const targetKeys =
    keys.length === 0
      ? { type: "null" }
      : {
          anyOf: [
            { type: "null" },
            {
              type: "array",
              maxItems: 3,
              items: { type: "string", enum: keys },
            },
          ],
        };
  return {
    name: "find_next_check_choice",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        checkId: {
          type: "string",
          enum: ids,
          description:
            "Must be copied verbatim from facts.allowedChecks. Choose the check most likely to change which car is picked.",
        },
        note: { type: "string" },
        targetKeys,
      },
      required: ["checkId", "note", "targetKeys"],
    },
  };
}

/** Keep only keys in the current top 5, at most 3. Unknown keys drop. */
export function clampFindNextCheckTargetKeys(
  raw: readonly string[] | null | undefined,
  allowedKeys: readonly string[],
): string[] {
  const allowed = new Set(allowedKeys);
  const out: string[] = [];
  for (const key of raw ?? []) {
    if (typeof key !== "string") continue;
    const trimmed = key.trim();
    if (!trimmed || !allowed.has(trimmed) || out.includes(trimmed)) continue;
    out.push(trimmed);
    if (out.length >= 3) break;
  }
  return out;
}

export function parseFindNextCheckChoice(
  text: string,
): { checkId: string; note: string; targetKeys: string[] | null } | null {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const raw = JSON.parse(trimmed.slice(start, end + 1)) as {
      checkId?: unknown;
      note?: unknown;
      targetKeys?: unknown;
    };
    if (typeof raw.checkId !== "string" || !raw.checkId.trim()) return null;
    let targetKeys: string[] | null = null;
    if (Array.isArray(raw.targetKeys)) {
      targetKeys = raw.targetKeys
        .filter((key): key is string => typeof key === "string" && key.trim().length > 0)
        .map((key) => key.trim())
        .slice(0, 3);
    }
    return {
      checkId: raw.checkId.trim(),
      note: typeof raw.note === "string" ? raw.note.trim().slice(0, 280) : "",
      targetKeys,
    };
  } catch {
    return null;
  }
}
