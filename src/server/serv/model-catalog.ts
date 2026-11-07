/**
 * SERV Reasoning model IDs for parent-run controlled comparisons (t292/t294/t295).
 *
 * ## In-repo catalog (default allowlist)
 * Mechanism — only IDs already evidenced in this repository:
 * 1. `BASE_MODEL` in `src/server/serv/profiles.ts` + README `SERV_MODEL` → `gpt-5.4-mini`
 * 2. Committed eval artifacts report dated alias `gpt-5.4-mini-2026-03-17`
 *    (`eval/results/latest.json`, `eval/results/serv-proof-trace.json`)
 * 3. `modelFor()` may append profile feature suffixes when a profile's `feature` is set.
 *    `scout_plan` uses `feature: "none"` (suffixes stripped from a requested id).
 *
 * ## Console vs catalog (do not conflate)
 * Owner-supplied OpenServ console screenshots show a broader **Available models**
 * table (e.g. `gpt-6-luna`, Claude/Gemini/GPT tiers) with published Input/Cached/Output
 * $/M rates. That console surface is **wider than** this in-repo catalog.
 * This module does **not** scrape console, does **not** hardcode console IDs as
 * verified available for our scout_plan schema contract, and does **not** treat
 * published $/M rows as reconciled run cost (harness cost remains **unknown**).
 *
 * Parent may pass explicit `SERV_COMPARE_MODELS` after their own console/contract
 * validation. Unlisted IDs require `SCOUT_COMPARE_ALLOW_UNLISTED=1` (fail-closed
 * otherwise). Budget-conscious selection ≠ pick the cheapest ID; quality/recovery
 * scoring matters more than rate-table shopping.
 *
 * ## Not a demonstrated product fix
 * Swapping the comparison model alone is **not** the demonstrated fix for the
 * PR63 placeholder-price / reject-grounding failure. Production `BASE_MODEL` /
 * `SERV_MODEL` default stays unchanged by this harness.
 */

import { BASE_MODEL, modelFor, type ProfileId } from "./profiles";

/** Base model strings evidenced in-repo (no feature suffix). */
export const SERV_COMPARE_BASE_MODEL_IDS = [
  BASE_MODEL,
  "gpt-5.4-mini-2026-03-17",
] as const;

export type ServCompareBaseModelId = (typeof SERV_COMPARE_BASE_MODEL_IDS)[number];

export type ServCompareModelEntry = {
  id: string;
  kind: "base" | "dated_alias" | "parent_supplied_unlisted";
  source: string;
  /** What scout_plan would actually send after modelFor(). */
  effectiveForScoutPlan: string;
  /** True only when parent opted in with SCOUT_COMPARE_ALLOW_UNLISTED=1. */
  unlistedOptIn: boolean;
};

/** Loose shape check — not a claim the ID exists on console or passes schema. */
export function isPlausibleServModelId(id: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id);
}

export function listServCompareModels(profileId: ProfileId = "scout_plan"): ServCompareModelEntry[] {
  return SERV_COMPARE_BASE_MODEL_IDS.map((id) => ({
    id,
    kind: id === BASE_MODEL ? ("base" as const) : ("dated_alias" as const),
    source:
      id === BASE_MODEL
        ? "src/server/serv/profiles.ts BASE_MODEL + README SERV_MODEL default"
        : "eval/results/latest.json + eval/results/serv-proof-trace.json reported model",
    effectiveForScoutPlan: modelFor(profileId, id),
    unlistedOptIn: false,
  }));
}

/**
 * Parse parent-supplied CSV.
 * - Default / empty → in-repo catalog only.
 * - Unknown IDs → fail closed unless `allowUnlisted` (SCOUT_COMPARE_ALLOW_UNLISTED=1).
 * - Even with allowUnlisted, reject empty/implausible garbage IDs.
 */
export function resolveServCompareModelIds(
  raw: string | null | undefined,
  opts?: { profileId?: ProfileId; allowUnlisted?: boolean },
): { ok: true; models: ServCompareModelEntry[] } | { ok: false; message: string } {
  const profileId = opts?.profileId ?? "scout_plan";
  const allowUnlisted = opts?.allowUnlisted === true;
  const catalog = listServCompareModels(profileId);
  const allowed = new Set(catalog.map((m) => m.id));
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return { ok: true, models: catalog };
  }
  const requested = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (requested.length === 0) {
    return { ok: false, message: "SERV_COMPARE_MODELS was empty after parse." };
  }

  const byId = new Map(catalog.map((m) => [m.id, m]));
  const out: ServCompareModelEntry[] = [];
  for (const id of requested) {
    const known = byId.get(id);
    if (known) {
      out.push(known);
      continue;
    }
    if (!allowUnlisted) {
      return {
        ok: false,
        message: `Unsupported SERV_COMPARE_MODELS (not in in-repo catalog): ${id}. Allowed: ${[...allowed].join(", ")}. Console may list broader IDs (e.g. gpt-6-luna) — parent must validate against console, then set SCOUT_COMPARE_ALLOW_UNLISTED=1. Do not expand the allowlist blindly; budget-conscious ≠ cheapest.`,
      };
    }
    if (!isPlausibleServModelId(id)) {
      return {
        ok: false,
        message: `SERV_COMPARE_MODELS id failed shape check (garbage rejected even with ALLOW_UNLISTED): ${JSON.stringify(id)}`,
      };
    }
    out.push({
      id,
      kind: "parent_supplied_unlisted",
      source:
        "parent SERV_COMPARE_MODELS + SCOUT_COMPARE_ALLOW_UNLISTED=1 — parent-validated against console; not an in-repo availability claim",
      effectiveForScoutPlan: modelFor(profileId, id),
      unlistedOptIn: true,
    });
  }
  return { ok: true, models: out };
}

export function servCompareCatalogNote(): string {
  return [
    "In-repo catalog (default; production BASE_MODEL unchanged):",
    ...listServCompareModels().map(
      (m) => `  - ${m.id} (${m.source}); scout_plan effective=${m.effectiveForScoutPlan}`,
    ),
    "Console vs catalog: OpenServ console Available-models table is broader (e.g. gpt-6-luna and other tiers with $/M rates). Those IDs are NOT auto-allowlisted here — no scrape, no hardcoded availability/schema claim, no cheapest-forced pick.",
    "Unlisted IDs: SERV_COMPARE_MODELS=… + SCOUT_COMPARE_ALLOW_UNLISTED=1 after parent console/contract validation (fail-closed otherwise).",
    "Budget-conscious ≠ cheapest-at-expense-of-quality — compare recovery/groundedness, not rate-table shopping.",
    "Model-only swap is NOT the demonstrated fix for the PR63 placeholder-price reject deadlock.",
  ].join("\n");
}
