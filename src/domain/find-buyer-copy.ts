/**
 * Plain-language Find copy for normal car buyers.
 * Technical receipts stay in the machine/agent channel — never in visible UI prose.
 */

import type { FindBaselineDelta } from "./find-baseline";
import { formatBaselineForBuyer } from "./find-baseline";
import { recallEvidenceState, recallFactPlain } from "./find-evidence-state";
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
  /\bfree_car_consistency\b/,
  /\btargetKeys\b/,
  /\bdecidedBy\b/,
  /\binvokeReason\b/,
  /\bshortlist_changed\b/,
  /\binitial_decision\b/,
  /\bnontrivial_choice\b/,
  /\bfree_gov_deterministic_drain\b/,
  /\bconsistency_deterministic_drain\b/,
  /\bpaid_cap_reached\b/,
  /\bcould_not_check\b/,
  /\bissue_found\b/,
  /\bnone_found\b/,
  /\bnot_checked\b/,
  /\blisting_says\b/,
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
  // Best-deal factor ids / machine keys — buyer UI must use plain labels only.
  /\bestimated_fuel_cost\b/,
  /\bmmy_recall_campaigns\b/,
  /\bmmy_ncap_rating\b/,
  /\bprice_vs_model_asks\b/,
  /\bmiles_per_year_vs_peers\b/,
  /\bnamed_model_preference\b/,
  /\bcondition_priority\b/,
  /\bbudget_fit\b/,
  /\blisting_feed_flags\b/,
  /\bfairnessHeldOut\b/,
  /\bevidenceSettled\b/,
  /\bevidence\.gov_(?:recalls|vpic|safety|fuel)\b/,
  // Internal validation / provider jargon — buyer form copy must stay plain.
  /\bapp validation\b/i,
  /\bprovider hard limit\b/i,
  // Market-method jargon — keep exact slopes/rates in the agent channel only.
  /≈/,
  /\bpercentile\b/i,
  /\bfitted\b/i,
  /\bdocumented rates\b/i,
  /\bcomps\b/i,
  /\bcomp\s/i,
  /\bcomparables\b/i,
  // Sample-size and cost jargon that leaked onto Find cards and the decision note.
  /\(n=\d+/,
  /\bn=\d+\b/,
  /\bTCO\b/,
  /Observed from this search only/i,
  /explicit \$\/gal/i,
  /\$\/gal/,
  /A blank budget stays blank/i,
  /\bmedian ask\b/i,
];

/**
 * Find billing copy (shared by /find page + results hint).
 * A new Find search debits 1 report credit for a verified account when sign-in is on.
 * Keep the public phrase "when billing is enabled": do not promise a free Find, and do
 * not fold Find into the separate monthly VIN / own-listing-URL check allotment.
 */
export const FIND_PAGE_BILLING_STEP =
  "Find is a credit-priced search when billing is enabled. Open a full report for any car you want to investigate further (1 report credit).";

export const FIND_RESULTS_BILLING_HINT =
  "Find is a credit-priced search when billing is enabled. A full per-car report uses 1 report credit. Ongoing new-listing alerts require a separate monthly Radar plan.";

/**
 * /credits?need=1 copy. Find is never paid by the monthly VIN / own-URL allotment.
 * `returnTo` is the safe relative path the shopper was sent from.
 */
export function creditsNeedNotice(returnTo: string | null | undefined): string {
  const back = returnTo ?? "";
  if (back.startsWith("/find")) {
    return "Find costs 1 report credit each time a search is delivered. The 3 free checks each UTC month are only for a VIN or your own listing URL — they do not pay for Find.";
  }
  if (back.startsWith("/check")) {
    return "A VIN or your own listing URL uses one of 3 free checks per verified account each UTC month. After those are used, a full report costs 1 report credit.";
  }
  return "Find costs 1 report credit per delivered search. A VIN or your own listing URL uses one of 3 free checks per verified account each UTC month; a full report after that costs 1 credit.";
}

/**
 * Checklist heading for public year/make/model checks.
 * "Caught up" only after a next-check hop has actually run. A fresh result
 * with the loop not started yet is not caught up.
 */
