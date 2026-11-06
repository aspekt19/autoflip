import { ASSUMPTIONS } from "./assumptions";
import { budgetFit } from "./budget";
import type { DecisionAction } from "./decision-action";
import type { ComputedReport, Mode } from "./types";

export type GateId =
  | "data_sufficiency"
  | "identity_vin"
  | "safety_red_flags"
  | "price_vs_comps"
  | "mandate_fit";

export type GateStatus = "pass" | "forbid" | "withhold";

export type GateResult = {
  id: GateId;
  status: GateStatus;
  reason: string;
  /** Actions forbidden when status is forbid (or leftover forbids after a withhold). */
  forbid: DecisionAction[];
};

export type MandateInput = {
  budgetUsd?: number | null;
  budgetKnown?: boolean;
  targetProfitUsd?: number | null;
  repairAbility?: "none" | "minor" | "major" | "unknown";
};

export type OrderedGateRun = {
  gates: GateResult[];
  /** True when a gate refused to allow any buy/negotiate/pass decision. */
  withheld: boolean;
  withholdReason: string | null;
  /** Union of forbid lists from non-withholding gates (and safety forbids). */
  forbid: DecisionAction[];
  /** Forced action when safety rails require pass without withholding. */
  forcePass: boolean;
};

const GATE_ORDER: GateId[] = [
  "data_sufficiency",
  "identity_vin",
  "safety_red_flags",
  "price_vs_comps",
  "mandate_fit",
];

/**
 * Deterministic gates in fixed order. A withhold stops further decisioning:
 * the report shows WITHHELD with that reason instead of a best-guess verdict.
 * Later gates still run for transparency when not withheld, except we stop
 * accumulating decision forbids after the first withhold.
 */
export function runOrderedGates(
  report: ComputedReport,
  mandate: MandateInput = {},
): OrderedGateRun {
  const gates: GateResult[] = [];
  let withheld = false;
  let withholdReason: string | null = null;
  const forbid = new Set<DecisionAction>();
  let forcePass = false;

  for (const id of GATE_ORDER) {
    const result = evaluateGate(id, report, mandate);
    gates.push(result);
    if (result.status === "withhold" && !withheld) {
      withheld = true;
      withholdReason = result.reason;
    }
    if (!withheld) {
      for (const action of result.forbid) forbid.add(action);
      if (result.id === "safety_red_flags" && result.status === "forbid" && result.forbid.includes("negotiate")) {
        forcePass = true;
      }
    }
  }

  return {
    gates,
    withheld,
    withholdReason,
    forbid: [...forbid],
    forcePass,
  };
}

function evaluateGate(id: GateId, report: ComputedReport, mandate: MandateInput): GateResult {
  switch (id) {
    case "data_sufficiency":
      return gateDataSufficiency(report);
    case "identity_vin":
      return gateIdentity(report);
    case "safety_red_flags":
      return gateSafety(report);
    case "price_vs_comps":
      return gatePrice(report);
    case "mandate_fit":
      return gateMandate(report, mandate);
  }
}

function gateDataSufficiency(report: ComputedReport): GateResult {
  if (report.subject.priceUsd === null) {
    return {
      id: "data_sufficiency",
      status: "withhold",
      reason: "The listing has no asking price, so Lemonless withholds a buy/negotiate/pass verdict.",
      forbid: ["buy", "negotiate", "pass", "needs_inspection"],
    };
  }
  if (report.subject.miles === null) {
    return {
      id: "data_sufficiency",
      status: "withhold",
      reason: "Mileage is missing, so mileage-adjusted comps cannot be trusted. Verdict withheld.",
      forbid: ["buy", "negotiate", "pass", "needs_inspection"],
    };
  }
  if (report.comps.length < ASSUMPTIONS.minComps) {
    return {
      id: "data_sufficiency",
      status: "withhold",
      reason: `Fewer than ${ASSUMPTIONS.minComps} priced, same-model comparables with mileage. Verdict withheld instead of guessing.`,
      forbid: ["buy", "negotiate", "pass", "needs_inspection"],
    };
  }
  // fairValueUsd can be null for VIN identity conflicts — identity_vin owns that withhold.
  const historyMissing = report.subject.accidentCount === null && report.subject.ownerCount === null;
  if (historyMissing && report.recallsAvailable === false) {
    return {
      id: "data_sufficiency",
      status: "withhold",
      reason: "Accident/owner history and the NHTSA recall lookup are both unavailable. Verdict withheld.",
      forbid: ["buy", "negotiate", "pass", "needs_inspection"],
    };
  }
  return { id: "data_sufficiency", status: "pass", reason: "Enough priced comps and subject price/miles to continue.", forbid: [] };
}

