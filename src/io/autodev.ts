import { parseAutoDevListings } from "./parsers";
import { TtlCache } from "./cache";
import { monthKey, reserveCall, type MonthlyCounter, type QuotaDecision } from "./quota";
import { ASSUMPTIONS } from "@/domain/assumptions";
import type { Listing, ListingSource } from "@/domain/types";
import type { ListingQuery } from "./marketcheck";

export type AutodevDeps = {
  fetch: typeof fetch;
  cache: TtlCache<unknown>;
  counter: MonthlyCounter;
  apiKey: string;
  now?: Date;
  source?: ListingSource;
  /** When set, this replaces the sync counter. Used for the persistent monthly cap. */
  reserve?: () => Promise<QuotaDecision>;
  bypassCache?: boolean;
};

export type AutodevResult =
  | { ok: true; listings: Listing[]; quota: QuotaDecision & { ok: true }; cached: boolean }
  | { ok: false; error: "demo_limit"; message: string; quota: QuotaDecision & { ok: false } }
  | { ok: false; error: "upstream"; status: number; message: string; quota: QuotaDecision & { ok: true } };

export function listingsSearchUrl(query: ListingQuery): string {
  const params = new URLSearchParams();
  if (query.make) params.set("vehicle.make", query.make);
  if (query.model) params.set("vehicle.model", query.model);
  if (query.yearRange) params.set("vehicle.year", query.yearRange);
  else if (query.year) params.set("vehicle.year", String(query.year));
  if (query.bodyStyle) params.set("vehicle.bodyStyle", query.bodyStyle);
  if (query.priceRange) params.set("retailListing.price", query.priceRange);
  if (query.milesRange) params.set("retailListing.miles", query.milesRange);
  if (query.used) params.set("retailListing.used", "true");
  if (query.zip) params.set("zip", query.zip);
  if (query.distanceMiles) params.set("distance", String(query.distanceMiles));
  if (query.sort) params.set("sort", query.sort);
  if (query.page && query.page > 1) params.set("page", String(query.page));
  params.set("limit", String(query.limit ?? 20));
  return `https://api.auto.dev/listings?${params.toString()}`;
}

export function listingByVinUrl(vin: string): string {
  return `https://api.auto.dev/listings/${encodeURIComponent(vin)}`;
}

async function cachedGet(url: string, deps: AutodevDeps): Promise<AutodevResult> {
  const hit = deps.bypassCache ? undefined : deps.cache.get(url);
  if (hit !== undefined) {
    const used = deps.counter.get(monthKey(deps.now ?? new Date()));
    return {
      ok: true,
      listings: parseAutoDevListings(hit, deps.source ?? "autodev"),
      cached: true,
      quota: { ok: true, used, limit: ASSUMPTIONS.autodevMonthlyStop },
    };
  }

  const quota = deps.reserve ? await deps.reserve() : reserveCall(deps.counter, deps.now);
  if (!quota.ok) return { ok: false, error: "demo_limit", message: quota.message, quota };

  let response: Response;
  try {
    response = await deps.fetch(url, {
      headers: {
        Authorization: `Bearer ${deps.apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    return {
      ok: false,
      error: "upstream",
      status: 0,
      message: "The listings provider did not respond.",
      quota,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      error: "upstream",
      status: response.status,
      message:
        response.status === 404
          ? "No current listing was found for that VIN."
          : response.status === 401 || response.status === 403
            ? "The listings provider rejected the API key."
            : "The listings provider returned an error.",
      quota,
    };
  }

  const json: unknown = await response.json();
  deps.cache.set(url, json);
  return {
    ok: true,
    listings: parseAutoDevListings(json, deps.source ?? "autodev"),
    cached: false,
    quota,
  };
}

export function autodevSearch(query: ListingQuery, deps: AutodevDeps): Promise<AutodevResult> {
  return cachedGet(listingsSearchUrl(query), deps);
}

export function autodevByVin(vin: string, deps: AutodevDeps): Promise<AutodevResult> {
  return cachedGet(listingByVinUrl(vin), deps);
}
