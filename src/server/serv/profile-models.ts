/**
 * Reversible per-profile SERV model configuration (t317).
 *
 * Production default is BASE_MODEL (`gemini-3.1-pro-preview`) for all SERV steps.
 * Schema / structured-output failures fall back once to SCHEMA_FALLBACK_MODEL (`gpt-5.6-sol`).
 * Parent may opt a single profile onto an allowlisted candidate (e.g. Sonnet 5.5
 * for scout_plan) via env without a blanket BASE_MODEL flip.
 *
 * Priority for the base id (before modelFor feature suffixes):
 *   1. SERV_PROFILE_MODEL_<PROFILE> (e.g. SERV_PROFILE_MODEL_SCOUT_PLAN=claude-sonnet-5.5)
 *      — beats global SERV_MODEL so Sonnet can be tried on scout_plan alone
 *   2. Explicit caller `requested` (deps.model / safe-execute SERV_MODEL)
 *   3. BASE_MODEL (shared production default — gemini-3.1-pro-preview)
 *
 * Unlisted ids fail closed unless SERV_PROFILE_MODEL_ALLOW_UNLISTED=1.
 */

import { BASE_MODEL, SCHEMA_FALLBACK_MODEL, modelFor, type ProfileId } from "./profiles";

/**
 * Docs + parent-evidenced candidates for product profiles.
 * Sonnet 5.5: parent SAME-input D1 grounded reject + D2 abstain (HTTP 200).
 * Gemini 3.1 Pro Preview: production BASE_MODEL; Sol is SCHEMA_FALLBACK_MODEL.
 */
export const SERV_PROFILE_MODEL_CANDIDATES: Partial<Record<ProfileId, readonly string[]>> = {
  scout_plan: [
    "gemini-3.1-pro-preview",
    "gpt-5.6-sol",
    "gpt-5.4-mini",
    "claude-sonnet-5.5",
    "claude-sonnet-4.6",
    "claude-fable-5",
    "gpt-6.1-sol",
    "claude-opus-5.5",
    "gemini-2.5-flash",
  ],
  // Fable EXCLUDED (owner): Sonnet/GPT first-class via SERV_PROFILE_MODEL_FIND_NEXT_CHECK.
  find_next_check: [
    "gemini-3.1-pro-preview",
    "gpt-5.6-sol",
    "gpt-5.4-mini",
    "claude-sonnet-5.5",
    "claude-sonnet-4.6",
    "gpt-6.1-sol",
    "claude-opus-5.5",
  ],
  need_extract: [
    "gemini-3.1-pro-preview",
    "gpt-5.6-sol",
    "gpt-5.4-mini",
    "claude-sonnet-5.5",
    "claude-sonnet-4.6",
    "claude-fable-5",
    "gpt-6.1-sol",
    "claude-opus-5.5",
  ],
  verdict_decide: [
    "gemini-3.1-pro-preview",
    "gpt-5.6-sol",
    "gpt-5.4-mini",
    "claude-sonnet-5.5",
    "claude-sonnet-4.6",
    "claude-fable-5",
    "gpt-6.1-sol",
    "claude-opus-5.5",
  ],
};

export type ProfileModelSource = "caller_requested" | "profile_env" | "base_default";

export type ResolvedProfileModel = {
  /** Base id before kronos/multipath suffix. */
  baseId: string;
  /** Effective id after modelFor(). */
  effectiveId: string;
  source: ProfileModelSource;
  /** True when this is not the production BASE_MODEL default path. */
  overrideActive: boolean;
  honesty: string;
};

function envKeyForProfile(id: ProfileId): string {
  return `SERV_PROFILE_MODEL_${id.toUpperCase()}`;
}

function isPlausible(id: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id);
}

/**
 * Resolve which base model a profile should use. Reversible: unset profile env →
 * BASE_MODEL (or global SERV_MODEL via caller).
 */
export type ResolveProfileModelResult =
  | ({ ok: true } & ResolvedProfileModel)
  | { ok: false; message: string };

export function resolveProfileBaseModel(
  id: ProfileId,
  opts?: {
    requested?: string | null;
    env?: Record<string, string | undefined>;
    allowUnlisted?: boolean;
  },
): ResolveProfileModelResult {
  const env = opts?.env ?? process.env;
  const allowUnlisted =
    opts?.allowUnlisted === true || env.SERV_PROFILE_MODEL_ALLOW_UNLISTED === "1";
  const candidates = new Set(SERV_PROFILE_MODEL_CANDIDATES[id] ?? [BASE_MODEL]);
  // Shared default + schema fallback are always allowlisted for every profile.
  candidates.add(BASE_MODEL);
  candidates.add(SCHEMA_FALLBACK_MODEL);
  const profileRaw = env[envKeyForProfile(id)];
  const profileEnv = typeof profileRaw === "string" && profileRaw.trim() ? profileRaw.trim() : null;
  const requested =
    typeof opts?.requested === "string" && opts.requested.trim() ? opts.requested.trim() : null;

  const pick = (baseId: string, source: ProfileModelSource): ResolveProfileModelResult => {
    if (!isPlausible(baseId)) {
      return { ok: false, message: `Profile model id failed shape check: ${JSON.stringify(baseId)}` };
    }
    const stripped = baseId.replace(/-serv-(kronos-multipath|multipath-kronos|multipath|kronos)$/i, "");
    if (!candidates.has(stripped) && !allowUnlisted) {
      return {
        ok: false,
        message: `Unsupported model ${stripped} for profile ${id}. Allowlisted: ${[...candidates].join(", ")}. Set SERV_PROFILE_MODEL_ALLOW_UNLISTED=1 only after Flip console validation.`,
      };
    }
    const effectiveId = modelFor(id, stripped);
    return {
      ok: true,
      baseId: stripped,
      effectiveId,
      source,
      overrideActive: stripped !== BASE_MODEL,
      honesty:
        stripped === BASE_MODEL
          ? `Production default BASE_MODEL=${BASE_MODEL} for ${id}.`
          : `Reversible profile override for ${id}: ${stripped} (source=${source}). Production BASE_MODEL remains ${BASE_MODEL} until independent review + parent cycle.`,
    };
  };

  // Profile env beats global SERV_MODEL so scout_plan can try Sonnet without flipping Flip.
  if (profileEnv) return pick(profileEnv, "profile_env");
  if (requested) return pick(requested, "caller_requested");
  return pick(BASE_MODEL, "base_default");
}

/** Convenience: always returns a model string or throws fail-closed message. */
export function requireProfileBaseModel(
  id: ProfileId,
  opts?: Parameters<typeof resolveProfileBaseModel>[1],
): ResolvedProfileModel {
  const resolved = resolveProfileBaseModel(id, opts);
  if (!resolved.ok) throw new Error(resolved.message);
  const { ok: _ok, ...rest } = resolved;
  return rest;
}
