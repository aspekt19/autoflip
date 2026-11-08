/**
 * Ordinary Find free vehicle checks — reuses Scout free-gov port (vPIC / recalls / NCAP).
 * No paid NMVTIS / Auto.dev spend. No Report credit. Never invents clean history.
 * FuelEconomy stays unsupported on this free surface (rights hold) — same as Scout.
 */
import type { ObservedListingRow } from "./find-model-observe";
import type { FindNextCheckId } from "./find-next-checks";
import {
  listingMmyKeys,
  mmyListingKey,
  riskFactsFromPacket,
  type FreeGovRiskFacts,
} from "./find-risk-evidence";
import {
  createLiveFreeGovPort,
  isFreeGovToolId,
  type FreeGovEvidencePacket,
  type FreeGovToolId,
  type ScoutFreeGovPort,
} from "./scout/free-gov";
import type { Listing } from "./types";

export const FIND_FREE_GOV_CHECK_IDS = [
  "free_gov_recalls",
  "free_gov_vpic",
  "free_gov_safety",
] as const;

export type FindFreeGovCheckId = (typeof FIND_FREE_GOV_CHECK_IDS)[number];

export function isFindFreeGovCheckId(id: string): id is FindFreeGovCheckId {
  return (FIND_FREE_GOV_CHECK_IDS as readonly string[]).includes(id);
}

export function findFreeGovToolIdForCheck(id: FindFreeGovCheckId): FreeGovToolId {
  if (id === "free_gov_recalls") return "evidence.gov_recalls";
  if (id === "free_gov_vpic") return "evidence.gov_vpic";
  return "evidence.gov_safety";
}

/** Immutable server-owned receipt stored on search context (no credentials). */
export type FindFreeGovReceipt = {
  checkId: FindFreeGovCheckId;
  toolId: FreeGovToolId;
  status: FreeGovEvidencePacket["status"];
  summary: string;
  scope: string;
  limitsNote: string;
  vin: string | null;
  make: string;
  model: string;
  year: number;
  fetchedAt: string;
  cached: boolean;
  /** Source URL when the free public endpoint was called (planner + UI provenance). */
  sourceUrl: string | null;
  /** Short planner-facing notes — never raw HTTP bodies. */
  factNotes: string[];
  /** Structured risk facts — not summary-only; drives grounded shortlist risk. */
  riskFacts: FreeGovRiskFacts | null;
  honesty: string;
};

/**
 * Stable fingerprint for loop guards.
 * Uses structured risk fields — ignores cached summary suffixes so duplicate
 * cache hits cannot fake an evidence-changed cycle.
 */
export function fingerprintFreeGovReceipts(receipts: readonly FindFreeGovReceipt[]): string {
  const rows = receipts.map((r) => ({
    checkId: r.checkId,
    toolId: r.toolId,
    status: r.status,
    vin: r.vin,
    make: r.make,
    model: r.model,
    year: r.year,
    parkIt: r.riskFacts?.parkIt ?? null,
    parkOutside: r.riskFacts?.parkOutside ?? null,
    campaigns: r.riskFacts?.campaignNumbers?.slice(0, 8) ?? [],
    campaignCountReported: r.riskFacts?.campaignCountReported ?? null,
    complaints: r.riskFacts?.complaintCount ?? null,
    sourceUrl: r.sourceUrl ?? r.riskFacts?.sourceUrl ?? null,
  }));
  rows.sort((a, b) =>
    `${a.checkId}|${a.vin}|${a.make}|${a.model}|${a.year}`.localeCompare(
      `${b.checkId}|${b.vin}|${b.make}|${b.model}|${b.year}`,
    ),
  );
  return JSON.stringify(rows);
}

function toListingStub(row: ObservedListingRow & { vin?: string | null }): Listing | null {
  const vin = typeof row.vin === "string" ? row.vin.trim().toUpperCase() : "";
  // vPIC requires VIN; recalls/safety can run with make/model/year and a placeholder vin field.
  return {
    vin: vin || `UNKNOWN-${row.make}-${row.model}-${row.year}`.slice(0, 32),
    year: row.year,
    make: row.make,
    model: row.model,
    trim: null,
    miles: row.miles ?? null,
    priceUsd: row.priceUsd ?? null,
    city: null,
    state: null,
    zip: null,
    dealer: null,
    vdp: null,
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: null,
    accidentCount: null,
    oneOwner: null,
    ownerCount: null,
    usageType: null,
    fuel: null,
    engine: null,
    drivetrain: null,
    bodyStyle: null,
    latitude: null,
    longitude: null,
    removedAt: null,
    source: "autodev",
  };
}


