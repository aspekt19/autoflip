/**
 * Structured free-gov risk evidence for Find shortlist / SERV planner.
 *
 * General MMY-keyed mechanism — never hardcodes specific models or phrases.
 * parkIt ≠ parkOutside (do not claim do-not-drive from parkOutside alone).
 * Complaints ≠ defect proof. MMY ≠ VIN-specific. Partial MMY coverage stays honest.
 */
import type { FindFreeGovReceipt } from "./find-free-gov";
import type { ObservedListingRow } from "./find-model-observe";
import type { FreeGovEvidencePacket } from "./scout/free-gov";

export type FreeGovRiskFacts = {
  /** True only when an NHTSA campaign has parkIt=true. null = unknown / not this tool. */
  parkIt: boolean | null;
  /** True only when parkOutSide=true — separate from parkIt; not do-not-drive alone. */
  parkOutside: boolean | null;
  /** Retained campaign IDs (may be capped); never silently imply this is the full set. */
  campaignNumbers: string[];
  /**
   * Full NHTSA recallCount when known (from packet). May exceed campaignNumbers.length
   * when planner briefs cap campaign objects — UI/SERV must label shown vs reported.
   */
  campaignCountReported: number | null;
  complaintCount: number | null;
  recallsAvailable: boolean | null;
  complaintsAvailable: boolean | null;
  sourceUrl: string | null;
  toolId: string;
  scope: string;
  /** Always null for make/model/year free-gov — never invent VIN-open clearance. */
  vinOpenRecalls: null;
  make: string;
  model: string;
  year: number;
  /** Listing / MMY key for mapping receipts → cards. */
  listingKey: string;
  cached: boolean;
};

export type ShortlistRiskStatus =
  | "unknown_needs_inspection"
  | "unchecked_mmy"
  | "mmy_park_it_investigate"
  | "mmy_park_outside_flag"
  | "mmy_campaigns_recorded"
  | "mmy_complaints_only"
  | "mmy_empty_no_campaigns"
  | "mmy_lookup_unavailable";

export type RiskCoverageHonesty = {
  checkedMmyCount: number;
  listingMmyCount: number;
  uncheckedMmyCount: number;
  listingCardCount: number;
  note: string;
};

export function mmyListingKey(make: string, model: string, year: number): string {
  return `${make}|${model}|${year}`.toLowerCase();
}

/** Distinct make/model/year keys among observed cards. */
export function listingMmyKeys(
  listings: readonly Pick<ObservedListingRow, "make" | "model" | "year">[],
): Set<string> {
  const keys = new Set<string>();
  for (const row of listings) {
    keys.add(mmyListingKey(row.make, row.model, row.year));
  }
  return keys;
}

/**
 * Extract bounded structured risk from a free-gov packet (recalls path).
 * Other tools return null park flags with tool provenance retained.
 */
export function riskFactsFromPacket(
  packet: FreeGovEvidencePacket,
  listing: { make: string; model: string; year: number },
): FreeGovRiskFacts {
  const listingKey = mmyListingKey(listing.make, listing.model, listing.year);
  const base: FreeGovRiskFacts = {
    parkIt: null,
    parkOutside: null,
    campaignNumbers: [],
    campaignCountReported: null,
    complaintCount: null,
    recallsAvailable: null,
    complaintsAvailable: null,
    sourceUrl: packet.url,
    toolId: packet.toolId,
    scope: packet.scope,
    vinOpenRecalls: null,
    make: listing.make,
    model: listing.model,
    year: listing.year,
    listingKey,
    cached: packet.cached,
  };

  if (packet.toolId !== "evidence.gov_recalls") {
    return base;
  }

  const primary = packet.facts.find((f) => f.key === "evidence.gov_recalls");
  const value =
    primary && primary.value && typeof primary.value === "object"
      ? (primary.value as Record<string, unknown>)
      : null;

  const campaigns = Array.isArray(value?.campaigns) ? value!.campaigns : [];
  let parkIt = false;
  let parkOutside = false;
  const campaignNumbers: string[] = [];
  for (const raw of campaigns) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    if (c.parkIt === true) parkIt = true;
    if (c.parkOutSide === true || c.parkOutside === true) parkOutside = true;
    if (typeof c.campaignNumber === "string" && c.campaignNumber.trim()) {
      campaignNumbers.push(c.campaignNumber.trim().slice(0, 32));
    }
  }
  if (typeof value?.parkIt === "boolean") parkIt = value.parkIt;
  if (typeof value?.parkOutside === "boolean") parkOutside = value.parkOutside;
  else if (typeof value?.parkOutSide === "boolean") parkOutside = value.parkOutSide;

  if (packet.facts.some((f) => f.key === "nhtsa_park_it" && f.kind === "verified")) {
    parkIt = true;
  }
  if (packet.facts.some((f) => f.key === "nhtsa_park_outside" && f.kind === "verified")) {
    parkOutside = true;
  }

  const recallsAvailable =
    typeof value?.recallsAvailable === "boolean" ? value.recallsAvailable : packet.status !== "unavailable";
  const complaintsAvailable =
    typeof value?.complaintsAvailable === "boolean" ? value.complaintsAvailable : null;
  const complaintCount =
    typeof value?.complaintCount === "number"
      ? value.complaintCount
      : typeof value?.complaintCount === "string" && /^\d+$/.test(value.complaintCount)
        ? Number(value.complaintCount)
        : null;
  const campaignCountReported =
    typeof value?.recallCount === "number"
      ? value.recallCount
      : typeof value?.recallCount === "string" && /^\d+$/.test(value.recallCount)
        ? Number(value.recallCount)
        : campaignNumbers.length > 0
          ? campaignNumbers.length
          : null;

  if (packet.status === "unavailable" || packet.status === "error") {
    return {
      ...base,
      parkIt: null,
      parkOutside: null,
      recallsAvailable: false,
      complaintsAvailable: complaintsAvailable === true ? true : false,
      complaintCount,
      campaignCountReported,
    };
  }

  const retainedIds = campaignNumbers.slice(0, 8);
  return {
    ...base,
    parkIt,
    parkOutside,
    campaignNumbers: retainedIds,
    // Prefer provider recallCount; never under-report vs retained IDs.
    campaignCountReported:
      campaignCountReported != null
        ? Math.max(campaignCountReported, retainedIds.length)
        : retainedIds.length > 0
          ? retainedIds.length
          : null,
    complaintCount,
    recallsAvailable,
    complaintsAvailable,
    sourceUrl: typeof value?.url === "string" ? value.url : packet.url,
  };
}

