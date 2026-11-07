/**
 * Owner-only Scout access — independent of PR54 Auth.js.
 * Existing af_ API keys remain the credential; this allowlist scopes who may
 * open the production live path when SCOUT_OWNER_USER_IDS is set.
 */

function flagOn(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Comma/whitespace-separated Lemonless userIds (from af_ key resolve). Empty = unset. */
export function parseScoutOwnerAllowlist(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const raw = env.SCOUT_OWNER_USER_IDS?.trim();
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(/[,;\s]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

export function isScoutOwnerAllowlistConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return parseScoutOwnerAllowlist(env).length > 0;
}

export function isScoutOwnerAllowlisted(
  userId: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const list = parseScoutOwnerAllowlist(env);
  if (!list.length) return false;
  return list.includes(userId);
}

/**
 * When allowlist is configured, only listed owners may start Scout.
 * When unset, any valid af_ key may start (fixture/offline); live authority still requires allowlist.
 */
export function ownerMayStartScout(
  userId: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!isScoutOwnerAllowlistConfigured(env)) return true;
  return isScoutOwnerAllowlisted(userId, env);
}

export function isServPlannerFlagOn(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return flagOn(env.SCOUT_ALLOW_SERV_PLANNER);
}

/** Optional per-run call cap for owner live path (default 3). Not an env balance grant. */
export function ownerMaxProviderCallsPerRun(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.SCOUT_OWNER_MAX_PROVIDER_CALLS_PER_RUN?.trim();
  const n = raw ? Number(raw) : 3;
  if (!Number.isFinite(n) || n < 1) return 3;
  return Math.min(20, Math.floor(n));
}