function gateIdentity(report: ComputedReport): GateResult {
  if (report.flags.some((flag) => flag.source === "vin-identity" && flag.level === "stop")) {
    return {
      id: "identity_vin",
      status: "withhold",
      reason: "NHTSA VIN decode conflicts with the listing year/make/model. Verdict withheld until the VIN and title match.",
      forbid: ["buy", "negotiate", "pass", "needs_inspection"],
    };
  }
  return { id: "identity_vin", status: "pass", reason: "No VIN identity conflict was flagged.", forbid: [] };
}

function gateSafety(report: ComputedReport): GateResult {
  if (report.flags.some((flag) => flag.source === "title-brand" && flag.level === "stop")) {
    return {
      id: "safety_red_flags",
      status: "forbid",
      reason: "Listing text indicates a title brand (salvage, rebuilt, flood, or similar). Buy and negotiate are forbidden.",
      forbid: ["buy", "negotiate"],
    };
  }
  if (report.openParkIt) {
    return {
      id: "safety_red_flags",
      status: "forbid",
      reason: "A park-it or park-outside campaign matched this model year. Buy and negotiate are forbidden.",
      forbid: ["buy", "negotiate"],
    };
  }
  if (report.flags.some((flag) => flag.source === "odometer" && flag.level === "caution")) {
    return {
      id: "safety_red_flags",
      status: "forbid",
      reason: "Mileage looks inconsistent with vehicle age. Buy is forbidden until the odometer is verified.",
      forbid: ["buy"],
    };
  }
  return { id: "safety_red_flags", status: "pass", reason: "No title-brand, park-it, or odometer stop fired.", forbid: [] };
}

function gatePrice(report: ComputedReport): GateResult {
  if (report.priceGap !== null && report.priceGap > ASSUMPTIONS.overpricedGap) {
    return {
      id: "price_vs_comps",
      status: "forbid",
      reason: `Asking price is more than ${Math.round(ASSUMPTIONS.overpricedGap * 100)}% above fair value. Buy is forbidden.`,
      forbid: ["buy"],
    };
  }
  if (report.flags.some((flag) => flag.source === "price-anomaly")) {
    return {
      id: "price_vs_comps",
      status: "forbid",
      reason: "Asking price is suspiciously low versus comps. Buy is forbidden until the discount is explained.",
      forbid: ["buy"],
    };
  }
  return { id: "price_vs_comps", status: "pass", reason: "Asking price is within the published gap bands for a decision.", forbid: [] };
}

function gateMandate(report: ComputedReport, mandate: MandateInput): GateResult {
  const mode: Mode = report.mode;
  const price = report.subject.priceUsd;

  if (mode === "personal" && mandate.budgetKnown && typeof mandate.budgetUsd === "number" && price !== null) {
    const fit = budgetFit(price, mandate.budgetUsd);
    if (fit === "over") {
      return {
        id: "mandate_fit",
        status: "forbid",
        reason: `Asking price is over the shopper budget of $${mandate.budgetUsd.toLocaleString("en-US")}. Buy is forbidden.`,
        forbid: ["buy"],
      };
    }
  }

  if (mode === "flip" && report.flip) {
    const target = mandate.targetProfitUsd ?? ASSUMPTIONS.flipDesiredProfitUsd;
    if (report.flip.marginUsd < target) {
      return {
        id: "mandate_fit",
        status: "forbid",
        reason: `Conservative flip margin is below the profit target of $${target.toLocaleString("en-US")}. Buy is forbidden.`,
        forbid: ["buy"],
      };
    }
    if (mandate.repairAbility === "none" && (report.subject.accidentCount ?? 0) >= 1) {
      return {
        id: "mandate_fit",
        status: "forbid",
        reason: "Flip mandate is no repair skill, but the listing reports accidents. Buy is forbidden.",
        forbid: ["buy"],
      };
    }
  }

  if (report.subject.accidentCount === null) {
    return {
      id: "mandate_fit",
      status: "forbid",
      reason: "Accident history is missing from the listing. Buy is forbidden until history is verified.",
      forbid: ["buy"],
    };
  }

  return { id: "mandate_fit", status: "pass", reason: "Mandate checks (budget / profit / repair) did not forbid buy.", forbid: [] };
}
