import { autoDevMake, autoDevModel } from "./vehicle-names";
import { toListingsQuery, type SavedSearch, type WatchCriteria, type WatchModel } from "./radar-watch";
import type { ListingQuery } from "@/io/marketcheck";

export const MAX_PERSONAL_MODELS = 6;
/** Legacy page-count for cheapest-first Flip scans (kept for callers/tests). */
export const FLIP_SCAN_PAGES = 3;

/**
 * Liquid make/model segments for a budget-only Flip watch.
 * A cheapest-first nationwide page is too mixed for similar-listing comps;
 * querying named liquid models matches Resale plan directions (cap = FLIP_SCAN_PAGES).
 */
export const FLIP_BROAD_SCAN_MODELS: WatchModel[] = [
  { make: "Toyota", model: "Corolla" },
  { make: "Toyota", model: "RAV4" },
  { make: "Toyota", model: "Camry" },
];

export function watchModels(criteria: WatchCriteria): WatchModel[] {
  if (criteria.models?.length) {
    const seen = new Set<string>();
    const models: WatchModel[] = [];
    for (const item of criteria.models) {
      const make = autoDevMake(item.make);
      const model = item.model ? autoDevModel(item.model) : "";
      if (!make || !model) continue;
      const key = `${make.toLowerCase()}|${model.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      models.push({ make, model });
      if (models.length >= MAX_PERSONAL_MODELS) break;
    }
    return models;
  }
  if (criteria.make && criteria.model) {
    return [{ make: autoDevMake(criteria.make), model: autoDevModel(criteria.model) }];
  }
  return [];
}

export function isBroadFlip(search: Pick<SavedSearch, "mode" | "criteria">): boolean {
  return search.mode === "flip" && watchModels(search.criteria).length === 0;
}

export function listingQueries(search: Pick<SavedSearch, "mode" | "criteria">): ListingQuery[] {
  if (isBroadFlip(search)) {
    // Named liquid segments so similar-listing comps exist within each page.
    return FLIP_BROAD_SCAN_MODELS.slice(0, FLIP_SCAN_PAGES).map((item) =>
      toListingsQuery({
        ...search.criteria,
        make: item.make,
        model: item.model,
        models: undefined,
        bodyStyle: undefined,
      }),
    );
  }
  const models = watchModels(search.criteria);
  if (models.length <= 1) return [toListingsQuery(search.criteria)];
  return models.map((item) => toListingsQuery({ ...search.criteria, make: item.make, model: item.model, models: undefined }));
}

export function matchesWatchModels(listing: { make: string; model: string }, criteria: WatchCriteria): boolean {
  const models = watchModels(criteria);
  if (models.length === 0) return true;
  const make = autoDevMake(listing.make).toLowerCase();
  const model = autoDevModel(listing.model).toLowerCase();
  return models.some((item) => item.make.toLowerCase() === make && item.model.toLowerCase() === model);
}

/** A real drop: at least $300 and at least 3% under the last seen asking price. */
export function isPriceDrop(previous: number | null | undefined, next: number | null): boolean {
  if (previous == null || next == null) return false;
  return next <= previous - 300 && next <= previous * 0.97;
}
