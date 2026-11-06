/** Scout paid/execution surface. Default OFF when unset. */
export function isScoutEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.SCOUT_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function scoutConfigMessage(enabled: boolean): string {
  if (enabled) {
    return "Scout is enabled for this deployment. Live provider calls still respect maxProviderCalls and API key/credit gates.";
  }
  return "Scout is disabled (SCOUT_ENABLED default off). No scout run was started.";
}
