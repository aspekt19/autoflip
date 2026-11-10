import { parseAutoDevListings } from "./parsers";
import { TtlCache } from "./cache";
import { monthKey, reserveCall, type MonthlyCounter, type QuotaDecision } from "./quota";
import { ASSUMPTIONS } from "@/domain/assumptions";
import type { Listing, ListingSource } from "@/domain/types";
import type { ListingQuery } from "./marketcheck";
import { combineAbortSignals } from "./abort-signal";

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
  /**
   * Caller mid-flight AbortSignal (e.g. Request.signal). Combined with ownership timeout.
   * Ambiguous abort after dispatch must not refund the monthly reservation.
   */
  signal?: AbortSignal | null;
  /** Ownership timeout ms (default 12_000). Tests may lower. */
  timeoutMs?: number;
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

/** Normalize a VDP URL for exact equality checks (no guessing). */
export function normalizeVdpUrl(raw: string): string {
  try {
    const url = new URL(raw.trim());
    url.hash = "";
    url.hostname = url.hostname.replace(/^www\./i, "").toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString().toLowerCase();
  } catch {
    return raw.trim().toLowerCase().replace(/\/+$/, "");
  }
}

/**
 * Attempt a direct Auto.dev filter by retailListing.vdp.
 * Many feeds index the seller VDP; if the API rejects the filter, callers fall back.
 */
export function listingByVdpUrl(vdp: string): string {
  const params = new URLSearchParams();
  params.set("retailListing.vdp", vdp);
  params.set("limit", "10");
  return `https://api.auto.dev/listings?${params.toString()}`;
}

export function findExactVdpMatch(listings: readonly Listing[], vdp: string): Listing | null {
  const want = normalizeVdpUrl(vdp);
  for (const row of listings) {
    if (row.vdp && normalizeVdpUrl(row.vdp) === want) return row;
  }
  return null;
}

/**
 * Legitimate VDP / listing-URL lookup via Auto.dev only.
 * Never scrapes past anti-bot walls. Requires an exact retailListing.vdp match —
 * listing-site internal ids alone are not an Auto.dev query key.
 */
export async function autodevByVdp(
  vdp: string,
  hints: { year?: number | null; make?: string | null; model?: string | null },
  deps: AutodevDeps,
): Promise<
  | { ok: true; listing: Listing; cached: boolean; via: "vdp_filter" | "ymm_exact_vdp" }
  | { ok: false; reason: "no_match" | "upstream" | "demo_limit"; message: string }
> {
  const direct = await cachedGet(listingByVdpUrl(vdp), deps);
  if (direct.ok) {
    const hit = findExactVdpMatch(direct.listings, vdp);
    if (hit) return { ok: true, listing: hit, cached: direct.cached, via: "vdp_filter" };
  } else if (direct.error === "demo_limit") {
    return { ok: false, reason: "demo_limit", message: direct.message };
  }
  // Filter unsupported / empty: only continue when URL slug exposed YMM we can search honestly.
  const year = hints.year ?? null;
  const make = hints.make?.trim() || null;
  const model = hints.model?.trim() || null;
  if (!year || !make || !model) {
    return {
      ok: false,
      reason: "no_match",
      message: "Auto.dev has no listing matching this VDP URL (no year/make/model in the URL to search).",
    };
  }
  const search = await autodevSearch(
    { year, make, model, used: true, limit: 50 },
    deps,
  );
  if (!search.ok) {
    if (search.error === "demo_limit") {
      return { ok: false, reason: "demo_limit", message: search.message };
    }
    return { ok: false, reason: "upstream", message: search.message };
  }
  const hit = findExactVdpMatch(search.listings, vdp);
  if (!hit) {
    return {
      ok: false,
      reason: "no_match",
      message: "Auto.dev returned same-YMM listings, but none matched this VDP URL exactly.",
    };
  }
  return { ok: true, listing: hit, cached: search.cached, via: "ymm_exact_vdp" };
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
    const signal = combineAbortSignals(deps.signal, deps.timeoutMs ?? 12_000);
    response = await deps.fetch(url, {
      headers: {
        Authorization: `Bearer ${deps.apiKey}`,
        Accept: "application/json",
      },
      signal,
    });
  } catch {
    // Ambiguous cancel/timeout after reservation — do not refund here.
    return {
      ok: false,
      error: "upstream",
      status: 0,
      message: "The listing lookup did not respond.",
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
            ? "The listing lookup rejected the key."
            : "The listing lookup returned an error.",
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