/** Latest receipt wins per listingKey+checkId (prevents duplicate cached append cycles). */
export function mergeFreeGovReceiptsByMmy(
  prior: readonly FindFreeGovReceipt[],
  next: readonly FindFreeGovReceipt[],
): FindFreeGovReceipt[] {
  const map = new Map<string, FindFreeGovReceipt>();
  for (const r of prior) {
    map.set(`${r.checkId}|${mmyListingKey(r.make, r.model, r.year)}`, r);
  }
  for (const r of next) {
    map.set(`${r.checkId}|${mmyListingKey(r.make, r.model, r.year)}`, r);
  }
  return [...map.values()].sort((a, b) =>
    `${a.checkId}|${a.make}|${a.model}|${a.year}`.localeCompare(
      `${b.checkId}|${b.make}|${b.model}|${b.year}`,
    ),
  );
}

/** Index recall risk facts by MMY key (latest wins). */
export function indexRiskFactsByMmy(
  receipts: readonly FindFreeGovReceipt[],
): Map<string, FreeGovRiskFacts> {
  const map = new Map<string, FreeGovRiskFacts>();
  for (const r of receipts) {
    if (r.checkId !== "free_gov_recalls" || !r.riskFacts) continue;
    map.set(r.riskFacts.listingKey, r.riskFacts);
  }
  return map;
}

/**
 * Map MMY risk onto a model-family shortlist row (yearMin–yearMax span).
 * Any parkIt year in the family escalates; parkOutside alone does not become parkIt.
 */