/** Bounded free-gov batch size — finite progress per apply; continues across loops. */
export const FIND_FREE_GOV_BATCH_MAX = 3;

export type FreeGovToolCoverageSlice = {
  checked: number;
  unchecked: number;
  /** MMYs eligible for this tool (vPIC requires VIN). */
  eligible: number;
};

export type FreeGovToolCoverage = {
  listingMmyCount: number;
  recalls: FreeGovToolCoverageSlice;
  safety: FreeGovToolCoverageSlice;
  vpic: FreeGovToolCoverageSlice;
  anyUnchecked: boolean;
  note: string;
};

/** MMY keys already receipted for a specific free-gov check (any status — attempt counts). */
export function checkedMmyKeysForCheck(
  receipts: readonly FindFreeGovReceipt[],
  checkId: FindFreeGovCheckId,
): Set<string> {
  const keys = new Set<string>();
  for (const r of receipts) {
    if (r.checkId !== checkId) continue;
    keys.add(mmyListingKey(r.make, r.model, r.year));
  }
  return keys;
}

function listingRowsWithVin(
  listings: readonly (ObservedListingRow & { vin?: string | null })[],
): (ObservedListingRow & { vin?: string | null })[] {
  return listings.filter((l) => typeof l.vin === "string" && l.vin.trim().length >= 11);
}

/** Per-tool coverage vs listing MMY inventory — drives allowlist continuation. */
export function freeGovToolCoverage(
  listings: readonly (ObservedListingRow & { vin?: string | null })[],
  receipts: readonly FindFreeGovReceipt[],
): FreeGovToolCoverage {
  const allKeys = listingMmyKeys(listings);
  const vinKeys = listingMmyKeys(listingRowsWithVin(listings));
  const recallsChecked = checkedMmyKeysForCheck(receipts, "free_gov_recalls");
  const safetyChecked = checkedMmyKeysForCheck(receipts, "free_gov_safety");
  const vpicChecked = checkedMmyKeysForCheck(receipts, "free_gov_vpic");
  const recalls = {
    checked: [...recallsChecked].filter((k) => allKeys.has(k)).length,
    unchecked: Math.max(0, allKeys.size - [...recallsChecked].filter((k) => allKeys.has(k)).length),
    eligible: allKeys.size,
  };
  const safety = {
    checked: [...safetyChecked].filter((k) => allKeys.has(k)).length,
    unchecked: Math.max(0, allKeys.size - [...safetyChecked].filter((k) => allKeys.has(k)).length),
    eligible: allKeys.size,
  };
  const vpicCheckedIn = [...vpicChecked].filter((k) => vinKeys.has(k)).length;
  const vpic = {
    checked: vpicCheckedIn,
    unchecked: Math.max(0, vinKeys.size - vpicCheckedIn),
    eligible: vinKeys.size,
  };
  const anyUnchecked = recalls.unchecked > 0 || safety.unchecked > 0 || vpic.unchecked > 0;
  const note =
    allKeys.size === 0
      ? "No listing MMY keys for free public coverage."
      : anyUnchecked
        ? `Free NHTSA progress — recalls ${recalls.checked}/${recalls.eligible} MMY, safety ${safety.checked}/${safety.eligible}, vpic ${vpic.checked}/${vpic.eligible} VIN-eligible. Unchecked remain — not fleet-cleared; not VIN history.`
        : `Free NHTSA sample exhausted eligible MMYs (recalls ${recalls.checked}, safety ${safety.checked}, vpic ${vpic.checked}). Still MMY-scope only — not VIN unrepaired/title clearance.`;
  return {
    listingMmyCount: allKeys.size,
    recalls,
    safety,
    vpic,
    anyUnchecked,
    note,
  };
}

export function freeGovCheckStillHasUnchecked(
  coverage: FreeGovToolCoverage,
  checkId: FindFreeGovCheckId,
): boolean {
  if (checkId === "free_gov_recalls") return coverage.recalls.unchecked > 0;
  if (checkId === "free_gov_safety") return coverage.safety.unchecked > 0;
  return coverage.vpic.unchecked > 0 && coverage.vpic.eligible > 0;
}

/**
 * Pick up to FIND_FREE_GOV_BATCH_MAX distinct MMY cards for one free-gov tool.
 * Prefers unchecked MMYs for this checkId (prior receipts) — never forever repeats the first 3.
 * Attempted MMYs (ok/empty/error/unavailable) are skipped so errors do not spin.
 */
