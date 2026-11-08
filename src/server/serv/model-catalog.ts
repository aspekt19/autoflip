/**
 * SERV Reasoning model IDs for parent-run controlled comparisons (t292/t294/t295/t317).
 *
 * ## In-repo catalog (default allowlist)
 * Mechanism — only IDs already evidenced in this repository:
 * 1. `BASE_MODEL` in `src/server/serv/profiles.ts` + README `SERV_MODEL` → `gpt-5.4-mini`
 * 2. Committed eval artifacts report dated alias `gpt-5.4-mini-2026-03-17`
 *    (`eval/results/latest.json`, `eval/results/serv-proof-trace.json`)
 * 3. `modelFor()` may append profile feature suffixes when a profile's `feature` is set.
 *    `scout_plan` uses `feature: "none"` (suffixes stripped from a requested id).
 *
 * ## Fair cross-provider slate (docs-sourced; Flip live only)
 * Public SERV Models page API IDs (https://docs.openserv.ai/serv-reasoning/models):
 *   - `gpt-5.4-mini` (OpenAI — production baseline)
 *   - `claude-sonnet-4.6` (Anthropic Sonnet peer)
 *   - `gemini-2.5-flash` (Google Gemini peer; chat/completions only)
 * Enabled via `SCOUT_COMPARE_FAIR_SLATE=1` or explicit `SERV_COMPARE_MODELS`.
 * These are **docs API IDs**, not a console scrape and not a claim Flip's
 * billing account already has them enabled. Flip confirms console match before spend.
 *
 * ## Console vs catalog (do not conflate)
 * OpenServ console Available-models may be broader (e.g. `gpt-6-luna`) with $/M rates.
 * This module does **not** scrape console. Other unlisted IDs need
 * `SCOUT_COMPARE_ALLOW_UNLISTED=1`. Budget-conscious ≠ cheapest.
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

/**
 * Fair SAME-scenario cross-provider slate for Flip live compare (t317).
 * Source: docs.openserv.ai/serv-reasoning/models (+ endpoint compatibility).
 * Alternates (docs, not default slate): `claude-sonnet-5`, `claude-sonnet-5.5`,
 * `gemini-3.5-flash` — Flip may swap via SERV_COMPARE_MODELS after console check.
 */
export const SERV_COMPARE_FAIR_SLATE = [
  {
    id: "gpt-5.4-mini",
    provider: "openai" as const,
    role: "baseline_production_default" as const,
    /** scout_plan profile endpoint. */
    requiredEndpoint: "chat" as const,
    docsSource: "https://docs.openserv.ai/serv-reasoning/models",
    protocolNotes: [
      "Production BASE_MODEL — unchanged by this harness.",
      "Known class: cold first-step ~45s timeout under scout_plan.timeoutMs (do not blind-raise).",
    ],
  },
  {
    id: "claude-sonnet-4.6",
    provider: "anthropic" as const,
    role: "sonnet_peer" as const,
    requiredEndpoint: "chat" as const,
    docsSource: "https://docs.openserv.ai/serv-reasoning/models",
    protocolNotes: [
      "Works on /v1/chat/completions and /v1/messages; scout_plan uses chat.",
      "Historically failed on nullable enum `type:['string','null']+enum` — fixed via anyOf[string-enum|null] on toolId/rationaleKind (product A–C; already on this lineage).",
      "HTTP 200 alone ≠ grounded decision — score schemaValid/grounded/recovery/antiLoop/refusals.",
      "Parent SAME-input used claude-sonnet-5.5 (allowlisted via SERV_PROFILE_MODEL_SCOUT_PLAN) — production BASE_MODEL stays Mini until review.",
    ],
  },
  {
    id: "gemini-2.5-flash",
    provider: "google" as const,
    role: "gemini_peer" as const,
    requiredEndpoint: "chat" as const,
    docsSource: "https://docs.openserv.ai/serv-reasoning/models",
    protocolNotes: [
      "Gemini is NOT available on /v1/messages or /v1/responses — must use /v1/chat/completions (scout_plan endpoint=chat ✓).",
      "google-genai SDK generateContent is unsupported — OpenAI-shape chat only.",
      "Score refusals/timeouts/empty/parse-fail honestly; cost remains unknown until billing reconciliation.",
      "Parent Gemini 3.1 Pro Preview: content-null + refusal field; classify content_null_refusal_field + usage aliases — never assert format vs safety RCA; no blind rerun.",
    ],
  },
] as const;

export type ServFairSlateEntry = (typeof SERV_COMPARE_FAIR_SLATE)[number];

export type ServCompareModelEntry = {
  id: string;
  kind: "base" | "dated_alias" | "docs_fair_slate" | "parent_supplied_unlisted";
  source: string;
  /** What scout_plan would actually send after modelFor(). */
  effectiveForScoutPlan: string;
  /** True only when parent opted in with SCOUT_COMPARE_ALLOW_UNLISTED=1. */
  unlistedOptIn: boolean;
  provider?: "openai" | "anthropic" | "google" | "unknown";
  protocolNotes?: readonly string[];
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
    provider: "openai" as const,
  }));
}

export function listServFairSlateModels(profileId: ProfileId = "scout_plan"): ServCompareModelEntry[] {
  return SERV_COMPARE_FAIR_SLATE.map((entry) => ({
    id: entry.id,
    kind: "docs_fair_slate" as const,
    source: `docs fair slate (${entry.docsSource}) — Flip must confirm console enablement before paid run`,
    effectiveForScoutPlan: modelFor(profileId, entry.id),
    unlistedOptIn: false,
    provider: entry.provider,
    protocolNotes: entry.protocolNotes,
  }));
}