export function riskStatusForModelFamily(
  make: string,
  model: string,
  yearMin: number,
  yearMax: number,
  byMmy: Map<string, FreeGovRiskFacts>,
  listingKeys: Set<string>,
): {
  status: ShortlistRiskStatus;
  facts: FreeGovRiskFacts[];
  outstandingChecks: string[];
  whyBits: string[];
  unknowns: string[];
} {
  const facts: FreeGovRiskFacts[] = [];
  let anyChecked = false;
  let anyParkIt = false;
  let anyParkOutside = false;
  let anyCampaigns = false;
  let complaintsOnly = false;
  let anyEmpty = false;
  let anyUnavailable = false;
  const campaignNums = new Set<string>();
  let uncheckedInSpan = 0;
  let checkedInSpan = 0;

  for (let y = yearMin; y <= yearMax; y++) {
    const key = mmyListingKey(make, model, y);
    if (!listingKeys.has(key)) continue;
    const f = byMmy.get(key);
    if (!f) {
      uncheckedInSpan += 1;
      continue;
    }
    anyChecked = true;
    checkedInSpan += 1;
    facts.push(f);
    if (f.parkIt === true) anyParkIt = true;
    if (f.parkOutside === true) anyParkOutside = true;
    if (f.campaignNumbers.length > 0) {
      anyCampaigns = true;
      for (const n of f.campaignNumbers) campaignNums.add(n);
    }
    if (
      f.parkIt === false &&
      f.parkOutside === false &&
      f.campaignNumbers.length === 0 &&
      (f.complaintCount ?? 0) > 0
    ) {
      complaintsOnly = true;
    }
    if (
      f.parkIt === false &&
      f.parkOutside === false &&
      f.campaignNumbers.length === 0 &&
      f.recallsAvailable === true
    ) {
      anyEmpty = true;
    }
    if (f.recallsAvailable === false) anyUnavailable = true;
  }

  const outstandingChecks: string[] = [];
  const whyBits: string[] = [];
  const unknowns: string[] = [];

  if (!anyChecked) {
    return {
      status: byMmy.size > 0 ? "unchecked_mmy" : "unknown_needs_inspection",
      facts,
      // Unchecked MMY is a valid free path even when other models already have sample evidence.
      outstandingChecks: ["free_gov_recalls", "free_gov_safety"],
      whyBits:
        byMmy.size > 0
          ? ["this make/model year span was not in the free-gov MMY sample — free checks still available"]
          : [],
      unknowns: [
        "condition/history unknown on Find cards",
        byMmy.size > 0
          ? "this model’s years were not covered by free NHTSA sample — risk unknown, not cleared"
          : "no free NHTSA risk facts applied yet",
      ],
    };
  }

  let status: ShortlistRiskStatus = "mmy_campaigns_recorded";
  if (anyParkIt) {
    status = "mmy_park_it_investigate";
    whyBits.push(
      "NHTSA make/model/year parkIt campaign(s) — investigate VIN applicability; not auto-buy; not VIN-cleared",
    );
    outstandingChecks.push("free_gov_vpic", "get_history_report");
    unknowns.push(
      "parkIt is MMY-scope only — VIN applicability and repair status unknown",
      "title/NMVTIS unknown (paid history not autocharged)",
    );
  } else if (anyParkOutside && !anyParkIt) {
    status = "mmy_park_outside_flag";
    whyBits.push(
      "NHTSA parkOutside campaign flag (outdoor parking guidance) — not a do-not-drive/parkIt claim by itself",
    );
    outstandingChecks.push("get_history_report");
    unknowns.push("parkOutside ≠ parkIt do-not-drive; VIN repair status still unknown");
  } else if (complaintsOnly && !anyCampaigns) {
    status = "mmy_complaints_only";
    whyBits.push(
      "NHTSA complaints recorded (owner allegations) — not verified defects; not a reject by itself",
    );
    unknowns.push("complaints ≠ defect proof; condition still unknown");
  } else if (anyUnavailable && !anyCampaigns && !complaintsOnly) {
    status = "mmy_lookup_unavailable";
    whyBits.push("NHTSA recall lookup unavailable for sampled year(s) — not a clean pass");
    outstandingChecks.push("free_gov_recalls");
    unknowns.push("recall risk unknown because lookup failed");
  } else if (anyEmpty && !anyCampaigns && !complaintsOnly) {
    status = "mmy_empty_no_campaigns";
    whyBits.push(
      "NHTSA returned zero make/model/year campaigns for sampled year(s) — not VIN-clear",
    );
    unknowns.push("empty MMY campaigns ≠ VIN unrepaired clearance");
  } else if (anyCampaigns) {
    status = "mmy_campaigns_recorded";
    whyBits.push(
      `NHTSA campaign ref(s) ${[...campaignNums].slice(0, 4).join(", ") || "recorded"} — MMY scope only`,
    );
    unknowns.push("campaigns recorded ≠ VIN repair proof");
  }

  if (uncheckedInSpan > 0) {
    unknowns.push(
      `${uncheckedInSpan} listing year(s) in this model family unchecked by free-gov sample (checked ${checkedInSpan})`,
    );
    outstandingChecks.push("free_gov_recalls");
  }

  unknowns.push("condition/history unknown on Find cards");
  return { status, facts, outstandingChecks: [...new Set(outstandingChecks)], whyBits, unknowns };
}

export function riskCoverageHonesty(
  listings: readonly Pick<ObservedListingRow, "make" | "model" | "year">[],
  receipts: readonly FindFreeGovReceipt[],
): RiskCoverageHonesty {
  const listingKeys = listingMmyKeys(listings);
  const checked = new Set<string>();
  for (const r of receipts) {
    if (r.checkId !== "free_gov_recalls") continue;
    checked.add(mmyListingKey(r.make, r.model, r.year));
  }
  const checkedMmyCount = [...checked].filter((k) => listingKeys.has(k)).length;
  const listingMmyCount = listingKeys.size;
  const uncheckedMmyCount = Math.max(0, listingMmyCount - checkedMmyCount);
  const note =
    listingMmyCount === 0
      ? "No listing MMY keys to cover."
      : checkedMmyCount === 0
        ? `Free NHTSA sample has not checked any of ${listingMmyCount} listing make/model/year key(s) across ${listings.length} card(s) — risk unknown, not cleared.`
        : checkedMmyCount < listingMmyCount
          ? `Free NHTSA sample covered ${checkedMmyCount} of ${listingMmyCount} listing make/model/year key(s) (${listings.length} cards). Unchecked years stay unknown — not a fleet-wide clearance.`
          : `Free NHTSA sample covered all ${listingMmyCount} listing make/model/year key(s). Still MMY-scope only — not VIN-specific unrepaired status.`;
  return {
    checkedMmyCount,
    listingMmyCount,
    uncheckedMmyCount,
    listingCardCount: listings.length,
    note,
  };
}
