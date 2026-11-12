import { autoDevMake, autoDevModel } from "./vehicle-names";
import { toListingsQuery, type SavedSearch, type WatchCriteria, type WatchModel } from "./radar-watch";
import type { ListingQuery } from "@/io/marketcheck";

export const MAX_PERSONAL_MODELS = 6;

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

/** Flip watch with no SERV/user-named models — code must not invent make/model catalogs. */
export function isBroadFlip(search: Pick<SavedSearch, "mode" | "criteria">): boolean {
  return search.mode === "flip" && watchModels(search.criteria).length === 0;
}

/**
 * Build listing queries from criteria the shopper or SERV already named.
 * Unnamed Flip watches get a single criteria query (budget/zip/etc.) with no
 * invented Corolla/RAV4/Camry substitution — SERV owns model choice via search_listings
 * when creating the watch, or the watch carries named models.
 */
export function listingQueries(search: Pick<SavedSearch, "mode" | "criteria">): ListingQuery[] {
  const models = watchModels(search.criteria);
  if (models.length <= 1) return [toListingsQuery(search.criteria)];
  return models.map((item) =>
    toListingsQuery({ ...search.criteria, make: item.make, model: item.model, models: undefined }),
  );
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