/**
 * Parse parent-supplied CSV.
 * - Default / empty → in-repo catalog only (unless fairSlate).
 * - fairSlate + empty → docs fair Mini/Sonnet/Gemini slate.
 * - Unknown IDs → fail closed unless `allowUnlisted` (SCOUT_COMPARE_ALLOW_UNLISTED=1)
 *   OR the id is in the docs fair slate.
 * - Even with allowUnlisted, reject empty/implausible garbage IDs.
 */
export function resolveServCompareModelIds(
  raw: string | null | undefined,
  opts?: { profileId?: ProfileId; allowUnlisted?: boolean; fairSlate?: boolean },
): { ok: true; models: ServCompareModelEntry[] } | { ok: false; message: string } {
  const profileId = opts?.profileId ?? "scout_plan";
  const allowUnlisted = opts?.allowUnlisted === true;
  const fairSlate = opts?.fairSlate === true;
  const catalog = listServCompareModels(profileId);
  const fair = listServFairSlateModels(profileId);
  const fairById = new Map(fair.map((m) => [m.id, m]));
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return { ok: true, models: fairSlate ? fair : catalog };
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
    const fairHit = fairById.get(id);
    if (fairHit) {
      // Docs-sourced fair slate IDs are allowed without ALLOW_UNLISTED when explicitly requested
      // (or when SCOUT_COMPARE_FAIR_SLATE=1). Still not a console-enablement claim.
      out.push(fairHit);
      continue;
    }
    if (!allowUnlisted) {
      return {
        ok: false,
        message: `Unsupported SERV_COMPARE_MODELS (not in in-repo catalog or docs fair slate): ${id}. Allowed in-repo: ${[...catalog.map((m) => m.id)].join(", ")}. Docs fair slate: ${fair.map((m) => m.id).join(", ")} (set SCOUT_COMPARE_FAIR_SLATE=1 or list them in SERV_COMPARE_MODELS). Other console IDs need SCOUT_COMPARE_ALLOW_UNLISTED=1 after Flip validation.`,
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
      provider: "unknown",
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
    "Docs fair slate (SCOUT_COMPARE_FAIR_SLATE=1 or explicit SERV_COMPARE_MODELS):",
    ...listServFairSlateModels().map(
      (m) =>
        `  - ${m.id} [${m.provider}] (${m.source}); scout_plan effective=${m.effectiveForScoutPlan}`,
    ),
    "Console vs catalog: OpenServ console Available-models table may be broader (e.g. gpt-6-luna). Those IDs are NOT auto-allowlisted — no scrape, no cheapest-forced pick.",
    "Unlisted IDs outside fair slate: SERV_COMPARE_MODELS=… + SCOUT_COMPARE_ALLOW_UNLISTED=1 after Flip console/contract validation.",
    "Budget-conscious ≠ cheapest-at-expense-of-quality — compare recovery/groundedness/refusals/latency, not rate-table shopping.",
    "Model-only swap is NOT the demonstrated fix for the PR63 placeholder-price reject deadlock.",
    "Protocol: Gemini → chat only; Anthropic nullable enums → anyOf (already on lineage); Mini cold-timeout class separate.",
  ].join("\n");
}

/** Protocol issues Flip must treat as integration vs model fault during live compare. */
export function servCompareProtocolIssues(): Array<{
  id: string;
  class: "integration" | "model_behavior" | "unknown_until_live";
  summary: string;
  evidence: string;
}> {
  return [
    {
      id: "anthropic_nullable_enum",
      class: "integration",
      summary:
        "Sonnet historically HTTP 400 on nullable enum type:['string','null']+enum (toolId/rationaleKind).",
      evidence:
        "Fixed product A–C: anyOf[{type:string,enum:[…]},{type:null}] in scout_plan schema; offline strict-json-schema tests. If 400 returns with old shape, that is integration/schema — not model judgment.",
    },
    {
      id: "gemini_endpoint",
      class: "integration",
      summary: "Gemini unsupported on /v1/messages and /v1/responses.",
      evidence:
        "docs.openserv.ai/serv-reasoning/api/compatibility — scout_plan endpoint=chat is correct. A messages/responses path failure is integration, not Gemini quality.",
    },
    {
      id: "servstepid_execution_owned",
      class: "integration",
      summary: "servStepId must be execution-owned (exec:step-N), not model-authored empty string.",
      evidence: "Dropped from request schema; planner binds id. Empty-string failures on old schema were integration.",
    },
    {
      id: "gpt54_cold_timeout",
      class: "unknown_until_live",
      summary: "GPT-5.4 Mini cold first-step ~45007ms = scout_plan.timeoutMs observed historically.",
      evidence:
        "Record as timeout/refusal row; do not blind-raise timeout. Distinguish abort-after-timeout (integration bound) vs empty/refusal (model/upstream).",
    },
    {
      id: "grounding_vs_http200",
      class: "model_behavior",
      summary: "HTTP 200 + schemaValid ≠ grounded recovery.",
      evidence:
        "Score grounded/recoveryClass/antiLoopSafe/claimsVehicleDefectFromPlaceholder. Prefer inventory.search / honest abstain / grounded reject over loop.",
    },
    {
      id: "sequential_xor_bound",
      class: "integration",
      summary: "SCOUT_COMPARE_SEQUENTIAL=1 must XOR with normal compare (≤2 HTTP total).",
      evidence:
        "66b151e breach was 5 HTTP (3 normal + 2 sequential). compare-cli-dispatch XOR — composition bug was harness integration, not model.",
    },
  ];
}
