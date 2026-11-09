/**
 * Free per-car consistency check.
 * Compares the listing with an already-decoded VIN (same vPIC lookup Find already runs)
 * and with feed fields the listing already parsed. No new paid source. No network here.
 *
 * Year / make / model mismatch → excluded from the pick.
 * Trim, drivetrain, or engine mismatch, rental/fleet use, or a reported accident
 * → condition penalty + a seller question.
 * Days listed is context only (0 points).
 */

import type { EvidenceFact, EvidenceState } from "./find-evidence-state";
import { listingAgeDays } from "./flip-rank";
import type { BestDealListing } from "./find-best-deal";
import type { FindFreeGovReceipt } from "./find-free-gov";

export const CAR_CONSISTENCY_CHECK_ID = "free_car_consistency" as const;

/** Points subtracted from the condition factor. Capped by the caller at the condition weight. */
export const CONSISTENCY_MISMATCH_PENALTY = 4;
export const CONSISTENCY_FLEET_PENALTY = 6;
export const CONSISTENCY_ACCIDENT_PENALTY = 6;

export type VpicSpecs = {
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  drivetrain: string | null;
  engine: string | null;
  fuel: string | null;
};

export type CarConsistencyReceipt = {
  key: string;
  vin: string | null;
  year: number;
  make: string;
  model: string;
  fields: EvidenceFact[];
  identityMismatch: boolean;
  excludedReason: string | null;
  /** Negative or zero. Days listed never contributes. */
  conditionPenalty: number;
  sellerQuestions: string[];
  daysListed: number | null;
};

const FLEET_RE = /fleet|rental|commercial|taxi|livery/i;

