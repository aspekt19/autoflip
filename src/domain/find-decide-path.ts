/**
 * Find always uses the one-shot decide path. The next-check loop is gone.
 */
export function findDecidePathEnabled(
  _env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  return true;
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
