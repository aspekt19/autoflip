import { parseAutoDevListings } from "./parsers";
import { TtlCache } from "./cache";
import { monthKey, reserveCall, type MonthlyCounter, type QuotaDecision } from "./quota";
import { ASSUMPTIONS } from "@/domain/assumptions";
import { providerBodyStyleParam } from "@/domain/body-style";
import type { Listing, ListingSource } from "@/domain/types";
import type { ListingQuery } from "./marketcheck";
import { combineAbortSignals } from "./abort-signal";

/**
 * Default ownership timeout for a single Auto.dev attempt.
 * Generous within the Vercel 300s step budget — short 12s cuts caused upstream
 * timeouts mid-agent-loop while SERV still had request time left.
 */
export const AUTODEV_DEFAULT_TIMEOUT_MS = 60_000;

/** Max attempts including the first try (1 + retries). */
export const AUTODEV_MAX_ATTEMPTS = 3;

/** Base backoff before retry attempt n (n=1 → first retry). */
export const AUTODEV_RETRY_BASE_MS = 750;

const TRANSIENT_HTTP = new Set([408, 429, 500, 502, 503, 504]);

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
  /** Ownership timeout ms per attempt (default {@link AUTODEV_DEFAULT_TIMEOUT_MS}). Tests may lower. */
  timeoutMs?: number;
  /** Override max attempts (tests). */
  maxAttempts?: number;
  /** Override backoff base ms (tests). */
  retryBaseMs?: number;
  /** Inject sleep for tests (default real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
};

export type AutodevUpstreamCause =
  | "http_error"
  | "timeout"
  | "network"
  | "aborted"
  | "unknown";

export type AutodevResult =
  | { ok: true; listings: Listing[]; quota: QuotaDecision & { ok: true }; cached: boolean }
  | { ok: false; error: "demo_limit"; message: string; quota: QuotaDecision & { ok: false } }
  | {
      ok: false;
      error: "upstream";
      status: number;
      cause: AutodevUpstreamCause;
      message: string;
      attempts: number;
      quota: QuotaDecision & { ok: true };
    };

/** Override only for labelled local/CI stubs — production keeps api.auto.dev. */
export function autodevOrigin(env: Record<string, string | undefined> = process.env): string {
  const raw = env.AUTODEV_BASE_URL?.trim();
  if (raw) return raw.replace(/\/$/, "");
  return "https://api.auto.dev";
}

export function listingsSearchUrl(query: ListingQuery): string {
  const params = new URLSearchParams();
  if (query.make) params.set("vehicle.make", query.make);
  if (query.model) params.set("vehicle.model", query.model);
  if (query.yearRange) params.set("vehicle.year", query.yearRange);
  else if (query.year) params.set("vehicle.year", String(query.year));
  const bodyStyle = providerBodyStyleParam(query.bodyStyle);
  if (bodyStyle) params.set("vehicle.bodyStyle", bodyStyle);
  if (query.priceRange) params.set("retailListing.price", query.priceRange);
  if (query.milesRange) params.set("retailListing.miles", query.milesRange);
  if (query.used) params.set("retailListing.used", "true");
  if (query.zip) params.set("zip", query.zip);
  if (query.distanceMiles) params.set("distance", String(query.distanceMiles));
  if (query.sort) params.set("sort", query.sort);
  if (query.page && query.page > 1) params.set("page", String(query.page));
  params.set("limit", String(query.limit ?? 20));
  return `${autodevOrigin()}/listings?${params.toString()}`;
}

export function listingByVinUrl(vin: string): string {
  return `${autodevOrigin()}/listings/${encodeURIComponent(vin)}`;
}

/**
 * Auto.dev ZIP → lat/lon/city lookup (buyer-center geocode).
 * Docs: https://docs.auto.dev/v1/reference/zip-lookup — route is `/api/zip/{zip}`
 * (bare `/zip/{zip}` 404s with "route does not exist").
 */
export function zipLookupUrl(zip: string): string {
  return `${autodevOrigin()}/api/zip/${encodeURIComponent(zip)}`;
}

export type AutodevZipLocation = {
  zip: string;
  city: string | null;
  state: string | null;
  latitude: number;
  longitude: number;
};

export type AutodevZipLookupResult =
  | {
      ok: true;
      location: AutodevZipLocation;
      status: number;
      url: string;
      raw: unknown;
    }
  | {
      ok: false;
      error: "location_not_recognized" | "upstream" | "demo_limit";
      status: number;
      cause?: AutodevUpstreamCause;
      message: string;
      url: string;
      raw: unknown;
      quota?: QuotaDecision;
    };

