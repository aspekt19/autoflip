/**
 * SERV Reasoning model IDs allowed for parent-run controlled comparisons.
 *
 * Mechanism (in-repo evidence only — do not invent undocumented IDs):
 * 1. `BASE_MODEL` in `src/server/serv/profiles.ts` + README `SERV_MODEL` default → `gpt-5.4-mini`
 * 2. Committed measured eval artifacts report dated alias `gpt-5.4-mini-2026-03-17`
 *    (`eval/results/latest.json`, `eval/results/serv-proof-trace.json`)
 * 3. `modelFor()` may append profile feature suffixes (`-serv-multipath`, `-serv-kronos`)
 *    when a profile's `feature` is set. `scout_plan` uses `feature: "none"`, so those
 *    suffixes are stripped from a requested id before dispatch (see `modelFor`).
 *
 * Official docs surface referenced by in-repo working material:
 * `docs/superpowers/specs/2026-11-06-lemonless-scout-design.md` → docs.openserv.ai
 * serv-reasoning `/models`. This catalog does **not** scrape the live docs page;
 * only IDs already evidenced in this repository are listed.
 *
 * This module does not change production defaults. Parent chooses which IDs to run.
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
  kind: "base" | "dated_alias";
  source: string;
  /** What scout_plan would actually send after modelFor(). */
  effectiveForScoutPlan: string;
};

export function listServCompareModels(profileId: ProfileId = "scout_plan"): ServCompareModelEntry[] {
  return SERV_COMPARE_BASE_MODEL_IDS.map((id) => ({
    id,
    kind: id === BASE_MODEL ? ("base" as const) : ("dated_alias" as const),
    source:
      id === BASE_MODEL
        ? "src/server/serv/profiles.ts BASE_MODEL + README SERV_MODEL default"
        : "eval/results/latest.json + eval/results/serv-proof-trace.json reported model",
    effectiveForScoutPlan: modelFor(profileId, id),
  }));
}

/** Parse parent-supplied CSV; unknown IDs rejected (fail closed). */
export function resolveServCompareModelIds(
  raw: string | null | undefined,
  opts?: { profileId?: ProfileId },
): { ok: true; models: ServCompareModelEntry[] } | { ok: false; message: string } {
  const profileId = opts?.profileId ?? "scout_plan";
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
  const unknown = requested.filter((id) => !allowed.has(id));
  if (unknown.length) {
    return {
      ok: false,
      message: `Unsupported SERV_COMPARE_MODELS (not in in-repo catalog): ${unknown.join(", ")}. Allowed: ${[...allowed].join(", ")}`,
    };
  }
  const byId = new Map(catalog.map((m) => [m.id, m]));
  return {
    ok: true,
    models: requested.map((id) => byId.get(id)!),
  };
}

export function servCompareCatalogNote(): string {
  return [
    "Supported comparison model IDs are limited to in-repo evidence:",
    ...listServCompareModels().map(
      (m) => `  - ${m.id} (${m.source}); scout_plan effective=${m.effectiveForScoutPlan}`,
    ),
    "Production default remains BASE_MODEL; this catalog does not swap it.",
  ].join("\n");
}
