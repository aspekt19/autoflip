function flagOn(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Scout paid/execution API surface. Default OFF when unset. */
export function isScoutEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return flagOn(env.SCOUT_ENABLED);
}

/** Minimal Scout UI. Default OFF; independent of API so UI cannot imply live runs. */
export function isScoutUiEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return flagOn(env.SCOUT_UI_ENABLED);
}

export function scoutConfigMessage(enabled: boolean): string {
  if (enabled) {
    return "Scout is enabled for this deployment. Live Auto.dev still requires SCOUT_PAID_EXECUTION + server key + hard ceiling + owner allowlist + Upstash monthly remaining (env balance strings are not a grant).";
  }
  return "Scout is disabled (SCOUT_ENABLED default off). No scout run was started.";
}

export {
  isScoutOwnerAllowlistConfigured,
  isScoutOwnerAllowlisted,
  isServPlannerFlagOn,
  ownerMayStartScout,
  parseScoutOwnerAllowlist,
} from "./owner-access";