export function publicCheckStatusLine(input: {
  servEnabled: boolean;
  anyUnchecked: boolean;
  checksHaveRun: boolean;
}): string {
  if (!input.servEnabled) {
    return "Here is what we can check next with the cars already found:";
  }
  if (input.anyUnchecked) {
    return "Still finishing public year/make/model checks — the pick may change as remaining groups complete.";
  }
  if (input.checksHaveRun) {
    return "Public year/make/model checks for this shortlist are caught up.";
  }
  return "Public year/make/model checks have not finished for this shortlist yet.";
}

/** Buyer-facing seller-distance custom-miles hint (no app-validation jargon). */
export function customMilesBuyerHint(maxMiles: number): string {
  return `You can enter any distance up to ${maxMiles.toLocaleString("en-US")} miles, or choose Nationwide to search without a distance limit.`;
}

const BUYER_ID_LABELS: Record<string, string> = {
  price_vs_comps: "asking price vs similar listings",
  insufficient_comps: "not enough similar listings",
  data_sufficiency: "enough listing data",
  identity_vin: "VIN matches the listing",
  safety_red_flags: "safety flags",
  mandate_fit: "fits what you asked for",
  price_far_above_market: "asking price far above similar listings",
  vin_identity_mismatch: "VIN does not match the listing",
  critical_missing_data: "missing data",
  suspiciously_cheap: "asking price looks too low",
  park_it_recall: "park-it recall",
  odometer_mismatch: "odometer concern",
  gates_withheld: "checks withheld a verdict",
  title_brand: "title brand",
  needs_inspection: "needs inspection",
  insufficient_data: "not enough data",
  good_deal: "good deal",
  walk_away: "walk away",
};

const PLAIN_CHECK_IDS = new Set<string>([
  "free_gov_recalls",
  "free_gov_safety",
  "free_gov_vpic",
  "free_gov_fuel",
  "free_car_consistency",
  "compare_observed_asks",
  "clarify_year_band",
  "clarify_miles_cap",
  "set_budget",
  "widen_or_nationwide",
  "run_full_analysis",
  "get_history_report",
]);

/** Plain stand-in for an internal gate id when that id would otherwise be shown to a buyer. */
export function plainBuyerPhrase(text: string): string {
  let out = text;
  const ids = Object.keys(BUYER_ID_LABELS).sort((a, b) => b.length - a.length);
  for (const id of ids) out = out.replaceAll(id, BUYER_ID_LABELS[id]!);
  return out;
}

/**
 * NHTSA campaign ids (for example 12V501000) stay visible only with a plain label:
 * they are the official recall number a buyer can look up.
 */
export function formatOfficialRecallNumber(id: string): string {
  const trimmed = id.trim();
  if (/^official recall number\b/i.test(trimmed)) return trimmed;
  const bare = trimmed.replace(/^NHTSA recall campaign\s+/i, "").trim();
  return `Official recall number ${bare} — look this up on NHTSA`;
}

export function plainGateStatus(status: string): string {
  switch (status) {
    case "pass":
    case "passed":
      return "passed";
    case "withhold":
    case "withheld":
      return "withheld";
    case "forbid":
    case "blocked":
      return "blocked";
    default:
      return plainBuyerPhrase(status.replaceAll("_", " "));
  }
}

export function plainDecisionAction(action: string): string {
  return plainBuyerPhrase(action.replaceAll("_", " "));
}

export function plainDecisionSource(source: string): string {
  switch (source) {
    case "gates_withheld":
      return "checks withheld a verdict";
    case "serv":
      return "AI review";
    case "guardrail_clamp":
      return "safety rules adjusted the suggestion";
    case "deterministic_fallback":
      return "built-in reading";
    case "no_serv_key":
      return "automatic review is not configured";
    default:
      return plainBuyerPhrase(source.replaceAll("_", " "));
  }
}

export function plainExplanationSource(source: string): string {
  switch (source) {
    case "serv":
      return "AI review";
    case "template":
      return "standard explanation";
    case "unavailable":
      return "unavailable";
    default:
      return plainBuyerPhrase(source.replaceAll("_", " "));
  }
}

export function plainFlagSource(source: string): string {
  switch (source) {
    case "nhtsa-recalls":
      return "NHTSA recalls";
    case "nhtsa-complaints":
      return "NHTSA complaints";
    case "vin-identity":
      return "VIN check";
    case "title-brand":
      return "title brand";
    case "listing-history":
    case "listing":
      return "listing";
    case "price":
    case "price-anomaly":
      return "price";
    case "odometer":
      return "odometer";
    case "sample":
      return "sample";
    default:
      return plainBuyerPhrase(source.replaceAll("-", " ").replaceAll("_", " "));
  }
}