export function selectFindFreeGovCandidates(
  listings: readonly (ObservedListingRow & { vin?: string | null })[],
  checkId: FindFreeGovCheckId,
  max = FIND_FREE_GOV_BATCH_MAX,
  priorReceipts: readonly FindFreeGovReceipt[] = [],
): Listing[] {
  const withVin = listings.filter((l) => typeof l.vin === "string" && l.vin.trim().length >= 11);
  const pool = checkId === "free_gov_vpic" ? withVin : listings;
  const already = checkedMmyKeysForCheck(priorReceipts, checkId);
  const seen = new Set<string>();
  const unchecked: Listing[] = [];
  const fallback: Listing[] = [];
  for (const row of pool) {
    const key = mmyListingKey(row.make, row.model, row.year);
    if (seen.has(key)) continue;
    const stub = toListingStub(row);
    if (!stub) continue;
    if (checkId === "free_gov_vpic" && stub.vin.startsWith("UNKNOWN-")) continue;
    seen.add(key);
    if (already.has(key)) {
      // Already attempted for this tool — do not re-select (no spin / no fake new evidence).
      continue;
    }
    unchecked.push(stub);
    if (unchecked.length >= max) break;
  }
  // Only unchecked MMYs — empty means coverage complete for this tool on current inventory.
  void fallback;
  return unchecked.slice(0, max);
}

function packetToReceipt(
  checkId: FindFreeGovCheckId,
  listing: Listing,
  packet: FreeGovEvidencePacket,
): FindFreeGovReceipt {
  const realVin = listing.vin.startsWith("UNKNOWN-") ? null : listing.vin;
  const factNotes = packet.facts
    .map((f) => (typeof f.note === "string" ? f.note.slice(0, 220) : ""))
    .filter(Boolean)
    .slice(0, 6);
  const riskFacts = riskFactsFromPacket(packet, listing);
  return {
    checkId,
    toolId: packet.toolId,
    status: packet.status,
    summary: packet.summary.replace(/\s*\(cached\)\s*$/i, "").slice(0, 400),
    scope: packet.scope.slice(0, 200),
    limitsNote: packet.limitsNote.slice(0, 280),
    vin: realVin,
    make: listing.make,
    model: listing.model,
    year: listing.year,
    fetchedAt: packet.fetchedAt,
    cached: packet.cached,
    sourceUrl: packet.url,
    factNotes,
    riskFacts,
    honesty:
      checkId === "free_gov_vpic"
        ? "vPIC decode ≠ clean VIN history; ErrorCode must be inspected; missing VIN stays unknown."
        : checkId === "free_gov_recalls"
          ? "Make/model/year recalls/complaints ≠ VIN-specific unrepaired/open recall status. parkIt ≠ parkOutside."
          : "NCAP SafetyRatings are make/model/year class ratings — Not Rated stays unknown, never 0-star invent.",
  };
}

export type ExecuteFindFreeGovResult = {
  checkId: FindFreeGovCheckId;
  toolId: FreeGovToolId;
  receipts: FindFreeGovReceipt[];
  /** True when at least one lookup ran (ok/empty/error) — evidence state changed. */
  evidenceChanged: boolean;
  note: string;
};

/**
 * Execute one allowlisted free Find check against recorded listings.
 * Inject port for offline tests (unsupported / mock). Live uses createLiveFreeGovPort.
 */
export async function executeFindFreeGovCheck(input: {
  checkId: FindNextCheckId | string;
  listings: readonly (ObservedListingRow & { vin?: string | null })[];
  /** Prior receipts — next batch prefers unchecked MMYs for this checkId. */
  priorReceipts?: readonly FindFreeGovReceipt[];
  gov?: ScoutFreeGovPort;
}): Promise<ExecuteFindFreeGovResult | null> {
  if (!isFindFreeGovCheckId(input.checkId)) return null;
  const checkId = input.checkId;
  const toolId = findFreeGovToolIdForCheck(checkId);
  if (!isFreeGovToolId(toolId)) return null;

  const prior = input.priorReceipts ?? [];
  const coverage = freeGovToolCoverage(input.listings, prior);
  const candidates = selectFindFreeGovCandidates(input.listings, checkId, FIND_FREE_GOV_BATCH_MAX, prior);
  if (candidates.length === 0) {
    const covered = !freeGovCheckStillHasUnchecked(coverage, checkId);
    return {
      checkId,
      toolId,
      receipts: [],
      // No new MMYs — do not fake evidence progress / loop spin.
      evidenceChanged: false,
      note:
        checkId === "free_gov_vpic" && coverage.vpic.eligible === 0
          ? "free_gov_vpic skipped — no VIN on returned cards; VIN decode stays unknown (not a clean-history claim)."
          : covered
            ? `${checkId} coverage complete for current listing MMYs (${coverage.note}). Not VIN/title clearance.`
            : `${checkId} skipped — no listing identity for free public lookup.`,
    };
  }

  const gov = input.gov ?? createLiveFreeGovPort();
  const receipts: FindFreeGovReceipt[] = [];
  for (const listing of candidates) {
    const packet = await gov.run(toolId, listing);
    receipts.push(packetToReceipt(checkId, listing, packet));
  }

  const okish = receipts.filter((r) => r.status === "ok" || r.status === "empty").length;
  const failed = receipts.length - okish;
  const perCard = receipts
    .map((r) => `${r.year} ${r.make} ${r.model}: ${r.status} — ${r.summary.slice(0, 120)}`)
    .slice(0, 3)
    .join(" | ");
  const after = freeGovToolCoverage(input.listings, [...prior, ...receipts]);
  return {
    checkId,
    toolId,
    receipts,
    evidenceChanged: true,
    note: `Free ${toolId} batch ${receipts.length} unchecked MMY(s): ${okish} ok/empty, ${failed} unavailable/error. ${perCard}. Progress: ${after.note} ${receipts[0]?.honesty ?? ""} No Report credit. Not NMVTIS/title clearance.`,
  };
}

