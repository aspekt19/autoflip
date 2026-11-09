/**
 * Pure helpers for Find next-check UI initiation (ordinary NL→Find path).
 */

/** When SERV is keyed, auto-start next-check once per searchContextToken. */
export function shouldAutoStartFindNextCheck(opts: {
  servNextCheckEnabled: boolean;
  searchContextToken: string | null | undefined;
  alreadyAutoStartedForToken: string | null | undefined;
}): string | null {
  const token = typeof opts.searchContextToken === "string" ? opts.searchContextToken.trim() : "";
  if (!opts.servNextCheckEnabled || !token) return null;
  if (opts.alreadyAutoStartedForToken === token) return null;
  return token;
}

/**
 * Free-gov continuation reasons must keep the client chain alive even when a step
 * fell back to deterministic (`autonomousServ: false`). Requiring autonomous SERV
 * here was the live regression: server said continue, UI froze on partial coverage.
 */
const FREE_GOV_CONTINUE_REASONS = new Set(["evidence_changed_replan", "remaining_free_checks"]);

/**
 * After a step, continue automatically when server loop says so (evidence→replan).
 * No hidden step quota — server stop reasons are authoritative.
 */
export function shouldAutoContinueFindNextCheck(opts: {
  servNextCheckEnabled: boolean;
  autonomousServ: boolean;
  searchContextToken: string | null | undefined;
  loop: { continue: boolean; reason: string } | null | undefined;
}): boolean {
  const token = typeof opts.searchContextToken === "string" ? opts.searchContextToken.trim() : "";
  if (!opts.servNextCheckEnabled || !token) return false;
  if (!opts.loop?.continue) return false;
  if (FREE_GOV_CONTINUE_REASONS.has(opts.loop.reason)) return true;
  return Boolean(opts.autonomousServ);
}

/**
 * Rematch refine must come from server replan / NEW need — never same-tick UI year fields.
 */
export function rematchRefineFromReplan(input: {
  replanRefine: { yearMin?: number; yearMax?: number; make?: string; model?: string };
  needAfter: { yearMin?: number | null; yearMax?: number | null };
  /** Stale UI drafts — ignored for year authority. */
  uiYearMin?: string;
  uiYearMax?: string;
}): { yearMin?: number; yearMax?: number; make?: string; model?: string } {
  return {
    make: input.replanRefine.make || undefined,
    model: input.replanRefine.model || undefined,
    yearMin: input.replanRefine.yearMin ?? input.needAfter.yearMin ?? undefined,
    yearMax: input.replanRefine.yearMax ?? input.needAfter.yearMax ?? undefined,
  };
}