export function plainCompScope(scope: string): string {
  switch (scope) {
    case "same_trim":
      return "same trim, nearby model years";
    case "year_window":
      return "same model, nearby model years";
    case "expanded_year":
      return "same model, widened model years";
    case "wide_year":
      return "same model, wider model years";
    case "insufficient":
      return "not enough similar listings";
    default:
      return plainBuyerPhrase(scope.replaceAll("_", " "));
  }
}

const PROOF_STEP_LABELS: Record<string, string> = {
  local_input_screen: "Input check",
  serv_prompt_guard: "Request screen",
  listings: "Listing lookup",
  government_data: "Government records",
  deterministic_tools: "Code-computed numbers",
  ordered_gates: "Ordered safety checks",
  serv_verdict_decide: "Verdict review",
  verdict_guardrails: "Safety rules",
  serv_shadow_agent: "Written explanation",
  number_audit: "Number check",
};

const PROOF_STATUS_LABELS: Record<string, string> = {
  passed: "passed",
  skipped: "skipped",
  error: "did not finish",
  sample: "sample data",
  autodev: "from the listing feed",
  ran: "ran",
  withheld: "withheld",
  skipped_withheld: "skipped — verdict withheld",
  ok: "finished",
  fallback: "used the built-in reading",
  skipped_no_key: "automatic review is not configured",
  overrode: "adjusted under safety rules",
  explanation_unavailable: "explanation unavailable",
  fallback_template: "used the standard explanation",
  passed_but_shadow_failed: "numbers checked; the written explanation was not used",
  failed: "blocked text that did not match the computed facts",
  template: "standard explanation",
  block: "blocked",
  allow: "allowed",
};

function plainGateList(detail: string): string | null {
  const parts = detail.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0 || !parts.every((part) => /^[a-z0-9_]+:[a-z0-9_]+$/i.test(part))) return null;
  return parts
    .map((part) => {
      const [id, status] = part.split(":");
      return `${plainBuyerPhrase(id!)} (${plainGateStatus(status!)})`;
    })
    .join(", ");
}

function buyerProofDetail(detail: string): string | null {
  const trimmed = detail.trim();
  if (!trimmed) return null;
  if (/SERV_API_KEY/i.test(trimmed)) {
    return "Automatic review is not configured. The written summary is the standard explanation.";
  }
  if (/\bvPIC\b/i.test(trimmed)) {
    return "NHTSA VIN decoder, NHTSA recalls, NHTSA complaints, FuelEconomy.gov, and the U.S. Census geocoder.";
  }
  if (/selectComparables|mileageAdjust|historyAdjustment|verdictFromPriceGap|flipMath|scoreFromGap|dealerQuestions/.test(trimmed)) {
    return "Similar listings, mileage adjustment, history flags, price gap, resale math, price score, and dealer questions — computed in code.";
  }
  if (/^autoflip\./i.test(trimmed)) return null;
  if (/^final=/i.test(trimmed)) {
    const action = trimmed.match(/final=([^;]+)/i)?.[1]?.trim();
    const source = trimmed.match(/source=([^\s;]+)/i)?.[1]?.trim();
    const actionBit = action ? plainDecisionAction(action) : "recorded";
    return source ? `Final action ${actionBit} (${plainDecisionSource(source)})` : `Final action ${actionBit}`;
  }
  if (trimmed === "cache hit") return "from a recent saved copy";
  if (trimmed === "fetched") return "fetched just now";
  const gateList = plainGateList(trimmed);
  if (gateList) return gateList;
  const scrubbed = plainBuyerPhrase(trimmed);
  return findForbiddenTechArtifacts(scrubbed).length === 0 ? scrubbed : null;
}

/** Buyer-visible Proof of AI line. Stored proof can keep machine ids; this is what the report shows. */
export function formatBuyerProofLine(step: { id: string; status: string; detail?: string | null }): string {
  const label = PROOF_STEP_LABELS[step.id] ?? plainBuyerPhrase(step.id.replaceAll("_", " "));
  const status = PROOF_STATUS_LABELS[step.status] ?? plainGateStatus(step.status);
  const detail = step.detail ? buyerProofDetail(step.detail) : null;
  const line = detail ? `${label}: ${status} — ${detail}` : `${label}: ${status}`;
  return findForbiddenTechArtifacts(line).length === 0 ? line : `${label}: ${status}`;
}

