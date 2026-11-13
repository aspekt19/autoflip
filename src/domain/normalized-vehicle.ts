/**
 * Normalized per-VIN vehicle record.
 *
 * Facts about one car arrive from many sources (feed, page, vPIC, fuel, recalls,
 * complaints, safety, comps). This module merges them into a single record keyed
 * by VIN, records provenance of every field, and never invents values.
 *
 * Listing URLs must pass an http(s) check — otherwise the record has no link.
 * Source attempts are recorded as queried-with-data / empty / unavailable|error;
 * code never judges content quality, and a missing source never blocks SERV.
 */
import { buyerListingHref } from "@/domain/find-listing-link";
import type { EvidenceSourceRow, EvidenceStatus } from "@/domain/serv-evidence-gate";
import type { FuelFact, Listing, VinDecode } from "@/domain/types";

export type VehicleFieldSource =
  | "page"
  | "feed"
  | "vpic"
  | "fuel_economy"
  | "nhtsa_recalls"
  | "nhtsa_complaints"
  | "nhtsa_safety"
  | "market_comps"
  | "user"
  | "merged";

export type ProvenancedValue<T> = {
  value: T;
  source: VehicleFieldSource | null;
  /** Shopper-facing provenance label. */
  label: string | null;
};

export type VehicleSourceAttemptId =
  | "listing_feed"
  | "listing_page"
  | "vin_decode"
  | "fuel_economy"
  | "recalls"
  | "complaints"
  | "safety_ratings"
  | "market_comps"
  | "flip_pnl";

/** Attempt-only statuses. Code records the attempt; it does not judge content. */
export type VehicleSourceAttemptStatus =
  | "queried_with_data"
  | "empty"
  | "unavailable"
  | "error"
  | "not_attempted";

export type VehicleSourceAttempt = {
  source: VehicleSourceAttemptId;
  label: string;
  status: VehicleSourceAttemptStatus;
};

export type NormalizedVehicleRecord = {
  vin: string;
  year: ProvenancedValue<number | null>;
  make: ProvenancedValue<string | null>;
  model: ProvenancedValue<string | null>;
  trim: ProvenancedValue<string | null>;
  priceUsd: ProvenancedValue<number | null>;
  miles: ProvenancedValue<number | null>;
  zip: ProvenancedValue<string | null>;
  city: ProvenancedValue<string | null>;
  state: ProvenancedValue<string | null>;
  dealer: ProvenancedValue<string | null>;
  /** Absolute http(s) listing URL only — never an Auto.dev fragment id. */
  listingUrl: ProvenancedValue<string | null>;
  drivetrain: ProvenancedValue<string | null>;
  fuelType: ProvenancedValue<string | null>;
  engine: ProvenancedValue<string | null>;
  bodyStyle: ProvenancedValue<string | null>;
  distanceMiles: ProvenancedValue<number | null>;
  combMpg: ProvenancedValue<number | null>;
  complaintCount: ProvenancedValue<number | null>;
  recallCount: ProvenancedValue<number | null>;
  accidentCount: ProvenancedValue<number | null>;
  ownerCount: ProvenancedValue<number | null>;
  sourceAttempts: VehicleSourceAttempt[];
};

const SOURCE_LABELS: Record<VehicleFieldSource, string> = {
  page: "listing page",
  feed: "from data feed listing",
  vpic: "government VIN decoder",
  fuel_economy: "FuelEconomy.gov",
  nhtsa_recalls: "NHTSA recalls",
  nhtsa_complaints: "NHTSA complaints",
  nhtsa_safety: "NHTSA safety ratings",
  market_comps: "market comps",
  user: "typed by shopper",
  merged: "merged from sources",
};

export const VEHICLE_SOURCE_ATTEMPT_LABELS: Record<VehicleSourceAttemptId, string> = {
  listing_feed: "Listing feed",
  listing_page: "Listing page",
  vin_decode: "VIN decode",
  fuel_economy: "Fuel economy",
  recalls: "Recalls",
  complaints: "Complaints",
  safety_ratings: "Safety ratings",
  market_comps: "Market comps",
  flip_pnl: "Flip P&L",
};

