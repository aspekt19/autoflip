/**
 * Whether a assembled report may debit 1 credit.
 *
 * Incident-class: fee/placeholder/suspicious or otherwise missing purchase ask /
 * miles — data unusable for the promised price/budget analysis → refuse, 0 debit.
 *
 * Legitimate reports with honest *noncritical* unknowns (recalls unavailable,
 * insufficient comps withhold after a usable ask+miles, identity withhold, etc.)
 * remain chargeable. Do not declare every unknown fact unusable.
 */
import type { ComputedReport } from "@/domain/types";

export type ReportChargeOutcome =
  | "deliverable"
  | "refused_unusable_purchase_ask"
  | "refused_missing_critical_input";

export type ReportChargeDecision =
  | { charge: true; outcome: "deliverable" }
  | {
      charge: false;
      outcome: "refused_unusable_purchase_ask" | "refused_missing_critical_input";
      error: "unusable_purchase_ask" | "missing_critical_input";
      message: string;
    };

const UNUSABLE_ASK_NOTE =
  /not treated as a verified vehicle purchase ask/i;

export function decideReportCharge(report: ComputedReport): ReportChargeDecision {
  const priceUsd = report.subject.priceUsd;
  const miles = report.subject.miles;
  const unusableAskNoted = report.dataNotes.some((n) => UNUSABLE_ASK_NOTE.test(n));

  if (priceUsd == null) {
    if (unusableAskNoted) {
      return {
        charge: false,
        outcome: "refused_unusable_purchase_ask",
        error: "unusable_purchase_ask",
        message:
          "The listing feed did not provide a usable vehicle purchase ask (fee, placeholder, or unverified figure). Full price and budget analysis cannot run. No credit was charged.",
      };
    }
    return {
      charge: false,
      outcome: "refused_missing_critical_input",
      error: "missing_critical_input",
      message:
        "No asking price was available for this vehicle, so full price analysis cannot run. No credit was charged.",
    };
  }

  if (miles == null) {
    return {
      charge: false,
      outcome: "refused_missing_critical_input",
      error: "missing_critical_input",
      message:
        "Mileage is missing, so the price could not be adjusted to this car. No credit was charged.",
    };
  }

  return { charge: true, outcome: "deliverable" };
}
