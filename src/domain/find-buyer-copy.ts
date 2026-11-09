/**
 * Plain-language Find copy for normal car buyers.
 * Technical receipts stay in the machine/agent channel — never in visible UI prose.
 */

import type { FindFreeGovReceipt } from "./find-free-gov";
import type { FindNextCheckLoopReason } from "./find-next-check-loop";
import type { FindNextCheckId } from "./find-next-checks";
import type { BestDealResult } from "./find-best-deal";
import { formatFindFuelEvidenceShort } from "./find-fuel-match";

/** Patterns that must never appear in buyer-visible Find/report text. */
export const BUYER_FORBIDDEN_TECH_PATTERNS: RegExp[] = [
  /https?:\/\/[^\s]*vpic\.nhtsa\.dot\.gov/i,
  /https?:\/\/[^\s]*api\.nhtsa\.gov/i,
  /https?:\/\/[^\s]*fueleconomy\.gov\/ws\//i,
  /\?format=json/i,
  /format=json/i,
  /\bsrc=https?:\/\//i,
  /\bcompare_observed_asks\b/,
  /\bfree_gov_(?:recalls|vpic|safety|fuel)\b/,
  /\brun_full_analysis\b/,
  /\bget_history_report\b/,
  /\bremaining_free_checks\b/,
  /\bunchanged_state\b/,
  /\bevidence_changed_replan\b/,
  /\bUSER_ACTION_STOP\b/,
  /\bgrounded_stop\b/,
  /\bno_serv_key\b/,
  /\bserv_deterministic_fallback\b/,
  /\[unchanged_state\]/i,
  /\[evidence_changed_replan\]/i,
  /\bSERV chose\b/,
  /\bMMY\b/,
  /\bvPIC\b/,
  /\bparkIt\b/,
  /\bparkOutside\b/,
  /\bDecodeVinValues\b/,
  /\bSERV\b/,
  /\bRetry next check\b/i,
  /\bfingerprintFreeGov/i,
  /\bexecuteFindFreeGov/i,
  /\bFIND_NEXT_CHECK/,
  /\bkeyedAutonomyDiag\b/,
  /\bclampDiag\b/,
];

export function findForbiddenTechArtifacts(text: string): string[] {
  const hits: string[] = [];
  for (const re of BUYER_FORBIDDEN_TECH_PATTERNS) {
    const m = text.match(re);
    if (m) hits.push(m[0]!);
  }
  return hits;
}

export function assertBuyerSafeText(text: string): { ok: true } | { ok: false; hits: string[] } {
  const hits = findForbiddenTechArtifacts(text);
  return hits.length === 0 ? { ok: true } : { ok: false, hits };
}

export type BuyerSourceRef = {
  /** Short human label, e.g. "NHTSA recalls (U.S. government)". */
  label: string;
  /** Human-readable public page when one exists — never a raw REST API URL. */
  href: string | null;
  checkedAt: string | null;
};

export function buyerSourceForReceipt(r: Pick<
  FindFreeGovReceipt,
  "checkId" | "toolId" | "vin" | "make" | "model" | "year" | "fetchedAt" | "fuelEvidence"
>): BuyerSourceRef {
  const checkedAt = r.fetchedAt || null;
  if (r.checkId === "free_gov_recalls" || r.toolId === "evidence.gov_recalls") {
    const vin = r.vin && r.vin.length >= 11 ? r.vin : null;
    return {
      label: "NHTSA recalls (U.S. government)",
      href: vin
        ? `https://www.nhtsa.gov/recalls?vin=${encodeURIComponent(vin)}`
        : "https://www.nhtsa.gov/recalls",
      checkedAt,
    };
  }
  if (r.checkId === "free_gov_safety" || r.toolId === "evidence.gov_safety") {
    return {
      label: "NHTSA vehicle safety ratings (U.S. government)",
      href: "https://www.nhtsa.gov/ratings",
      checkedAt,
    };
  }
  if (r.checkId === "free_gov_vpic" || r.toolId === "evidence.gov_vpic") {
    return {
      label: "NHTSA VIN decoder (U.S. government)",
      href: null, // no stable non-API public decode page worth linking
      checkedAt,
    };
  }
  if (r.checkId === "free_gov_fuel" || r.toolId === "evidence.gov_fuel") {
    return {
      label: "FuelEconomy.gov (U.S. Department of Energy)",
      href: r.fuelEvidence?.humanPageUrl ?? "https://www.fueleconomy.gov/",
      checkedAt,
    };
  }
  return { label: "U.S. government public data", href: null, checkedAt };
}