function readZipLookupPayload(raw: unknown): AutodevZipLocation | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const root = raw as Record<string, unknown>;
  const payload =
    root.payload && typeof root.payload === "object" && !Array.isArray(root.payload)
      ? (root.payload as Record<string, unknown>)
      : root;
  const zipRaw = payload.zip ?? payload.postalCode ?? payload.postal;
  const zip = typeof zipRaw === "string" ? zipRaw.trim().slice(0, 5) : "";
  if (!/^\d{5}$/.test(zip)) return null;
  const lat = Number(payload.latitude ?? payload.lat);
  const lon = Number(payload.longitude ?? payload.lon ?? payload.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  // Reject null-island / missing geocode disguised as zeros.
  if (lat === 0 && lon === 0) return null;
  const city = typeof payload.city === "string" && payload.city.trim() ? payload.city.trim() : null;
  const state = typeof payload.state === "string" && payload.state.trim() ? payload.state.trim() : null;
  return { zip, city, state, latitude: lat, longitude: lon };
}

/**
 * Resolve a buyer-center ZIP via Auto.dev before radius search.
 * PO-box / unassigned ZIPs often fail geocode — callers must not treat that as empty inventory.
 */
export async function autodevZipLookup(
  zip: string,
  deps: AutodevDeps,
): Promise<AutodevZipLookupResult> {
  const normalized = zip.trim().slice(0, 5);
  const url = zipLookupUrl(normalized);
  const quota = deps.reserve ? await deps.reserve() : reserveCall(deps.counter, deps.now);
  if (!quota.ok) {
    return {
      ok: false,
      error: "demo_limit",
      status: 0,
      message: quota.message,
      url,
      raw: null,
      quota,
    };
  }

  const timeoutMs = deps.timeoutMs ?? AUTODEV_DEFAULT_TIMEOUT_MS;
  try {
    const signal = combineAbortSignals(deps.signal, timeoutMs);
    const response = await deps.fetch(url, {
      headers: {
        Authorization: `Bearer ${deps.apiKey}`,
        Accept: "application/json",
      },
      signal,
    });
    const raw: unknown = await response.json().catch(() => null);
    console.info(
      `[autodev] zip_lookup zip=${normalized} url=${url} status=${response.status} body=${JSON.stringify(raw)?.slice(0, 800) ?? "null"}`,
    );

    if (!response.ok) {
      const unrecognized = response.status === 404 || response.status === 422;
      return {
        ok: false,
        error: unrecognized ? "location_not_recognized" : "upstream",
        status: response.status,
        cause: "http_error",
        message: unrecognized
          ? `Location not recognized for ZIP ${normalized}.`
          : upstreamMessage(response.status, "http_error"),
        url,
        raw,
      };
    }

    const location = readZipLookupPayload(raw);
    if (!location) {
      return {
        ok: false,
        error: "location_not_recognized",
        status: response.status,
        message: `Location not recognized for ZIP ${normalized}.`,
        url,
        raw,
      };
    }
    return { ok: true, location, status: response.status, url, raw };
  } catch (error) {
    const cause = classifyFetchError(error);
    const finalCause = cause === "aborted" && !deps.signal?.aborted ? "timeout" : cause;
    console.info(
      `[autodev] zip_lookup zip=${normalized} url=${url} status=0 cause=${finalCause}`,
    );
    return {
      ok: false,
      error: "upstream",
      status: 0,
      cause: finalCause,
      message: upstreamMessage(0, finalCause),
      url,
      raw: null,
    };
  }
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
  return `${autodevOrigin()}/listings?${params.toString()}`;
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
 *
 * Autotrader (and similar) listing ids in the URL path (e.g. …/756212296) cannot be
 * looked up by id on Auto.dev — there is no “source listing id” search. When the
 * seller site walls the fetch and Auto.dev has no exact VDP match, refuse honestly
 * and keep the URL tab (paste / VIN inline). Do not invent a listing from the id.
 */
export async function autodevByVdp(
  vdp: string,
  hints: { year?: number | null; make?: string | null; model?: string | null },
  deps: AutodevDeps,
): Promise<
  | { ok: true; listing: Listing; cached: boolean; via: "vdp_filter" | "ymm_exact_vdp" }
  | { ok: false; reason: "no_match" | "upstream" | "demo_limit"; message: string; status?: number; cause?: AutodevUpstreamCause }
> {
  const direct = await cachedGet(listingByVdpUrl(vdp), deps);
  if (direct.ok) {
    const hit = findExactVdpMatch(direct.listings, vdp);
    if (hit) return { ok: true, listing: hit, cached: direct.cached, via: "vdp_filter" };
  } else if (direct.error === "demo_limit") {
    return { ok: false, reason: "demo_limit", message: direct.message };
  } else if (direct.error === "upstream") {
    // Continue to YMM fallback only when the filter itself is missing/unsupported (404),
    // not when the provider is out (5xx/timeout) — those should surface honestly.
    if (direct.status !== 404) {
      return {
        ok: false,
        reason: "upstream",
        message: direct.message,
        status: direct.status,
        cause: direct.cause,
      };
    }
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
    return {
      ok: false,
      reason: "upstream",
      message: search.message,
      status: search.status,
      cause: search.cause,
    };
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

function classifyFetchError(error: unknown): AutodevUpstreamCause {
  if (!error || typeof error !== "object") return "network";
  const name = "name" in error ? String((error as { name: unknown }).name) : "";
  if (name === "TimeoutError") return "timeout";
  if (name === "AbortError") return "aborted";
  return "network";
}

function upstreamMessage(status: number, cause: AutodevUpstreamCause): string {
  if (cause === "timeout") return "The listing lookup timed out.";
  if (cause === "aborted") return "The listing lookup was cancelled.";
  if (cause === "network") return "The listing lookup network failed.";
  if (status === 404) return "No current listing was found for that VIN.";
  if (status === 401 || status === 403) return "The listing lookup rejected the key.";
  if (status === 429) return "The listing lookup rate-limited the request (HTTP 429).";
  if (status >= 500) return `The listing lookup returned HTTP ${status}.`;
  if (status > 0) return `The listing lookup returned HTTP ${status}.`;
  return "The listing lookup returned an error.";
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attemptIndex: number, baseMs: number): number {
  // attemptIndex 0 = first retry after failure → base, then 2x, 4x…
  const exp = Math.max(0, attemptIndex);
  return baseMs * 2 ** exp;
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

  const timeoutMs = deps.timeoutMs ?? AUTODEV_DEFAULT_TIMEOUT_MS;
  const maxAttempts = Math.max(1, deps.maxAttempts ?? AUTODEV_MAX_ATTEMPTS);
  const retryBase = deps.retryBaseMs ?? AUTODEV_RETRY_BASE_MS;
  const sleep = deps.sleep ?? defaultSleep;

  let lastStatus = 0;
  let lastCause: AutodevUpstreamCause = "unknown";
  let attempts = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    attempts = attempt + 1;
    if (deps.signal?.aborted) {
      return {
        ok: false,
        error: "upstream",
        status: 0,
        cause: "aborted",
        message: upstreamMessage(0, "aborted"),
        attempts,
        quota,
      };
    }

    try {
      const signal = combineAbortSignals(deps.signal, timeoutMs);
      const response = await deps.fetch(url, {
        headers: {
          Authorization: `Bearer ${deps.apiKey}`,
          Accept: "application/json",
        },
        signal,
      });

      if (!response.ok) {
        lastStatus = response.status;
        lastCause = "http_error";
        const retryable = TRANSIENT_HTTP.has(response.status);
        if (retryable && attempt < maxAttempts - 1) {
          await sleep(backoffMs(attempt, retryBase));
          continue;
        }
        return {
          ok: false,
          error: "upstream",
          status: response.status,
          cause: "http_error",
          message: upstreamMessage(response.status, "http_error"),
          attempts,
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
    } catch (error) {
      const cause = classifyFetchError(error);
      lastStatus = 0;
      lastCause = cause;
      // Caller abort: do not retry. Ownership timeout / network: retry with backoff.
      if (cause === "aborted" && deps.signal?.aborted) {
        return {
          ok: false,
          error: "upstream",
          status: 0,
          cause: "aborted",
          message: upstreamMessage(0, "aborted"),
          attempts,
          quota,
        };
      }
      if (attempt < maxAttempts - 1 && (cause === "timeout" || cause === "network" || cause === "aborted")) {
        // Ownership timeout surfaces as AbortError without caller abort — retry.
        if (cause === "aborted" && !deps.signal?.aborted) {
          lastCause = "timeout";
        }
        await sleep(backoffMs(attempt, retryBase));
        continue;
      }
      const finalCause = cause === "aborted" && !deps.signal?.aborted ? "timeout" : cause;
      return {
        ok: false,
        error: "upstream",
        status: 0,
        cause: finalCause,
        message: upstreamMessage(0, finalCause),
        attempts,
        quota,
      };
    }
  }

  return {
    ok: false,
    error: "upstream",
    status: lastStatus,
    cause: lastCause,
    message: upstreamMessage(lastStatus, lastCause),
    attempts,
    quota,
  };
}

export async function autodevSearch(query: ListingQuery, deps: AutodevDeps): Promise<AutodevResult> {
  const url = listingsSearchUrl(query);
  console.info(`[autodev] listings_search url=${url}`);
  const result = await cachedGet(url, deps);
  if (result.ok) {
    console.info(
      `[autodev] listings_search ok cached=${result.cached} count=${result.listings.length} url=${url}`,
    );
  } else if (result.error === "upstream") {
    console.info(
      `[autodev] listings_search upstream status=${result.status} cause=${result.cause} attempts=${result.attempts} url=${url}`,
    );
  } else {
    console.info(`[autodev] listings_search error=${result.error} url=${url}`);
  }
  return result;
}

export function autodevByVin(vin: string, deps: AutodevDeps): Promise<AutodevResult> {
  return cachedGet(listingByVinUrl(vin), deps);
}
