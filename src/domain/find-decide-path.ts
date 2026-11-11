/**
 * PR B kill-switch: SERV triage → decide → challenge path (replaces next-check loop).
 * Default ON. Set FIND_DECIDE_PATH=0 to keep the legacy next-check loop.
 */

export function findDecidePathEnabled(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): boolean {
  const raw = (env.FIND_DECIDE_PATH ?? "1").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

/**
 * Auto-start one decide call after match when the decide path is on.
 * Mutually exclusive with shouldAutoStartFindNextCheck.
 */
export function shouldAutoStartFindDecide(opts: {
  decidePathEnabled: boolean;
  searchContextToken: string | null | undefined;
  alreadyAutoStartedForToken: string | null | undefined;
}): string | null {
  const token = typeof opts.searchContextToken === "string" ? opts.searchContextToken.trim() : "";
  if (!opts.decidePathEnabled || !token) return null;
  if (opts.alreadyAutoStartedForToken === token) return null;
  return token;
}
