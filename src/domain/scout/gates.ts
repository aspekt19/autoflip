import type { FlipEstimate } from "@/domain/flip-rank";
import type { GateResult } from "@/domain/verdict-gates";
import type { Listing } from "@/domain/types";
import type { ScoutMandate } from "./types";

/**
 * Scout investigation gates — stricter about claims than consumer "buy" verdicts.
 * Hard gates cannot be overridden. Unknown history does not force reject of an
 * investigation candidate, but forbids claiming verified safe buy/profit.
 */
export type ScoutGateSummary = {
  gates: GateResult[];
  withheld: boolean;
  withholdReason: string | null;
  allowInvestigate: boolean;
  claimsSafeBuy: false;
  claimsVerifiedProfit: false;
};

export function runScoutGates(input: {
  listing: Listing;
  mandate: ScoutMandate;
  flip: FlipEstimate | null;
  historyStatus: "known" | "unknown" | "partial";
}): ScoutGateSummary {
  const gates: GateResult[] = [];

  if (input.listing.priceUsd == null) {
    gates.push({
      id: "data_sufficiency",
      status: "withhold",
      reason: "No asking price — cannot investigate economics honestly.",
      forbid: ["buy", "negotiate", "pass"],
    });
  } else {
    gates.push({
      id: "data_sufficiency",
      status: "pass",
      reason: "Asking price present (seller claim).",
      forbid: [],
    });
  }

  if (!input.listing.vin) {
    gates.push({
      id: "identity_vin",
      status: "withhold",
      reason: "VIN missing.",
      forbid: ["buy", "negotiate", "pass"],
    });
  } else {
    gates.push({
      id: "identity_vin",
      status: "pass",
      reason: "VIN present on listing feed.",
      forbid: [],
    });
  }

  // Title/brand not scanned — UNKNOWN, never PASS. Investigation allowed; buy forbidden.
  gates.push({
    id: "safety_red_flags",
    status: "forbid",
    reason:
      "Title/brand was not scanned in this scout slice — status UNKNOWN (not a safety pass). Buy forbidden until evidenced.",
    forbid: ["buy"],
  });

  if (input.mandate.mode === "flip") {
    if (!input.flip || input.flip.excluded || input.flip.compCount < 3) {
      gates.push({
        id: "price_vs_comps",
        status: "withhold",
        reason: "Fewer than 3 asking-price comps or flip estimate excluded — no profit claim.",
        forbid: ["buy"],
      });
    } else {
      gates.push({
        id: "price_vs_comps",
        status: "pass",
        reason: `${input.flip.compCount} asking-price comps available for estimate (not sold prices).`,
        forbid: [],
      });
    }
  } else {
    gates.push({
      id: "price_vs_comps",
      status: "pass",
      reason: "Personal mode does not require flip comps for investigation listing.",
      forbid: [],
    });
  }

  if (input.mandate.mode === "personal" && input.mandate.budgetKnown && input.mandate.budgetUsd != null) {
    if (input.listing.priceUsd != null && input.listing.priceUsd > input.mandate.budgetUsd * 1.05) {
      gates.push({
        id: "mandate_fit",
        status: "forbid",
        reason: "Asking price exceeds personal budget by more than 5%.",
        forbid: ["buy", "negotiate"],
      });
    } else {
      gates.push({
        id: "mandate_fit",
        status: "pass",
        reason: "Asking price within personal budget envelope (or budget unknown).",
        forbid: [],
      });
    }
  } else if (input.mandate.mode === "flip" && input.mandate.targetProfitUsd != null && input.flip) {
    if (input.flip.clearsTarget === false) {
      gates.push({
        id: "mandate_fit",
        status: "forbid",
        reason: "Estimated mid profit does not clear target (estimate from asking comps + assumed costs).",
        forbid: ["buy"],
      });
    } else {
      gates.push({
        id: "mandate_fit",
        status: "pass",
        reason:
          input.flip.clearsTarget === null
            ? "Target profit not evaluated."
            : "Estimated mid profit clears target under labeled assumptions — not verified profit.",
        forbid: [],
      });
    }
  } else {
    gates.push({
      id: "mandate_fit",
      status: "pass",
      reason: "Mandate fit not fully specified; investigation allowed without buy claim.",
      forbid: [],
    });
  }

  // History note gate — never overrides to pass a safe-buy claim.
  if (input.historyStatus !== "known") {
    gates.push({
      id: "data_sufficiency",
      status: "pass",
      reason: `History status ${input.historyStatus}: investigation allowed; verified safe buy/profit forbidden.`,
      forbid: ["buy"],
    });
  }

  const withheld = gates.some((g) => g.status === "withhold");
  const withholdReason = gates.find((g) => g.status === "withhold")?.reason ?? null;
  const hardForbidInvestigate = gates.some(
    (g) => g.status === "withhold" && g.id === "data_sufficiency" && input.listing.priceUsd == null,
  );

  return {
    gates,
    withheld,
    withholdReason,
    allowInvestigate: !hardForbidInvestigate && input.listing.vin.length > 0 && input.listing.priceUsd != null,
    claimsSafeBuy: false,
    claimsVerifiedProfit: false,
  };
}