function field<T>(value: T, source: VehicleFieldSource | null): ProvenancedValue<T> {
  return {
    value,
    source,
    label: source ? SOURCE_LABELS[source] : null,
  };
}

/** Prefer the first non-null/non-empty candidate; record its provenance. */
export function pickProvenanced<T>(
  candidates: Array<{ value: T; source: VehicleFieldSource; empty?: (v: T) => boolean }>,
): ProvenancedValue<T | null> {
  for (const row of candidates) {
    const empty =
      row.empty?.(row.value) ??
      (row.value == null ||
        (typeof row.value === "string" && !row.value.trim()) ||
        (typeof row.value === "number" && !Number.isFinite(row.value)));
    if (empty) continue;
    return field(row.value, row.source);
  }
  return field(null, null);
}

/** Absolute http(s) listing URL, or null — never an Auto.dev `#id` fragment. */
export function normalizedListingUrl(
  ...candidates: Array<string | null | undefined>
): ProvenancedValue<string | null> {
  for (const raw of candidates) {
    const href = buyerListingHref(raw);
    if (href) {
      // Prefer page URL when it is the first http(s) candidate that passed.
      return field(href, raw === candidates[0] ? "page" : "feed");
    }
  }
  return field(null, null);
}

/**
 * Clip buyer-facing text at a word boundary. Never end mid-word (e.g. "failure r.").
 * Returns the full string when it already fits.
 */
export function clipBuyerText(text: string | null | undefined, max = 280): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const boundary = cut.lastIndexOf(" ");
  const base = (boundary > Math.floor(max * 0.6) ? cut.slice(0, boundary) : cut).trim();
  return /[.!?]$/.test(base) ? base : `${base}…`;
}

export function attemptStatusFromEvidence(status: EvidenceStatus): VehicleSourceAttemptStatus {
  switch (status) {
    case "checked":
      return "queried_with_data";
    case "empty":
      return "empty";
    case "unavailable":
      return "unavailable";
    case "error":
      return "error";
    case "not_checked":
      return "not_attempted";
  }
}

export function sourceAttemptsFromEvidenceRows(
  rows: readonly EvidenceSourceRow[],
): VehicleSourceAttempt[] {
  const map: Record<string, VehicleSourceAttemptId> = {
    recalls_complaints: "recalls",
    safety_ratings: "safety_ratings",
    vin_decode: "vin_decode",
    fuel_economy: "fuel_economy",
    market_comps: "market_comps",
    flip_pnl: "flip_pnl",
  };
  const out: VehicleSourceAttempt[] = [];
  for (const row of rows) {
    const id = map[row.source];
    if (!id) continue;
    out.push({
      source: id,
      label: VEHICLE_SOURCE_ATTEMPT_LABELS[id],
      status: attemptStatusFromEvidence(row.status),
    });
    // Split recalls_complaints into a complaints row with the same attempt status.
    if (row.source === "recalls_complaints") {
      out.push({
        source: "complaints",
        label: VEHICLE_SOURCE_ATTEMPT_LABELS.complaints,
        status: attemptStatusFromEvidence(row.status),
      });
    }
  }
  return out;
}

export function formatSourceAttemptLine(rows: readonly VehicleSourceAttempt[]): string {
  if (rows.length === 0) return "";
  return rows
    .map((r) => `${r.label} (${r.status.replace(/_/g, " ")})`)
    .join(" · ");
}

export function provenanceRowsFromRecord(
  record: NormalizedVehicleRecord,
): Array<{ field: string; value: string | number | string[] | null; source: string | null }> {
  const rows: Array<{ field: string; value: string | number | string[] | null; source: string | null }> = [];
  const push = (fieldName: string, cell: ProvenancedValue<string | number | null>) => {
    if (cell.value == null) return;
    rows.push({ field: fieldName, value: cell.value, source: cell.label });
  };
  push("vin", field(record.vin, "merged"));
  push("year", record.year);
  push("make", record.make);
  push("model", record.model);
  push("trim", record.trim);
  push("priceUsd", record.priceUsd);
  push("miles", record.miles);
  push("zip", record.zip);
  push("sellerName", record.dealer);
  push("drivetrain", record.drivetrain);
  push("fuel", record.fuelType);
  push("listingUrl", record.listingUrl);
  push("complaintCount", record.complaintCount);
  push("combMpg", record.combMpg);
  return rows;
}

