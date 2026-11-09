/**
 * Ordinary Find free vehicle checks — reuses Scout free-gov port
 * (vPIC / recalls / NCAP / FuelEconomy.gov).
 * No paid NMVTIS / Auto.dev spend. No Report credit. Never invents clean history.
 * FuelEconomy matches that are ambiguous stay a labeled min..max range.
 */
import type { ObservedListingRow } from "./find-model-observe";
import { fuelFactFromFindEvidence, type FindFuelEvidence } from "./find-fuel-match";
import type { FindNextCheckId } from "./find-next-checks";
import { recallEvidenceState, recallFactPlain, type EvidenceFact } from "./find-evidence-state";
import {
  listingMmyKeys,
  mmyListingKey,
  riskFactsFromPacket,
  type FreeGovRiskFacts,
} from "./find-risk-evidence";
import {
  createLiveFreeGovPort,
  freeGovProcessCache,
  isFreeGovToolId,
  type FreeGovEvidencePacket,
  type FreeGovToolId,
  type ScoutFreeGovPort,
} from "./scout/free-gov";
import type { FuelFact, Listing } from "./types";

export const FIND_FREE_GOV_CHECK_IDS = [
  "free_gov_recalls",
  "free_gov_vpic",
  "free_gov_safety",
  "free_gov_fuel",
] as const;

export type FindFreeGovCheckId = (typeof FIND_FREE_GOV_CHECK_IDS)[number];

export function isFindFreeGovCheckId(id: string): id is FindFreeGovCheckId {
  return (FIND_FREE_GOV_CHECK_IDS as readonly string[]).includes(id);
}

export function findFreeGovToolIdForCheck(id: FindFreeGovCheckId): FreeGovToolId {
  if (id === "free_gov_recalls") return "evidence.gov_recalls";
  if (id === "free_gov_vpic") return "evidence.gov_vpic";
  if (id === "free_gov_fuel") return "evidence.gov_fuel";
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
  /** Source URL when the free public endpoint was called (planner + machine channel). */
  sourceUrl: string | null;
  /** Short planner-facing notes — never raw HTTP bodies. */
  factNotes: string[];
  /** Structured risk facts — not summary-only; drives grounded shortlist risk. */
  riskFacts: FreeGovRiskFacts | null;
  /** Structured fuel evidence when checkId is free_gov_fuel. */
  fuelEvidence: FindFuelEvidence | null;
  honesty: string;
  /**
   * VIN spec fields from the same vPIC decode (ErrorCode=0 only).
   * Absent on older receipts and on non-decode checks.
   */
  vpicSpecs?: {
    year: number | null;
    make: string | null;
    model: string | null;
    trim: string | null;
    drivetrain: string | null;
    engine: string | null;
    fuel: string | null;
  } | null;
  /** Four-state facts for this receipt. Derived when missing on older rows. */
  evidenceFacts?: import("./find-evidence-state").EvidenceFact[];
};