export function formatBuyerReceiptLine(r: FindFreeGovReceipt): string {
  const src = buyerSourceForReceipt(r);
  const when = src.checkedAt ? ` Checked ${src.checkedAt.slice(0, 10)}.` : "";
  const title = `${r.year} ${r.make} ${r.model}`;
  if (r.checkId === "free_gov_fuel" && r.fuelEvidence) {
    return `${title}: ${formatFindFuelEvidenceShort(r.fuelEvidence)}. Source: ${src.label}.${when}`;
  }
  if (r.checkId === "free_gov_recalls") {
    const campaigns =
      r.riskFacts?.campaignCountReported ?? r.riskFacts?.campaignNumbers.length ?? null;
    const parkBits: string[] = [];
    if (r.riskFacts?.parkIt === true) {
      parkBits.push("Includes a park-it campaign flag for this year/make/model");
    }
    if (r.riskFacts?.parkOutside === true) {
      parkBits.push(
        "Includes outdoor-parking guidance for a campaign (not the same as a do-not-drive park-it flag)",
      );
    }
    if (r.riskFacts?.parkIt === false && r.riskFacts?.parkOutside === false) {
      parkBits.push("No park-it or outdoor-parking campaign flags on the retained rows");
    }
    const park = parkBits.length ? ` ${parkBits.join(". ")}.` : "";
    if (r.status === "ok" || r.status === "empty") {
      return `${title}: ${campaigns === 0 || r.status === "empty" ? "No recall campaigns on file" : `${campaigns} recall campaign${campaigns === 1 ? "" : "s"} on file`} for this year/make/model (not the same as VIN open/closed status).${park} Source: ${src.label}.${when}`;
    }
    return `${title}: Recall check unavailable. Source: ${src.label}.${when}`;
  }
  if (r.checkId === "free_gov_safety") {
    if (r.status === "ok") {
      return `${title}: Safety ratings checked for this year/make/model class. Source: ${src.label}.${when}`;
    }
    if (r.status === "empty") {
      return `${title}: No safety ratings listed for this year/make/model. Source: ${src.label}.${when}`;
    }
    return `${title}: Safety ratings unavailable. Source: ${src.label}.${when}`;
  }
  if (r.checkId === "free_gov_vpic") {
    if (r.status === "ok") {
      return `${title}: VIN decoded with the government decoder (specs only — not a clean history). Source: ${src.label}.${when}`;
    }
    return `${title}: VIN decode unavailable or incomplete. Source: ${src.label}.${when}`;
  }
  return `${title}: Public vehicle check recorded. Source: ${src.label}.${when}`;
}

export function formatBuyerLoopStep(input: {
  chosenId: string;
  listingCount?: number;
  modelCount?: number;
  freeEvidenceNote?: string | null;
  loopReason?: FindNextCheckLoopReason | string | null;
}): string {
  const id = input.chosenId as FindNextCheckId | string;
  const n = input.listingCount;
  const cars = typeof n === "number" ? ` the ${n} car${n === 1 ? "" : "s"} found` : " the cars found";
  switch (id) {
    case "free_gov_recalls":
      return `We checked government recall records for year/make/model on${cars}.`;
    case "free_gov_safety":
      return `We checked government crash-test ratings for year/make/model on${cars}.`;
    case "free_gov_vpic":
      return `We decoded available VINs with the government VIN decoder (specs only).`;
    case "free_gov_fuel":
      return `We checked fuel costs using FuelEconomy.gov for${cars}.`;
    case "compare_observed_asks":
      return typeof n === "number"
        ? `We compared asking prices across the ${n} cars found.`
        : "We compared asking prices across the cars found.";
    case "clarify_year_band":
      return "We need a clearer model-year range from you before narrowing further.";
    case "clarify_miles_cap":
      return "We need a mileage limit from you if that matters.";
    case "set_budget":
      return "We still need your maximum asking price.";
    case "widen_or_nationwide":
      return "We can widen the search distance or look nationwide.";
    case "run_full_analysis":
      return "A full per-car analysis is available when you want deeper numbers (uses 1 report credit).";
    case "get_history_report":
      return "A paid vehicle-history report is still the right next step for accidents and title brands.";
    default:
      return "We updated the search checks based on what is already known.";
  }
}

