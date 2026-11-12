/**
 * Failures expected on current main. U1/U2 (search spec + SERV failure policy)
 * should clear them. Until then the local gate stays green when these are the
 * only failures, and goes red for anything else.
 *
 * A known case that starts passing is reported as cleared. It does not fail the
 * gate — drop it from this list when the fix has landed and the strict gate
 * should cover it.
 */
import type { GoldenCaseId } from "./cases";

export type KnownFailure = {
  summary: string;
  /** Check ids that are allowed to fail for this case on current main. */
  checks: readonly string[];
};

export const KNOWN_FAILURES: Partial<Record<GoldenCaseId, KnownFailure>> = {
  G4: {
    summary: "No recorded inventory, so there is no pick to check as-is recon or the 30-day flag.",
    checks: ["G4.recon", "G4.days"],
  },
};

export type GateDisposition = "pass" | "known_failure" | "known_cleared" | "unexpected";

export function dispositionFor(id: GoldenCaseId, failureIds: readonly string[]): GateDisposition {
  const known = KNOWN_FAILURES[id];
  if (failureIds.length === 0) return known ? "known_cleared" : "pass";
  if (!known) return "unexpected";
  const allowed = new Set(known.checks);
  return failureIds.every((check) => allowed.has(check)) ? "known_failure" : "unexpected";
}