function norm(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokens(value: string | null | undefined): string[] {
  const n = norm(value);
  return n ? n.split(" ") : [];
}

/** Loose name match: equal, or one contains the other as a whole token sequence. */
export function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean | null {
  const left = norm(a);
  const right = norm(b);
  if (!left || !right) return null;
  if (left === right) return true;
  if (left.includes(right) || right.includes(left)) return true;
  return false;
}

function drivetrainBucket(value: string | null | undefined): string | null {
  const n = norm(value);
  if (!n) return null;
  if (/\b(awd|4wd|4x4|all wheel|four wheel|4 wheel)\b/.test(n)) return "awd";
  if (/\b(fwd|front wheel|front-wheel|2wd)\b/.test(n) || n === "front") return "fwd";
  if (/\b(rwd|rear wheel|rear-wheel)\b/.test(n) || n === "rear") return "rwd";
  return n;
}

function fuelBucket(value: string | null | undefined): string | null {
  const n = norm(value);
  if (!n) return null;
  if (/electric|bev|ev\b/.test(n) && !/hybrid/.test(n)) return "electric";
  if (/diesel/.test(n)) return "diesel";
  if (/hybrid|phev/.test(n)) return "hybrid";
  if (/flex|e85|ethanol/.test(n)) return "flex";
  if (/gas|petrol|unleaded|regular|premium/.test(n)) return "gas";
  return n;
}

function engineOverlap(listing: string | null | undefined, decoded: string | null | undefined): boolean | null {
  const left = norm(listing);
  const right = norm(decoded);
  if (!left || !right) return null;
  if (left === right || left.includes(right) || right.includes(left)) return true;
  const liters = left.match(/(\d(?:\.\d)?)\s*l?\b/);
  if (liters && right.includes(liters[1]!)) return true;
  const cyl = left.match(/(\d)\s*cyl/);
  if (cyl && right.includes(cyl[1]!)) return true;
  return false;
}

function trimMatch(listing: string | null | undefined, decoded: string | null | undefined): boolean | null {
  const left = tokens(listing);
  const right = tokens(decoded);
  if (left.length === 0 || right.length === 0) return null;
  const rightSet = new Set(right);
  // Require every listing trim token to appear. "LX" must not match "EX L".
  return left.every((token) => rightSet.has(token));
}

function field(
  name: string,
  state: EvidenceState,
  source: EvidenceFact["source"],
  plain: string,
): EvidenceFact {
  return { field: name, state, source, plain };
}

export function vpicSpecsFromReceipt(receipt: FindFreeGovReceipt): VpicSpecs | null {
  const specs = receipt.vpicSpecs;
  if (!specs) return null;
  if (receipt.status !== "ok") return null;
  return specs;
}

export function bestDealCarKey(row: {
  vin?: string | null;
  year: number;
  make: string;
  model: string;
  priceUsd?: number | null;
  miles?: number | null;
}): string {
  const vin = typeof row.vin === "string" && row.vin.trim() ? row.vin.trim().toUpperCase() : "";
  if (vin && !vin.startsWith("UNKNOWN-")) return vin;
  return `${row.year}|${row.make}|${row.model}|${row.priceUsd ?? ""}|${row.miles ?? ""}`.toLowerCase();
}

function titleOf(row: { year: number; make: string; model: string }): string {
  return `${row.year} ${row.make} ${row.model}`;
}

export function buildCarConsistencyReceipt(
  row: BestDealListing,
  specs: VpicSpecs | null,
  now: Date = new Date(),
): CarConsistencyReceipt {
  const key = bestDealCarKey(row);
  const title = titleOf(row);
  const fields: EvidenceFact[] = [];
  const sellerQuestions: string[] = [];
  let penalty = 0;

  const compareName = (
    name: "year" | "make" | "model",
    listingValue: string,
    decoded: string | null,
    label: string,
  ) => {
    if (!specs) {
      fields.push(
        field(name, "not_checked", "government", `${title}: ${label} has not been compared with a VIN decode yet.`),
      );
      return;
    }
    if (!decoded) {
      fields.push(
        field(name, "could_not_check", "government", `${title}: Couldn't confirm ${label} from the VIN decode.`),
      );
      return;
    }
    const listingCompare = name === "year" ? String(row.year) : listingValue;
    const matched = name === "year" ? String(row.year) === String(decoded) : namesMatch(listingCompare, decoded);
    if (matched === true) {
      fields.push(
        field(name, "none_found", "government", `${title}: VIN ${label} matches the listing (${decoded}).`),
      );
    } else if (matched === false) {
      fields.push(
        field(
          name,
          "issue_found",
          "government",
          `${title}: VIN ${label} is ${decoded}, but the listing says ${listingCompare}.`,
        ),
      );
    } else {
      fields.push(field(name, "could_not_check", "government", `${title}: Couldn't confirm ${label} from the VIN decode.`));
    }
  };

  compareName("year", String(row.year), specs?.year != null ? String(specs.year) : null, "year");
  compareName("make", row.make, specs?.make ?? null, "make");
  compareName("model", row.model, specs?.model ?? null, "model");

  const identityMismatch = fields.some(
    (f) => (f.field === "year" || f.field === "make" || f.field === "model") && f.state === "issue_found",
  );
  const excludedReason = identityMismatch
    ? `${title} is left out of the pick because the VIN year, make, or model does not match the listing.`
    : null;

  const trimState = trimMatch(row.trim, specs?.trim ?? null);
  if (!specs) {
    fields.push(field("trim", "not_checked", "government", `${title}: Trim has not been compared with a VIN decode yet.`));
  } else if (trimState == null) {
    fields.push(field("trim", "could_not_check", "government", `${title}: Couldn't confirm trim from the VIN decode.`));
  } else if (trimState) {
    fields.push(field("trim", "none_found", "government", `${title}: VIN trim matches the listing.`));
  } else {
    fields.push(
      field(
        "trim",
        "issue_found",
        "government",
        `${title}: Listing trim does not match the VIN${row.trim ? ` (listing says ${row.trim})` : ""}.`,
      ),
    );
    penalty += CONSISTENCY_MISMATCH_PENALTY;
    sellerQuestions.push(`Ask the seller to confirm the trim on the ${title} — the listing trim does not match the VIN.`);
  }

  const driveListing = drivetrainBucket(row.drivetrain);
  const driveDecoded = drivetrainBucket(specs?.drivetrain ?? null);
  if (!specs) {
    fields.push(
      field("drivetrain", "not_checked", "government", `${title}: Drivetrain has not been compared with a VIN decode yet.`),
    );
  } else if (!driveListing || !driveDecoded) {
    fields.push(
      field("drivetrain", "could_not_check", "government", `${title}: Couldn't confirm drivetrain from the VIN decode.`),
    );
  } else if (driveListing === driveDecoded) {
    fields.push(field("drivetrain", "none_found", "government", `${title}: VIN drivetrain matches the listing.`));
  } else {
    fields.push(
      field("drivetrain", "issue_found", "government", `${title}: Listing drivetrain does not match the VIN.`),
    );
    penalty += CONSISTENCY_MISMATCH_PENALTY;
    sellerQuestions.push(`Ask the seller to confirm drivetrain on the ${title} — it does not match the VIN.`);
  }

  const engineState = specs ? engineOverlap(row.engine, specs.engine) : null;
  if (!specs) {
    fields.push(field("engine", "not_checked", "government", `${title}: Engine has not been compared with a VIN decode yet.`));
  } else if (engineState == null) {
    fields.push(field("engine", "could_not_check", "government", `${title}: Couldn't confirm the engine from the VIN decode.`));
  } else if (engineState) {
    fields.push(field("engine", "none_found", "government", `${title}: VIN engine matches the listing.`));
  } else {
    fields.push(field("engine", "issue_found", "government", `${title}: Listing engine does not match the VIN.`));
    penalty += CONSISTENCY_MISMATCH_PENALTY;
    sellerQuestions.push(`Ask the seller to confirm the engine on the ${title} — it does not match the VIN.`);
  }

  const fuelListing = fuelBucket(row.fuel);
  const fuelDecoded = fuelBucket(specs?.fuel ?? null);
  if (!specs) {
    fields.push(field("fuel", "not_checked", "government", `${title}: Fuel type has not been compared with a VIN decode yet.`));
  } else if (!fuelListing || !fuelDecoded) {
    fields.push(field("fuel", "could_not_check", "government", `${title}: Couldn't confirm fuel type from the VIN decode.`));
  } else if (fuelListing === fuelDecoded) {
    fields.push(field("fuel", "none_found", "government", `${title}: VIN fuel type matches the listing.`));
  } else {
    fields.push(
      field("fuel", "issue_found", "government", `${title}: Listing fuel type does not match the VIN.`),
    );
    sellerQuestions.push(`Ask the seller to confirm the fuel type on the ${title} — it does not match the VIN.`);
  }

  if (row.accidentCount == null) {
    fields.push(
      field(
        "accidents",
        "not_checked",
        "listing_says",
        `${title}: Listing does not say whether accidents were reported.`,
      ),
    );
  } else if (row.accidentCount > 0) {
    fields.push(
      field(
        "accidents",
        "issue_found",
        "listing_says",
        `${title}: Listing says ${row.accidentCount} accident${row.accidentCount === 1 ? "" : "s"} reported.`,
      ),
    );
    penalty += CONSISTENCY_ACCIDENT_PENALTY;
    sellerQuestions.push(
      `Ask the seller for accident records on the ${title} — the listing says accidents were reported.`,
    );
  } else {
    fields.push(
      field(
        "accidents",
        "none_found",
        "listing_says",
        `${title}: Listing says no accidents were reported (seller claim, not a history report).`,
      ),
    );
  }

  if (row.ownerCount == null && row.oneOwner == null) {
    fields.push(
      field("owners", "not_checked", "listing_says", `${title}: Listing does not say how many owners.`),
    );
  } else if (row.oneOwner === true || row.ownerCount === 1) {
    fields.push(field("owners", "none_found", "listing_says", `${title}: Listing says one owner.`));
  } else if (typeof row.ownerCount === "number") {
    fields.push(
      field("owners", "none_found", "listing_says", `${title}: Listing says ${row.ownerCount} owners.`),
    );
  } else {
    fields.push(field("owners", "could_not_check", "listing_says", `${title}: Couldn't confirm owner count from the listing.`));
  }

  const usage = row.usageType ?? null;
  if (!usage) {
    fields.push(
      field("usage", "not_checked", "listing_says", `${title}: Listing does not say whether this was a rental or fleet car.`),
    );
  } else if (FLEET_RE.test(usage)) {
    fields.push(
      field("usage", "issue_found", "listing_says", `${title}: Listing says rental or fleet use (${usage}).`),
    );
    penalty += CONSISTENCY_FLEET_PENALTY;
    sellerQuestions.push(`Ask the seller about rental or fleet use on the ${title} — the listing says so.`);
  } else {
    fields.push(field("usage", "none_found", "listing_says", `${title}: Listing says use was “${usage}”.`));
  }

  const days = listingAgeDays(
    {
      vin: row.vin ?? "UNKNOWN",
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
      cpo: row.cpo ?? null,
      accidentCount: row.accidentCount ?? null,
      oneOwner: row.oneOwner ?? null,
      ownerCount: row.ownerCount ?? null,
      usageType: row.usageType ?? null,
      fuel: row.fuel ?? null,
      engine: row.engine ?? null,
      drivetrain: row.drivetrain ?? null,
      bodyStyle: null,
      latitude: null,
      longitude: null,
      removedAt: null,
      createdAt: row.createdAt ?? null,
      source: "autodev",
    },
    now,
  );
  fields.push(
    field(
      "days_listed",
      days == null ? "could_not_check" : "none_found",
      "listing_says",
      days == null
        ? `${title}: Listing does not say how many days it has been listed.`
        : `${title}: Listing says about ${days} day${days === 1 ? "" : "s"} on the market (context only).`,
    ),
  );

  return {
    key,
    vin: typeof row.vin === "string" ? row.vin : null,
    year: row.year,
    make: row.make,
    model: row.model,
    fields,
    identityMismatch,
    excludedReason,
    conditionPenalty: penalty,
    sellerQuestions,
    daysListed: days,
  };
}

export function vpicByVinFromReceipts(receipts: readonly FindFreeGovReceipt[]): Map<string, VpicSpecs> {
  const map = new Map<string, VpicSpecs>();
  for (const receipt of receipts) {
    if (receipt.checkId !== "free_gov_vpic" || !receipt.vin) continue;
    const specs = vpicSpecsFromReceipt(receipt);
    if (!specs) continue;
    map.set(receipt.vin.trim().toUpperCase(), specs);
  }
  return map;
}

/** Run the free consistency check on target cars only. No network. */
export function executeCarConsistency(input: {
  listings: readonly BestDealListing[];
  targetKeys: readonly string[];
  vpicReceipts?: readonly FindFreeGovReceipt[];
  now?: Date;
}): CarConsistencyReceipt[] {
  const wanted = new Set(input.targetKeys);
  const vpic = vpicByVinFromReceipts(input.vpicReceipts ?? []);
  const out: CarConsistencyReceipt[] = [];
  for (const row of input.listings) {
    const key = bestDealCarKey(row);
    if (!wanted.has(key)) continue;
    const vin = typeof row.vin === "string" ? row.vin.trim().toUpperCase() : "";
    out.push(buildCarConsistencyReceipt(row, vin ? vpic.get(vin) ?? null : null, input.now));
  }
  return out;
}

export function mergeCarConsistency(
  prior: readonly CarConsistencyReceipt[],
  next: readonly CarConsistencyReceipt[],
): CarConsistencyReceipt[] {
  const map = new Map<string, CarConsistencyReceipt>();
  for (const row of prior) map.set(row.key, row);
  for (const row of next) map.set(row.key, row);
  return [...map.values()];
}