/**
 * Stable fingerprint for loop guards.
 * Uses structured risk/fuel fields — ignores cached summary suffixes so duplicate
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
    fuelMatch: r.fuelEvidence?.match ?? null,
    fuelAnnualLow: r.fuelEvidence?.annualFuelUsdLow ?? null,
    fuelAnnualHigh: r.fuelEvidence?.annualFuelUsdHigh ?? null,
    fuelAmbiguous: r.fuelEvidence?.ambiguous ?? null,
  }));
  rows.sort((a, b) =>
    `${a.checkId}|${a.vin}|${a.make}|${a.model}|${a.year}`.localeCompare(
      `${b.checkId}|${b.vin}|${b.make}|${b.model}|${b.year}`,
    ),
  );
  return JSON.stringify(rows);
}

function toListingStub(
  row: ObservedListingRow & {
    vin?: string | null;
    trim?: string | null;
    engine?: string | null;
    drivetrain?: string | null;
  },
): Listing | null {
  const vin = typeof row.vin === "string" ? row.vin.trim().toUpperCase() : "";
  // vPIC requires VIN; recalls/safety/fuel can run with make/model/year and a placeholder vin field.
  return {
    vin: vin || `UNKNOWN-${row.make}-${row.model}-${row.year}`.slice(0, 32),
    year: row.year,
    make: row.make,
    model: row.model,
    trim: row.trim ?? null,
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
    engine: row.engine ?? null,
    drivetrain: row.drivetrain ?? null,
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
  /** Present on current coverage; optional for older stored/planner snapshots. */
  fuel?: FreeGovToolCoverageSlice;
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
  const fuelChecked = checkedMmyKeysForCheck(receipts, "free_gov_fuel");
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
  const fuel = {
    checked: [...fuelChecked].filter((k) => allKeys.has(k)).length,
    unchecked: Math.max(0, allKeys.size - [...fuelChecked].filter((k) => allKeys.has(k)).length),
    eligible: allKeys.size,
  };
  const anyUnchecked =
    recalls.unchecked > 0 || safety.unchecked > 0 || vpic.unchecked > 0 || fuel.unchecked > 0;
  const note =
    allKeys.size === 0
      ? "No cars to check against public recall, safety, or fuel records yet."
      : anyUnchecked
        ? `Public checks in progress — recalls ${recalls.checked}/${recalls.eligible}, safety ${safety.checked}/${safety.eligible}, VIN decode ${vpic.checked}/${vpic.eligible}, fuel ${fuel.checked}/${fuel.eligible}. Recall and crash-test data are per model and year, not for this exact car’s VIN.`
        : `Public checks finished for these cards (recalls ${recalls.checked}, safety ${safety.checked}, VIN decode ${vpic.checked}, fuel ${fuel.checked}). Recall and crash-test data are per model and year, not for this exact car’s VIN.`;
  return {
    listingMmyCount: allKeys.size,
    recalls,
    safety,
    vpic,
    fuel,
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
  if (checkId === "free_gov_fuel") return (coverage.fuel?.unchecked ?? 0) > 0;
  return coverage.vpic.unchecked > 0 && coverage.vpic.eligible > 0;
}

/**
 * Pick up to FIND_FREE_GOV_BATCH_MAX distinct MMY cards for one free-gov tool.
 * Prefers unchecked MMYs for this checkId (prior receipts) — never forever repeats the first 3.
 * Attempted MMYs (ok/empty/error/unavailable) are skipped so errors do not spin.
 */
export function selectFindFreeGovCandidates(
  listings: readonly (ObservedListingRow & {
    vin?: string | null;
    trim?: string | null;
    engine?: string | null;
    drivetrain?: string | null;
  })[],
  checkId: FindFreeGovCheckId,
  max = FIND_FREE_GOV_BATCH_MAX,
  priorReceipts: readonly FindFreeGovReceipt[] = [],
  /** When set, only these car keys (VIN or year|make|model…) are eligible. */
  targetKeys?: readonly string[],
): Listing[] {
  const targets = new Set((targetKeys ?? []).map((key) => key.trim().toUpperCase()).filter(Boolean));
  const matchesTarget = (row: { vin?: string | null; year: number; make: string; model: string; priceUsd?: number | null; miles?: number | null }) => {
    if (targets.size === 0) return true;
    const vin = typeof row.vin === "string" ? row.vin.trim().toUpperCase() : "";
    if (vin && targets.has(vin)) return true;
    const loose = `${row.year}|${row.make}|${row.model}|${row.priceUsd ?? ""}|${row.miles ?? ""}`.toLowerCase();
    for (const target of targets) {
      if (target.toLowerCase() === loose) return true;
    }
    return false;
  };
  const scoped = targets.size > 0 ? listings.filter((row) => matchesTarget(row)) : listings;
  const withVin = scoped.filter((l) => typeof l.vin === "string" && l.vin.trim().length >= 11);
  const pool = checkId === "free_gov_vpic" ? withVin : scoped;
  const already = checkedMmyKeysForCheck(priorReceipts, checkId);
  const seen = new Set<string>();
  const unchecked: Listing[] = [];
  for (const row of pool) {
    const key = mmyListingKey(row.make, row.model, row.year);
    if (seen.has(key)) continue;
    const stub = toListingStub(row);
    if (!stub) continue;
    if (checkId === "free_gov_vpic" && stub.vin.startsWith("UNKNOWN-")) continue;
    seen.add(key);
    if (already.has(key)) {
      continue;
    }
    unchecked.push(stub);
    if (unchecked.length >= max) break;
  }
  return unchecked.slice(0, max);
}