export type MergeVehicleInput = {
  vin: string;
  page?: Partial<Listing> | null;
  feed?: Partial<Listing> | null;
  vpic?: VinDecode | null;
  fuel?: FuelFact | null;
  complaintCount?: number | null;
  /** True when complaints were queried (even if count is null/unavailable). */
  complaintsAttempted?: boolean;
  complaintsAvailable?: boolean | null;
  recallCount?: number | null;
  recallsAttempted?: boolean;
  recallsAvailable?: boolean | null;
  safetyAttempted?: boolean;
  safetyAvailable?: boolean | null;
  feedAttempted?: boolean;
  pageAttempted?: boolean;
  vpicAttempted?: boolean;
  fuelAttempted?: boolean;
  /** Extra attempt rows (comps, flip, evidence gate). */
  extraAttempts?: VehicleSourceAttempt[];
};

/**
 * Merge feed + page + vPIC + fuel + NHTSA into one per-VIN record with provenance.
 * Page wins for live listing ask/miles/dealer when present; feed fills gaps;
 * vPIC fills identity/drivetrain/fuel when the decode published them.
 * Listing URL is http(s) only.
 */
export function mergeVehicleSources(input: MergeVehicleInput): NormalizedVehicleRecord {
  const vin = input.vin.trim().toUpperCase();
  const page = input.page ?? null;
  const feed = input.feed ?? null;
  const vpic = input.vpic ?? null;

  const year = pickProvenanced<number | null>([
    { value: page?.year ?? null, source: "page" },
    { value: feed?.year ?? null, source: "feed" },
    { value: vpic?.year ?? null, source: "vpic" },
  ]);
  const make = pickProvenanced<string | null>([
    { value: page?.make ?? null, source: "page" },
    { value: feed?.make ?? null, source: "feed" },
    { value: vpic?.make ?? null, source: "vpic" },
  ]);
  const model = pickProvenanced<string | null>([
    { value: page?.model ?? null, source: "page" },
    { value: feed?.model ?? null, source: "feed" },
    { value: vpic?.model ?? null, source: "vpic" },
  ]);
  const trim = pickProvenanced<string | null>([
    { value: page?.trim ?? null, source: "page" },
    { value: feed?.trim ?? null, source: "feed" },
    { value: vpic?.trim ?? null, source: "vpic" },
  ]);
  // Listing economics: page first, then feed — never invent.
  const priceUsd = pickProvenanced<number | null>([
    { value: page?.priceUsd ?? null, source: "page", empty: (v) => v == null || !(v > 0) },
    { value: feed?.priceUsd ?? null, source: "feed", empty: (v) => v == null || !(v > 0) },
  ]);
  const miles = pickProvenanced<number | null>([
    { value: page?.miles ?? null, source: "page", empty: (v) => v == null || v < 0 },
    { value: feed?.miles ?? null, source: "feed", empty: (v) => v == null || v < 0 },
  ]);
  const zip = pickProvenanced<string | null>([
    { value: page?.zip ?? null, source: "page" },
    { value: feed?.zip ?? null, source: "feed" },
  ]);
  const city = pickProvenanced<string | null>([
    { value: page?.city ?? null, source: "page" },
    { value: feed?.city ?? null, source: "feed" },
  ]);
  const state = pickProvenanced<string | null>([
    { value: page?.state ?? null, source: "page" },
    { value: feed?.state ?? null, source: "feed" },
  ]);
  const dealer = pickProvenanced<string | null>([
    { value: page?.dealer ?? null, source: "page" },
    { value: feed?.dealer ?? null, source: "feed" },
  ]);
  // Prefer page URL, then feed vdp, then feed dealerUrl — http(s) only.
  const listingUrl = normalizedListingUrl(page?.vdp, feed?.vdp, feed?.dealerUrl, page?.dealerUrl);

  // Spec from vPIC when published; otherwise listing/feed.
  const drivetrain = pickProvenanced<string | null>([
    { value: vpic?.driveType ?? null, source: "vpic" },
    { value: page?.drivetrain ?? null, source: "page" },
    { value: feed?.drivetrain ?? null, source: "feed" },
  ]);
  const fuelType = pickProvenanced<string | null>([
    { value: vpic?.fuel ?? null, source: "vpic" },
    { value: page?.fuel ?? null, source: "page" },
    { value: feed?.fuel ?? null, source: "feed" },
  ]);
  const engine = pickProvenanced<string | null>([
    { value: vpic?.engine ?? null, source: "vpic" },
    { value: page?.engine ?? null, source: "page" },
    { value: feed?.engine ?? null, source: "feed" },
  ]);
  const bodyStyle = pickProvenanced<string | null>([
    { value: vpic?.bodyClass ?? null, source: "vpic" },
    { value: page?.bodyStyle ?? null, source: "page" },
    { value: feed?.bodyStyle ?? null, source: "feed" },
  ]);
  const distanceMiles = pickProvenanced<number | null>([
    { value: page?.distanceMiles ?? null, source: "page" },
    { value: feed?.distanceMiles ?? null, source: "feed" },
  ]);
  const accidentCount = pickProvenanced<number | null>([
    { value: page?.accidentCount ?? null, source: "page" },
    { value: feed?.accidentCount ?? null, source: "feed" },
  ]);
  const ownerCount = pickProvenanced<number | null>([
    { value: page?.ownerCount ?? null, source: "page" },
    { value: feed?.ownerCount ?? null, source: "feed" },
  ]);

  const combMpg = field(
    input.fuel?.combMpg ?? null,
    input.fuel?.combMpg != null ? "fuel_economy" : null,
  );
  const complaintCount = field(
    input.complaintCount ?? null,
    input.complaintsAttempted
      ? input.complaintsAvailable === false
        ? null
        : "nhtsa_complaints"
      : input.complaintCount != null
        ? "nhtsa_complaints"
        : null,
  );
  const recallCount = field(
    input.recallCount ?? null,
    input.recallsAttempted || input.recallCount != null ? "nhtsa_recalls" : null,
  );

  const sourceAttempts: VehicleSourceAttempt[] = [];
  const pushAttempt = (
    source: VehicleSourceAttemptId,
    status: VehicleSourceAttemptStatus,
  ) => {
    sourceAttempts.push({
      source,
      label: VEHICLE_SOURCE_ATTEMPT_LABELS[source],
      status,
    });
  };

  if (input.pageAttempted) {
    pushAttempt(
      "listing_page",
      page && (page.priceUsd != null || page.miles != null || page.vdp)
        ? "queried_with_data"
        : "empty",
    );
  }
  if (input.feedAttempted) {
    pushAttempt(
      "listing_feed",
      feed && (feed.priceUsd != null || feed.miles != null || feed.vdp)
        ? "queried_with_data"
        : feed
          ? "empty"
          : "unavailable",
    );
  }
  if (input.vpicAttempted) {
    pushAttempt(
      "vin_decode",
      vpic?.year && vpic.make && vpic.model
        ? "queried_with_data"
        : vpic
          ? "empty"
          : "unavailable",
    );
  }
  if (input.fuelAttempted) {
    pushAttempt(
      "fuel_economy",
      input.fuel?.combMpg != null || (input.fuel?.configsConsidered ?? 0) > 0
        ? input.fuel?.combMpg != null || input.fuel?.annualFuelCostUsd != null
          ? "queried_with_data"
          : "empty"
        : input.fuel
          ? "empty"
          : "unavailable",
    );
  }
  if (input.recallsAttempted) {
    pushAttempt(
      "recalls",
      input.recallsAvailable === false
        ? "unavailable"
        : (input.recallCount ?? 0) > 0
          ? "queried_with_data"
          : "empty",
    );
  }
  if (input.complaintsAttempted) {
    pushAttempt(
      "complaints",
      input.complaintsAvailable === false || input.complaintCount == null
        ? "unavailable"
        : input.complaintCount > 0
          ? "queried_with_data"
          : "empty",
    );
  }
  if (input.safetyAttempted) {
    pushAttempt(
      "safety_ratings",
      input.safetyAvailable === false ? "unavailable" : "queried_with_data",
    );
  }
  for (const extra of input.extraAttempts ?? []) {
    if (!sourceAttempts.some((a) => a.source === extra.source)) {
      sourceAttempts.push(extra);
    }
  }

  return {
    vin,
    year,
    make,
    model,
    trim,
    priceUsd,
    miles,
    zip,
    city,
    state,
    dealer,
    listingUrl,
    drivetrain,
    fuelType,
    engine,
    bodyStyle,
    distanceMiles,
    combMpg,
    complaintCount,
    recallCount,
    accidentCount,
    ownerCount,
    sourceAttempts,
  };
}