export function formatBuyerLoopStatus(reason: FindNextCheckLoopReason | string | null | undefined): string | null {
  if (!reason) return null;
  switch (reason) {
    case "evidence_changed_replan":
      return "New public evidence came in — continuing automatic checks.";
    case "remaining_free_checks":
      return "More free public checks are still available — continuing.";
    case "unchanged_state":
      return "Checks caught up with the current evidence.";
    case "grounded_stop":
      return "We have enough from the current cards to compare — stopping automatic checks.";
    case "needs_clarification":
      return "We need a quick answer from you before continuing.";
    case "user_action_required":
      return "The next step needs your choice (full analysis or a history report).";
    case "provider_failure":
      return "A listing search step failed — stopped automatic checks.";
    case "no_serv_key":
    case "no_keyed_autonomy":
      return "Automatic advisor checks are not configured on this deployment.";
    case "serv_deterministic_fallback":
      return "Using the built-in checklist for now.";
    case "no_remaining_research_checks":
      return "No further automatic research steps on this search.";
    default:
      return "Automatic checks updated.";
  }
}

export function formatBuyerNextCheckWhy(id: FindNextCheckId | string, technicalWhy: string): string {
  // Prefer rewriting known ids; strip technical tokens from fallback.
  const plain = formatBuyerLoopStep({ chosenId: id });
  if (id.startsWith("free_gov_") || id === "compare_observed_asks") return plain;
  // Soft scrub of technicalWhy
  return technicalWhy
    .replace(/\bMMY\b/g, "year/make/model")
    .replace(/\bvPIC\b/g, "VIN decoder")
    .replace(/\bNHTSA\b/g, "government")
    .replace(/\bfree_gov_\w+/g, "free public check")
    .replace(/\bErrorCode=0\b/g, "a successful decode")
    .replace(/\bNMVTIS\b/g, "official title history");
}

export function formatBuyerBestDeal(result: BestDealResult): {
  headline: string;
  why: string;
  stillUnknown: string[];
  rankedLines: string[];
  sensitivityLines: string[];
  honesty: string;
} {
  const headline =
    result.confidence === "confident" && result.pick
      ? `Best deal on current evidence: ${result.pick.year} ${result.pick.make} ${result.pick.model}${result.pick.priceUsd != null ? ` · $${result.pick.priceUsd.toLocaleString("en-US")}` : ""}`
      : "No confident best-deal pick on current evidence";
  const rankedLines = result.ranked.map((c, i) => {
    const fuel = c.fuelSummary ? ` · ${c.fuelSummary}` : "";
    const ask = c.priceUsd != null ? `$${c.priceUsd.toLocaleString("en-US")}` : "price n/a";
    const miles = c.miles != null ? `${c.miles.toLocaleString("en-US")} mi` : "miles n/a";
    return `${i + 1}. ${c.year} ${c.make} ${c.model} — ${ask} · ${miles}${fuel}`;
  });
  const sensitivityLines = result.sensitivity
    .filter((s) => s.pickChanges)
    .map((s) => `${s.label}: the top pick would change.`);
  return {
    headline,
    why: result.why,
    stillUnknown: result.stillUnknown,
    rankedLines,
    sensitivityLines,
    honesty: result.honesty,
  };
}

/** Machine-only payload for agents / hidden data attributes — not for visible UI. */
export function machineReceiptsPayload(receipts: readonly FindFreeGovReceipt[]): string {
  return JSON.stringify({
    channel: "for-agents",
    version: 1,
    receipts: receipts.map((r) => ({
      checkId: r.checkId,
      toolId: r.toolId,
      status: r.status,
      summary: r.summary,
      sourceUrl: r.sourceUrl,
      make: r.make,
      model: r.model,
      year: r.year,
      vin: r.vin,
      fetchedAt: r.fetchedAt,
      riskFacts: r.riskFacts,
      fuelEvidence: r.fuelEvidence ?? null,
      factNotes: r.factNotes,
    })),
  });
}