function vpicSpecsFromPacket(packet: FreeGovEvidencePacket): FindFreeGovReceipt["vpicSpecs"] {
  if (packet.toolId !== "evidence.gov_vpic" || packet.status !== "ok") return null;
  const primary = packet.facts.find((fact) => fact.key === "evidence.gov_vpic");
  const value =
    primary && primary.value && typeof primary.value === "object"
      ? (primary.value as Record<string, unknown>)
      : null;
  if (!value) return null;
  const text = (key: string) => (typeof value[key] === "string" && value[key] ? String(value[key]) : null);
  const year = typeof value.year === "number" ? value.year : null;
  return {
    year,
    make: text("make"),
    model: text("model"),
    trim: text("trim"),
    drivetrain: text("driveType") ?? text("drivetrain"),
    engine: text("engine"),
    fuel: text("fuel"),
  };
}

function evidenceFactsForPacket(
  checkId: FindFreeGovCheckId,
  listing: { year: number; make: string; model: string },
  packet: FreeGovEvidencePacket,
  riskFacts: FreeGovRiskFacts,
): EvidenceFact[] {
  const title = `${listing.year} ${listing.make} ${listing.model}`;
  if (checkId === "free_gov_recalls") {
    const state = recallEvidenceState({ status: packet.status, riskFacts });
    return [
      {
        field: "recall_campaigns",
        state,
        source: "government",
        plain: recallFactPlain({ status: packet.status, riskFacts }, title),
      },
    ];
  }
  if (checkId === "free_gov_safety") {
    const state =
      packet.status === "ok" ? "none_found" : packet.status === "empty" || packet.status === "error" || packet.status === "unavailable" ? "could_not_check" : "could_not_check";
    return [
      {
        field: "crash_rating",
        state,
        source: "government",
        plain:
          state === "could_not_check"
            ? `${title}: Couldn't confirm crash-test ratings. That is not a clean result.`
            : `${title}: Crash-test ratings were checked for this year/make/model class.`,
      },
    ];
  }
  if (checkId === "free_gov_vpic") {
    const state = packet.status === "ok" ? "none_found" : "could_not_check";
    return [
      {
        field: "vin_decode",
        state,
        source: "government",
        plain:
          state === "could_not_check"
            ? `${title}: Couldn't confirm a VIN decode. That is not a clean history.`
            : `${title}: VIN decoded (specs only — not a clean history).`,
      },
    ];
  }
  return [];
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
  const fuelEvidence = checkId === "free_gov_fuel" ? packet.fuelEvidence ?? null : null;
  const vpicSpecs = vpicSpecsFromPacket(packet);
  const evidenceFacts = evidenceFactsForPacket(checkId, listing, packet, riskFacts);
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
    fuelEvidence,
    vpicSpecs,
    evidenceFacts,
    honesty:
      checkId === "free_gov_vpic"
        ? "VIN decode ≠ clean VIN history; incomplete decode stays unknown."
        : checkId === "free_gov_recalls"
          ? "Year/make/model recalls/complaints ≠ VIN-specific unrepaired/open recall status."
          : checkId === "free_gov_fuel"
            ? "FuelEconomy.gov estimate with labeled assumptions — not full ownership cost; ambiguous configs stay a range."
            : "Crash-test ratings are year/make/model class ratings — Not Rated stays unknown, never 0-star invent.",
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
  listings: readonly (ObservedListingRow & {
    vin?: string | null;
    trim?: string | null;
    engine?: string | null;
    drivetrain?: string | null;
  })[];
  /** Prior receipts — next batch prefers unchecked MMYs for this checkId. */
  priorReceipts?: readonly FindFreeGovReceipt[];
  gov?: ScoutFreeGovPort;
  /** Shopper note for city-heavy fuel assumptions when using the live port. */
  shopperNote?: string | null;
  /** Per-car checks run only on these keys (fallback is the caller's top 3). */
  targetKeys?: readonly string[];
}): Promise<ExecuteFindFreeGovResult | null> {
  if (!isFindFreeGovCheckId(input.checkId)) return null;
  const checkId = input.checkId;
  const toolId = findFreeGovToolIdForCheck(checkId);
  if (!isFreeGovToolId(toolId)) return null;

  const prior = input.priorReceipts ?? [];
  const coverage = freeGovToolCoverage(input.listings, prior);
  const candidates = selectFindFreeGovCandidates(
    input.listings,
    checkId,
    FIND_FREE_GOV_BATCH_MAX,
    prior,
    input.targetKeys,
  );
  if (candidates.length === 0) {
    const covered = !freeGovCheckStillHasUnchecked(coverage, checkId);
    const plainTool =
      checkId === "free_gov_recalls"
        ? "Recall"
        : checkId === "free_gov_safety"
          ? "Crash-rating"
          : checkId === "free_gov_fuel"
            ? "FuelEconomy.gov"
            : "VIN decode";
    return {
      checkId,
      toolId,
      receipts: [],
      // No new MMYs — do not fake evidence progress / loop spin.
      evidenceChanged: false,
      note:
        checkId === "free_gov_vpic" && coverage.vpic.eligible === 0
          ? "VIN decode skipped — no VIN on returned cards; VIN decode stays unknown (not a clean-history claim)."
          : covered
            ? `${plainTool} coverage complete for current listing year/make/model rows. Not VIN/title clearance.`
            : `${plainTool} skipped — no listing identity for free public lookup.`,
    };
  }

  const gov =
    input.gov ??
    createLiveFreeGovPort({
      shopperNote: input.shopperNote ?? null,
      cache: freeGovProcessCache(),
    });
  const receipts: FindFreeGovReceipt[] = [];
  for (const listing of candidates) {
    const packet = await gov.run(toolId, listing);
    receipts.push(packetToReceipt(checkId, listing, packet));
  }

  const okish = receipts.filter((r) => r.status === "ok" || r.status === "empty").length;
  const failed = receipts.length - okish;
  const scrubMachineIds = (text: string) =>
    text
      .replace(/\bfree_gov_(?:recalls|vpic|safety|fuel)\b/g, "free public check")
      .replace(/\bevidence\.gov_(?:recalls|vpic|safety|fuel)\b/g, "government data");
  const perCard = receipts
    .map(
      (r) =>
        `${r.year} ${r.make} ${r.model}: ${r.status} — ${scrubMachineIds(r.summary).slice(0, 120)}`,
    )
    .slice(0, 3)
    .join(" | ");
  const after = freeGovToolCoverage(input.listings, [...prior, ...receipts]);
  const plainTool =
    checkId === "free_gov_recalls"
      ? "recall"
      : checkId === "free_gov_safety"
        ? "crash-rating"
        : checkId === "free_gov_fuel"
          ? "FuelEconomy.gov"
          : "VIN decode";
  return {
    checkId,
    toolId,
    receipts,
    evidenceChanged: true,
    // Plain English only — never raw checkId / toolId (owner rule for any surface that may echo notes).
    note: scrubMachineIds(
      `Free public ${plainTool} batch ${receipts.length} unchecked year/make/model: ${okish} ok/empty, ${failed} unavailable/error. ${perCard}. Progress: ${after.note} ${receipts[0]?.honesty ?? ""} No Report credit. Not NMVTIS/title clearance.`,
    ),
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
    fuelMatch: string | null;
    fuelAnnualLow: number | null;
    fuelAnnualHigh: number | null;
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
    fuelEvidence: FindFuelEvidence | null;
  }>;
} {
  const preview = FREE_GOV_BRIEF_CARD_PREVIEW;
  const truncated = receipts.length > preview;
  return {
    count: receipts.length,
    cardsShown: Math.min(preview, receipts.length),
    cardsTruncated: truncated,
    truncationNote: truncated
      ? `SERV brief cards show ${preview} of ${receipts.length} receipts — allCoverage retains every year/make/model claim (source/status/tool); not silent clearance of hidden rows.`
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
      fuelMatch: r.fuelEvidence?.match ?? null,
      fuelAnnualLow: r.fuelEvidence?.annualFuelUsdLow ?? null,
      fuelAnnualHigh: r.fuelEvidence?.annualFuelUsdHigh ?? null,
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
      fuelEvidence: r.fuelEvidence,
    })),
  };
}

/** Build fuelsByModelKey from free_gov_fuel receipts for compare/shortlist. */
export function fuelsByModelKeyFromReceipts(
  receipts: readonly FindFreeGovReceipt[],
): Record<string, FuelFact | null> {
  const out: Record<string, FuelFact | null> = {};
  for (const r of receipts) {
    if (r.checkId !== "free_gov_fuel" || !r.fuelEvidence) continue;
    const key = `${r.make}\0${r.model}`.toLowerCase();
    const fact = fuelFactFromFindEvidence(r.fuelEvidence);
    // Prefer exact over ambiguous when multiple years collide on model key.
    if (!out[key] || (fact && fact.match === "closest_config")) {
      out[key] = fact;
    }
  }
  return out;
}