/** Project a normalized record onto the shared Listing shape used by comps/scoring. */
export function listingFromNormalizedRecord(
  record: NormalizedVehicleRecord,
  extras: Partial<Listing> = {},
): Listing {
  return {
    vin: record.vin,
    year: record.year.value ?? 0,
    make: record.make.value ?? "",
    model: record.model.value ?? "",
    trim: record.trim.value,
    miles: record.miles.value,
    priceUsd: record.priceUsd.value,
    city: record.city.value,
    state: record.state.value,
    zip: record.zip.value,
    dealer: record.dealer.value,
    vdp: record.listingUrl.value,
    dealerUrl: record.listingUrl.value,
    primaryImage: extras.primaryImage ?? null,
    carfaxUrl: extras.carfaxUrl ?? null,
    used: extras.used ?? true,
    cpo: extras.cpo ?? null,
    accidentCount: record.accidentCount.value,
    oneOwner: extras.oneOwner ?? null,
    ownerCount: record.ownerCount.value,
    usageType: extras.usageType ?? null,
    fuel: record.fuelType.value,
    engine: record.engine.value,
    transmission: extras.transmission ?? null,
    drivetrain: record.drivetrain.value,
    bodyStyle: record.bodyStyle.value,
    style: extras.style ?? null,
    distanceMiles: record.distanceMiles.value,
    latitude: extras.latitude ?? null,
    longitude: extras.longitude ?? null,
    removedAt: extras.removedAt ?? null,
    createdAt: extras.createdAt ?? null,
    titleBrand: extras.titleBrand ?? null,
    source: extras.source ?? "autodev",
    askingPriceKind: extras.askingPriceKind ?? (record.priceUsd.value != null ? "purchase_ask" : null),
    askingPriceProvenance:
      extras.askingPriceProvenance ??
      (record.priceUsd.source === "page"
        ? "seller_page_labeled"
        : record.priceUsd.source === "feed"
          ? "feed_only"
          : record.priceUsd.value != null
            ? "feed_only"
            : "missing"),
    askingPriceSellerPageAccess: extras.askingPriceSellerPageAccess ?? null,
  };
}

/** Apply vPIC decode onto a feed/page listing without inventing missing decode fields. */
export function enrichListingWithVpic(listing: Listing, decode: VinDecode | null | undefined): Listing {
  if (!decode) return listing;
  return {
    ...listing,
    year: listing.year || decode.year || listing.year,
    make: listing.make || decode.make || listing.make,
    model: listing.model || decode.model || listing.model,
    trim: listing.trim ?? decode.trim ?? null,
    drivetrain: listing.drivetrain ?? decode.driveType ?? null,
    fuel: listing.fuel ?? decode.fuel ?? null,
    engine: listing.engine ?? decode.engine ?? null,
    bodyStyle: listing.bodyStyle ?? decode.bodyClass ?? null,
  };
}
