/**
 * Production SERV model resolution.
 *
 * Every profile resolves to BASE_MODEL (`gpt-6.1-sol`) unless the caller passes an
 * explicit `requested` model (typically `SERV_MODEL` / deps.model) or a per-profile
 * `SERV_PROFILE_MODEL_<PROFILE>` env override. Non-BASE_MODEL ids fail closed unless
 * `SERV_PROFILE_MODEL_ALLOW_UNLISTED=1` (compare / Flip console validation only).
 *
 * Priority for the base id (before modelFor feature suffixes):
 *   1. SERV_PROFILE_MODEL_<PROFILE>
 *   2. Explicit caller `requested` (deps.model / SERV_MODEL)
 *   3. BASE_MODEL (shared production default — gpt-6.1-sol)
 */

import { BASE_MODEL, modelFor, type ProfileId } from "./profiles";

/**
 * Production allowlist: gpt-6.1-sol only (including Find C2–C4 decide profiles).
 * Compare peers (Sonnet, Mini, prior Sol, Gemini, …) require ALLOW_UNLISTED —
 * they are not tried first and are not production defaults.
 */
export const SERV_PROFILE_MODEL_CANDIDATES: Partial<Record<ProfileId, readonly string[]>> = {
  find_plan: [BASE_MODEL],
  find_triage: [BASE_MODEL],
  find_decide: [BASE_MODEL],
  find_challenge: [BASE_MODEL],
  verdict_decide: [BASE_MODEL],
  verdict_challenge: [BASE_MODEL],
  resale_plan_search: [BASE_MODEL],
  resale_triage: [BASE_MODEL],
  resale_pick: [BASE_MODEL],
  resale_challenge: [BASE_MODEL],
  radar_review: [BASE_MODEL],
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
 * Resolve which base model a profile should use. Reversible: unset overrides → BASE_MODEL.
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
  // Shared default is always allowlisted for every profile.
  candidates.add(BASE_MODEL);
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
          : `Reversible override for ${id}: ${stripped} (source=${source}). Production BASE_MODEL remains ${BASE_MODEL}.`,
    };
  };

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
