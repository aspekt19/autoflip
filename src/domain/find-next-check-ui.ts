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
 * Hard ceiling on client auto-continues per search token.
 * Sized for a large shortlist (e.g. ~14 MMY × 4 free tools ÷ batch 3 ≈ 19 steps)
 * with headroom for rematch/compare — never an unbounded spinner loop.
 */
export const FIND_NEXT_CHECK_AUTO_CONTINUE_MAX = 48;

/**
 * After a step, continue automatically when server loop says so (evidence→replan).
 * Free-gov continue reasons keep working after deterministic fallback.
 * Bound auto-continues so a stuck server disposition cannot spin forever.
 */
export function shouldAutoContinueFindNextCheck(opts: {
  servNextCheckEnabled: boolean;
  autonomousServ: boolean;
  searchContextToken: string | null | undefined;
  loop: { continue: boolean; reason: string } | null | undefined;
  /** How many auto-continues already fired for this search token (0 on first step). */
  autoContinueCount?: number;
  autoContinueMax?: number;
}): boolean {
  const token = typeof opts.searchContextToken === "string" ? opts.searchContextToken.trim() : "";
  if (!opts.servNextCheckEnabled || !token) return false;
  if (!opts.loop?.continue) return false;
  const count = Math.max(0, Math.floor(opts.autoContinueCount ?? 0));
  const max = Math.max(1, Math.floor(opts.autoContinueMax ?? FIND_NEXT_CHECK_AUTO_CONTINUE_MAX));
  if (count >= max) return false;
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