const SERV_PURPOSE_LABELS: Record<string, string> = {
  report_guard: "Report request screen",
  check_guard: "Check request screen",
  agent_guard: "Agent request screen",
  report_explain: "Report explanation",
  agent_explain: "Agent explanation",
  verdict_decide: "Verdict review",
  check_rules: "Wording rules",
};

/** One AI-review bullet. Feature codenames stay off the page; the decision note already explains them. */
export function formatBuyerServCheckSummary(check: {
  purpose: string;
  promptGuard?: string | null;
  shadowOutcome?: string | null;
}): string {
  const purpose =
    SERV_PURPOSE_LABELS[check.purpose] ?? plainBuyerPhrase(check.purpose.replaceAll("_", " "));
  const bits = [purpose];
  if (check.promptGuard === "allow" || check.promptGuard === "passed") bits.push("input accepted");
  else if (check.promptGuard === "block") bits.push("input blocked");
  else if (check.promptGuard === "unavailable") bits.push("input screen did not finish");
  if (check.shadowOutcome === "ok" || check.shadowOutcome === "passed") bits.push("second pass finished");
  else if (check.shadowOutcome === "exhausted" || check.shadowOutcome === "failed") {
    bits.push("second pass was not used");
  }
  const line = bits.join(" · ");
  return findForbiddenTechArtifacts(line).length === 0 ? line : purpose;
}

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
    const state = recallEvidenceState(r);
    const parkBits: string[] = [];
    if (state === "issue_found" && r.riskFacts?.parkIt === true) {
      parkBits.push("Includes a park-it campaign flag for this year/make/model");
    }
    if (state === "issue_found" && r.riskFacts?.parkOutside === true) {
      parkBits.push(
        "Includes outdoor-parking guidance for a campaign (not the same as a do-not-drive park-it flag)",
      );
    }
    if (state === "none_found" && r.riskFacts?.parkIt === false && r.riskFacts?.parkOutside === false) {
      parkBits.push("No park-it or outdoor-parking campaign flags on the retained rows");
    }
    const park = parkBits.length ? ` ${parkBits.join(". ")}.` : "";
    const lead = recallFactPlain(r, title).replace(/\.$/, "");
    if (state === "could_not_check") {
      return `${lead}. Source: ${src.label}.${when}`;
    }
    return `${lead}.${park} Source: ${src.label}.${when}`;
  }
  if (r.checkId === "free_gov_safety") {
    const notRated = /not[_\s-]*rated/i.test(r.summary) && !/overall=\d/.test(r.summary);
    if (r.status === "ok" && !notRated) {
      return `${title}: Safety ratings checked for this year/make/model class. Source: ${src.label}.${when}`;
    }
    return `${title}: Couldn't confirm crash-test ratings for this year/make/model. That is not a clean result. Source: ${src.label}.${when}`;
  }
  if (r.checkId === "free_gov_vpic") {
    if (r.status === "ok") {
      return `${title}: VIN decoded with the government decoder (specs only — not a clean history). Source: ${src.label}.${when}`;
    }
    return `${title}: VIN decode unavailable or incomplete. Source: ${src.label}.${when}`;
  }
  return `${title}: Public vehicle check recorded. Source: ${src.label}.${when}`;
}

export type FuelCheckOutcomeSummary = {
  /** Distinct year/make/model fuel attempts. */
  attempted: number;
  matched: number;
  noMatch: number;
  unavailable: number;
  /** Distinct make+model buckets among attempts. */
  modelCount: number;
  /** Distinct make+model buckets with a usable fuel match. */
  matchedModelCount: number;
};

export function summarizeFuelCheckOutcome(
  receipts: readonly FindFreeGovReceipt[],
): FuelCheckOutcomeSummary {
  let attempted = 0;
  let matched = 0;
  let noMatch = 0;
  let unavailable = 0;
  const models = new Set<string>();
  const matchedModels = new Set<string>();
  for (const r of receipts) {
    if (r.checkId !== "free_gov_fuel") continue;
    attempted += 1;
    const modelKey = `${r.make}\0${r.model}`.toLowerCase();
    models.add(modelKey);
    const match = r.fuelEvidence?.match;
    if (match === "exact" || match === "ambiguous") {
      matched += 1;
      matchedModels.add(modelKey);
    } else if (match === "unavailable" || r.status === "error" || r.status === "unavailable") {
      unavailable += 1;
    } else {
      noMatch += 1;
    }
  }
  return {
    attempted,
    matched,
    noMatch,
    unavailable,
    modelCount: models.size,
    matchedModelCount: matchedModels.size,
  };
}

