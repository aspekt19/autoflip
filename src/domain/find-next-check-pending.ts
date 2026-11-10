/**
 * Buyer-facing pending line for Find next-check hops.
 * Never leave “Checking public safety records…” up after pause/failure —
 * show the current step while running, or the real server reason when terminal.
 */

export function findNextCheckPendingLabel(input: {
  pending: boolean;
  auto?: boolean;
  progressLine?: string | null;
  terminalReason?: string | null;
}): string | null {
  if (input.terminalReason?.trim()) return input.terminalReason.trim();
  if (!input.pending) return null;
  if (input.progressLine?.trim()) return input.progressLine.trim();
  return input.auto ? "Continuing the next public check…" : "Running the next public check…";
}

/** Banned legacy spinner — must not appear as the only pending copy. */
export const LEGACY_PUBLIC_SAFETY_SPINNER = "Checking public safety records…";
