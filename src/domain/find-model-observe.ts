/**
 * Observed-from-search model snapshots for Find results.
 * Uses only returned listing facts — never invents TCO, reliability, or market ranks.
 */

import type { FuelFact } from "./types";
import {
  estimateOwnershipFuelCost,
  formatOwnershipFuelEstimate,
  type OwnershipFuelAssumptions,
  type OwnershipFuelEstimate,
} from "./ownership-cost";

export type ObservedListingRow = {
  make: string;
  model: string;
  year: number;
  priceUsd: number | null;
  miles: number | null;
};

export type ObservedModelSnapshot = {
  make: string;
  model: string;
  count: number;
  yearMin: number;
  yearMax: number;
  /** Median usable ask among rows with a finite price — null when none. */
  medianAskUsd: number | null;
  /** Median miles among rows with finite miles — null when none. */
  medianMiles: number | null;
  honesty: string;
};

/** Condition on Find cards is always unknown — never a score. */
export type ConditionEvidence = {
  status: "unknown_needs_inspection";
  honesty: string;
};

export type ModelCompareRow = ObservedModelSnapshot & {
  condition: ConditionEvidence;
  ownershipFuel: OwnershipFuelEstimate;
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function awdRank(value: string | null | undefined): number {
  const n = (value ?? "").toLowerCase();
  if (!n) return 1;
  if (/\b(awd|4wd|4x4|all[\s-]?wheel|four[\s-]?wheel|quattro|xdrive|4matic|sh[\s-]?awd|all4)\b/.test(n)) {
    return 0;
  }
  return 2;
}

/**
 * Within a model bucket, put AWD/4WD ahead of FWD/unknown when the shopper prefers AWD.
 * Does not drop unknown-drivetrain cars — only reorders.
 */
function orderBucketForAwdPref<T extends { drivetrain?: string | null }>(rows: T[], preferAwd: boolean): T[] {
  if (!preferAwd || rows.length <= 1) return rows;
  return [...rows].sort((a, b) => {
    const d = awdRank(a.drivetrain) - awdRank(b.drivetrain);
    if (d !== 0) return d;
    return 0;
  });
}

/**
 * Round-robin across make/model so the first-named model cannot fill the entire
 * results window when other named models also returned inventory.
 * When preferAwd is set, each model bucket yields AWD/4WD before FWD so VIN
 * lexicographic order cannot bury qualifying AWD cars under FWD fillers.
 */
export function diversifyListingsByModel<T extends { make: string; model: string; drivetrain?: string | null }>(
  listings: T[],
  limit: number,
  opts?: { preferAwd?: boolean },
): T[] {
  const cap = Math.max(0, Math.floor(limit));
  if (cap === 0) return [];
  const preferAwd = Boolean(opts?.preferAwd);
  // Everything fits the page — nothing is hidden; keep caller order.
  if (listings.length <= cap) return listings;

  const buckets = new Map<string, T[]>();
  const order: string[] = [];
  for (const item of listings) {
    const key = `${item.make}\0${item.model}`.toLowerCase();
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key)!.push(item);
  }
  for (const key of order) {
    buckets.set(key, orderBucketForAwdPref(buckets.get(key)!, preferAwd));
  }
  if (order.length <= 1) {
    const only = buckets.get(order[0]!) ?? listings;
    return only.slice(0, cap);
  }

  const out: T[] = [];
  let round = 0;
  while (out.length < cap) {
    let progressed = false;
    for (const key of order) {
      const bucket = buckets.get(key)!;
      if (round < bucket.length) {
        out.push(bucket[round]!);
        progressed = true;
        if (out.length >= cap) break;
      }
    }
    if (!progressed) break;
    round += 1;
  }
  return out;
}

/** Per-model medians from the rows actually shown — estimates from this search only. */
export function observedModelSnapshots(listings: ObservedListingRow[]): ObservedModelSnapshot[] {
  const buckets = new Map<string, ObservedListingRow[]>();
  const order: string[] = [];
  for (const row of listings) {
    const key = `${row.make}\0${row.model}`.toLowerCase();
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key)!.push(row);
  }
  return order.map((key) => {
    const rows = buckets.get(key)!;
    const first = rows[0]!;
    const prices = rows.map((r) => r.priceUsd).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const miles = rows.map((r) => r.miles).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const years = rows.map((r) => r.year).filter((v) => Number.isFinite(v));
    const medianAskUsd = median(prices);
    const medianMiles = median(miles);
    return {
      make: first.make,
      model: first.model,
      count: rows.length,
      yearMin: years.length ? Math.min(...years) : first.year,
      yearMax: years.length ? Math.max(...years) : first.year,
      medianAskUsd,
      medianMiles,
      honesty:
        "Asking prices and mileage on these cards only — not sold prices, not a full ownership cost, and not a reliability score.",
    };
  });
}

export function formatObservedModelSnapshot(snap: ObservedModelSnapshot): string {
  const ask =
    snap.medianAskUsd == null ? "asking price unknown" : `typical asking price $${snap.medianAskUsd.toLocaleString("en-US")}`;
  const miles =
    snap.medianMiles == null ? "mileage unknown" : `typical mileage ${snap.medianMiles.toLocaleString("en-US")} mi`;
  return `${snap.make} ${snap.model}: ${snap.count} card${snap.count === 1 ? "" : "s"}, ${snap.yearMin}–${snap.yearMax}, ${ask}, ${miles}.`;
}

const CONDITION_UNKNOWN: ConditionEvidence = {
  status: "unknown_needs_inspection",
  honesty:
    "Condition and accident history are unknown on Find cards — not a clean history and not a condition score. Full analysis + NMVTIS-approved history before purchase.",
};

/**
 * Grounded model comparison from observed cards (+ optional EPA fuel facts).
 * Without a FuelFact, ownership fuel stays unavailable — never invented.
 */
export function compareObservedModels(
  listings: ObservedListingRow[],
  fuelsByModelKey: Record<string, FuelFact | null> = {},
  assumptions: OwnershipFuelAssumptions | null = null,
): ModelCompareRow[] {
  return observedModelSnapshots(listings).map((snap) => {
    const key = `${snap.make}\0${snap.model}`.toLowerCase();
    const fuel = fuelsByModelKey[key] ?? null;
    return {
      ...snap,
      condition: CONDITION_UNKNOWN,
      ownershipFuel: estimateOwnershipFuelCost(fuel, assumptions),
    };
  });
}

export function formatModelCompareRow(row: ModelCompareRow): string {
  return `${formatObservedModelSnapshot(row)} Condition: unknown (needs inspection/history). Fuel: ${formatOwnershipFuelEstimate(row.ownershipFuel)}`;
}