export function formatBuyerLoopStep(input: {
  chosenId: string;
  listingCount?: number;
  modelCount?: number;
  freeEvidenceNote?: string | null;
  loopReason?: FindNextCheckLoopReason | string | null;
  /** Actual free_gov_fuel receipt outcomes — required for honest fuel checklist copy. */
  fuelOutcome?: FuelCheckOutcomeSummary | null;
  /** True while fuel MMYs remain unchecked — checklist stays progressive, not “failed”. */
  fuelPending?: boolean;
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
    case "free_car_consistency":
      return "We compared the listing with the VIN and with what the listing says about accidents, owners, and rental use.";
    case "free_gov_fuel": {
      const o = input.fuelOutcome;
      if (!o || o.attempted <= 0) {
        return input.fuelPending
          ? "FuelEconomy.gov fuel-cost checks are still queued for remaining year/make/model groups."
          : "FuelEconomy.gov fuel-cost check has not run yet for this search.";
      }
      const modelCount = o.modelCount > 0 ? o.modelCount : o.attempted;
      const matchedModels = o.matchedModelCount ?? o.matched;
      const parts: string[] = [];
      if (o.matched > 0 && matchedModels >= modelCount && o.matched >= o.attempted) {
        parts.push(
          `Fuel costs found for all ${modelCount} model${modelCount === 1 ? "" : "s"} (${o.attempted} model year${o.attempted === 1 ? "" : "s"})`,
        );
      } else if (o.matched > 0) {
        parts.push(
          `Fuel costs found for ${matchedModels} of ${modelCount} model${modelCount === 1 ? "" : "s"} (${o.matched} of ${o.attempted} model year${o.attempted === 1 ? "" : "s"})`,
        );
      } else {
        parts.push(
          `Fuel costs checked for ${modelCount} model${modelCount === 1 ? "" : "s"} (${o.attempted} model year${o.attempted === 1 ? "" : "s"}; none matched yet)`,
        );
      }
      if (o.noMatch > 0) {
        parts.push(
          `${o.noMatch} model year${o.noMatch === 1 ? "" : "s"} not on FuelEconomy.gov’s menu`,
        );
      }
      if (o.unavailable > 0) {
        parts.push(`${o.unavailable} unavailable (timeout or error)`);
      }
      if (input.fuelPending) parts.push("more groups still unchecked");
      return `${parts.join("; ")}.`;
    }
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

export function formatBuyerNextCheckWhy(
  id: FindNextCheckId | string,
  technicalWhy: string,
  opts?: { fuelOutcome?: FuelCheckOutcomeSummary | null; fuelPending?: boolean },
): string {
  // Prefer rewriting known ids; strip technical tokens from fallback.
  if (id === "get_history_report") {
    return "Get an NMVTIS-approved vehicle history report and a pre-purchase inspection before you buy — free public checks do not cover accidents or title brands.";
  }
  const plain = formatBuyerLoopStep({
    chosenId: id,
    fuelOutcome: opts?.fuelOutcome,
    fuelPending: opts?.fuelPending,
  });
  if (PLAIN_CHECK_IDS.has(id)) return plain;
  // Soft scrub of technicalWhy — never turn "NMVTIS-approved" into "official title history-approved".
  return technicalWhy
    .replace(/\bMMY\b/g, "year/make/model")
    .replace(/\bvPIC\b/g, "VIN decoder")
    .replace(/\bNHTSA\b/g, "government")
    .replace(/\bfree_gov_\w+/g, "free public check")
    .replace(/\bErrorCode=0\b/g, "a successful decode")
    .replace(
      /\bNMVTIS-approved history\s*\+\s*inspection before purchase\b/gi,
      "an NMVTIS-approved vehicle history report and a pre-purchase inspection before you buy",
    )
    .replace(/\bNMVTIS-approved\b/g, "NMVTIS-approved")
    .replace(/\bNMVTIS\b/g, "NMVTIS (official title history)");
}

/** Hide a numeric zero when the factor was not actually scored. A real scored zero still shows. */
export function buyerFactorBit(factor: { label: string; detail: string; points: number }): string {
  const unscored =
    /not scored|couldn't confirm|could not confirm|not a clean|held out of ranking|still pending|have not been checked|has not been compared|listing reports \d+ accident/i.test(
      factor.detail,
    );
  if (unscored) return `${factor.label}: ${factor.detail}`;
  return `${factor.label}: ${factor.detail} (${factor.points >= 0 ? "+" : ""}${factor.points})`;
}

export function formatBuyerBestDeal(result: BestDealResult): {
  headline: string;
  why: string;
  stillUnknown: string[];
  rankedLines: string[];
  /** Plain-English per-factor breakdown for every ranked car. */
  factorLines: string[];
  sensitivityLines: string[];
  honesty: string;
  settlementNote: string;
  evidenceSettled: boolean;
} {
  const settleTag = result.evidenceSettled
    ? result.priceProvisional
      ? "settled; provisional on price"
      : "settled"
    : "provisional — may change as checks complete";
  const headline =
    result.confidence === "confident" && result.pick
      ? `Best deal (${settleTag}): ${result.pick.year} ${result.pick.make} ${result.pick.model}${result.pick.priceUsd != null ? ` · $${result.pick.priceUsd.toLocaleString("en-US")}` : ""}`
      : "No confident best-deal pick on current evidence";
  const rankedLines = result.ranked.map((c, i) => {
    const fuel = c.fuelSummary ? ` · ${c.fuelSummary}` : "";
    const ask = c.priceUsd != null ? `$${c.priceUsd.toLocaleString("en-US")}` : "price n/a";
    const miles = c.miles != null ? `${c.miles.toLocaleString("en-US")} mi` : "miles n/a";
    return `${i + 1}. ${c.year} ${c.make} ${c.model} — ${ask} · ${miles}${fuel} · score ${c.score}`;
  });
  const factorLines = result.ranked.flatMap((c, i) => {
    const head = `${i + 1}. ${c.year} ${c.make} ${c.model} (score ${c.score}):`;
    // Settled breakdown replaces provisional lines — never keep “Held out” / “not on file yet”.
    const factors = c.factors
      .slice()
      .filter((f) => {
        if (!result.evidenceSettled) return true;
        return !/Held out of ranking|not on file yet|check not run|still pending/i.test(f.detail);
      })
      .sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
    const bits = factors.map((f) => buyerFactorBit(f));
    return [head, ...bits.map((b) => `  — ${b}`)];
  });
  const sensitivityLines = result.sensitivity.map((s) =>
    s.pickChanges
      ? `${s.label}: the top pick would change.`
      : `${s.label}: the top pick would stay the same.`,
  );
  return {
    headline,
    why: result.why,
    stillUnknown: result.stillUnknown.map((line) => {
      // Belt-and-suspenders: never surface raw factor ids if a caller built stillUnknown ad hoc.
      return line
        .replace(/\bestimated_fuel_cost\b/g, "estimated fuel cost")
        .replace(/\bmmy_recall_campaigns\b/g, "recall campaigns")
        .replace(/\bmmy_ncap_rating\b/g, "crash-test ratings")
        .replace(/\bprice_vs_model_asks\b/g, "asking price vs same model")
        .replace(/\bmiles_per_year_vs_peers\b/g, "mileage pace vs peers")
        .replace(/\bnamed_model_preference\b/g, "named model match")
        .replace(/\bcondition_priority\b/g, "condition-first preference")
        .replace(/\bbudget_fit\b/g, "budget fit")
        .replace(/\blisting_feed_flags\b/g, "listing history flags")
        .replace(/\bdays_listed\b/g, "days on the market");
    }),
    rankedLines,
    factorLines,
    sensitivityLines,
    honesty: result.honesty,
    settlementNote: result.settlementNote,
    evidenceSettled: result.evidenceSettled,
  };
}

/** Machine-only payload for agents / hidden data attributes — not for visible UI. */
export function machineReceiptsPayload(
  receipts: readonly FindFreeGovReceipt[],
  extras?: { baseline?: FindBaselineDelta | null },
): string {
  const baseline = extras?.baseline ?? null;
  return JSON.stringify({
    channel: "for-agents",
    version: 2,
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
      evidenceFacts: r.evidenceFacts ?? null,
      recallState: r.checkId === "free_gov_recalls" ? recallEvidenceState(r) : null,
    })),
    baseline,
    baselinePlain: baseline ? formatBaselineForBuyer(baseline) : null,
  });
}