/** Compact card preview size for SERV briefs — full allCoverage always retained. */
export const FREE_GOV_BRIEF_CARD_PREVIEW = 6;

/** Planner-facing brief from stored receipts (structured risk — not summary-only). */
export function freeGovReceiptsBrief(receipts: readonly FindFreeGovReceipt[]): {
  count: number;
  cardsShown: number;
  cardsTruncated: boolean;
  truncationNote: string | null;
  toolIds: string[];
  statuses: string[];
  summaries: string[];
  /** Every receipt key — inspectable even when cards preview is truncated. */
  allCoverage: Array<{
    checkId: string;
    toolId: string;
    status: string;
    make: string;
    model: string;
    year: number;
    sourceUrl: string | null;
    parkIt: boolean | null;
    parkOutside: boolean | null;
    campaignIdsShown: number;
    campaignCountReported: number | null;
    complaintCount: number | null;
  }>;
  cards: Array<{
    make: string;
    model: string;
    year: number;
    status: string;
    summary: string;
    scope: string;
    sourceUrl: string | null;
    toolId: string;
    factNotes: string[];
    honesty: string;
    riskFacts: FreeGovRiskFacts | null;
  }>;
} {
  const preview = FREE_GOV_BRIEF_CARD_PREVIEW;
  const truncated = receipts.length > preview;
  return {
    count: receipts.length,
    cardsShown: Math.min(preview, receipts.length),
    cardsTruncated: truncated,
    truncationNote: truncated
      ? `SERV brief cards show ${preview} of ${receipts.length} receipts — allCoverage retains every MMY claim (source/status/tool); not silent clearance of hidden rows.`
      : null,
    toolIds: [...new Set(receipts.map((r) => r.toolId))],
    statuses: receipts.map((r) => r.status),
    summaries: receipts.map((r) => r.summary.slice(0, 160)),
    allCoverage: receipts.map((r) => ({
      checkId: r.checkId,
      toolId: r.toolId,
      status: r.status,
      make: r.make,
      model: r.model,
      year: r.year,
      sourceUrl: r.sourceUrl,
      parkIt: r.riskFacts?.parkIt ?? null,
      parkOutside: r.riskFacts?.parkOutside ?? null,
      campaignIdsShown: r.riskFacts?.campaignNumbers.length ?? 0,
      campaignCountReported: r.riskFacts?.campaignCountReported ?? null,
      complaintCount: r.riskFacts?.complaintCount ?? null,
    })),
    cards: receipts.slice(0, preview).map((r) => ({
      make: r.make,
      model: r.model,
      year: r.year,
      status: r.status,
      summary: r.summary.slice(0, 220),
      scope: r.scope.slice(0, 120),
      sourceUrl: r.sourceUrl,
      toolId: r.toolId,
      factNotes: r.factNotes.slice(0, 4),
      honesty: r.honesty.slice(0, 200),
      riskFacts: r.riskFacts
        ? {
            ...r.riskFacts,
            campaignNumbers: r.riskFacts.campaignNumbers.slice(0, 8),
            campaignCountReported:
              r.riskFacts.campaignCountReported != null
                ? Math.max(
                    r.riskFacts.campaignCountReported,
                    r.riskFacts.campaignNumbers.length,
                  )
                : r.riskFacts.campaignNumbers.length > 0
                  ? r.riskFacts.campaignNumbers.length
                  : null,
          }
        : null,
    })),
  };
}

