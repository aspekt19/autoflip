/**
 * Shared Find delivery → charge gate.
 * Credit is owed on a SERV-chosen listing OR a documented nothing-fits.
 * Incomplete / empty-without-explanation must never charge.
 */
import {
  chargeOutcomeFromAgentSettlement,
  servOutcomeChargesCredit,
  type ServChargeOutcome,
} from "@/domain/serv-boundary";

export type FindDeliveryChargeInput = {
  /** Route/match reported success (ok:true). */
  ok: boolean;
  providerQueriesUsed: number;
  listingCount: number;
  emptyReason?: string | null;
  /**
   * When the agent loop settled: chosen | nothing_fits | incomplete.
   * When omitted, fall back to legacy card-delivery heuristic for match-only paths.
   */
  outcome?: ServChargeOutcome | null;
  /** Chosen VIN when outcome is derived from agent settlement. */
  chosenVin?: string | null;
  /** True when nothing-fits is fully documented (searches + reason). */
  nothingFitsDocumented?: boolean;
  /** True when the agent loop published a settled verdict. */
  agentSettled?: boolean;
};

/**
 * Charge when SERV settled chosen or documented nothing-fits.
 * Without an agent outcome, charge only when real listings were delivered
 * (legacy match path while decidePath is off).
 */
export function findDeliveryChargesCredit(input: FindDeliveryChargeInput): boolean {
  if (!input.ok) return false;

  if (input.outcome != null) {
    return servOutcomeChargesCredit(input.outcome);
  }
  if (input.agentSettled != null || input.nothingFitsDocumented != null || input.chosenVin != null) {
    const outcome = chargeOutcomeFromAgentSettlement({
      chosenVin: input.chosenVin,
      nothingFitsDocumented: Boolean(input.nothingFitsDocumented),
      settled: input.agentSettled !== false,
    });
    return servOutcomeChargesCredit(outcome);
  }

  // Legacy match-only: cards delivered from a real provider query.
  if (input.providerQueriesUsed <= 0) return false;
  if (input.listingCount <= 0) return false;
  if (typeof input.emptyReason === "string" && input.emptyReason.trim()) return false;
  return true;
}
