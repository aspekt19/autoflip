/**
 * Find-agent application tools — server-side keys only; args validated at the boundary.
 */
import { bodyFamily, bodyStyleMatches, providerBodyStyleParam } from "@/domain/body-style";
import { FIND_AGENT_RESULT_SCHEMA } from "@/domain/find-agent";
import { isPassengerOrLightTruck } from "@/domain/passenger-vehicle";
import {
  classifySearchConstraints,
  duplicateSearchInfo,
  fingerprintSearchFilters,
  type SearchFilterKey,
} from "@/domain/search-listings-feedback";
import {
  assertThinSearchProxyDidNotDropProductRows,
  buildThinSearchProxyResult,
  mapBodyStyleForProvider,
} from "@/domain/serv-boundary";
import { autodevSearch, listingsSearchUrl, type AutodevDeps } from "@/io/autodev";
import { complaintsFor, recallsFor, type GovDeps } from "@/io/gov";
import { safetyRatingsFor } from "@/io/nhtsa-safety";
import { buyerListingHref } from "@/domain/find-listing-link";
import type { Listing } from "@/domain/types";
import type { ListingQuery } from "@/io/marketcheck";
import {
  checkBudgetUserQuote,
  formatShopperBriefCard,
  parseShopperBrief,
  type ShopperBrief,
} from "@/domain/shopper-brief";

export const FIND_AGENT_TOOL_NAMES = [
  "ask_shopper",
  "record_shopper_facts",
  "submit_brief",
  "search_listings",
  "get_recalls_complaints",
  "get_safety_ratings",
  "get_market_comps",
  "submit_picks",
  "submit_nothing_fits",
] as const;
export type FindAgentToolName = (typeof FIND_AGENT_TOOL_NAMES)[number];

/** Soft provider price ceiling vs shopper max (Find/Resale admit path uses ~1.05). */
export const SEARCH_LISTINGS_PRICE_SOFT_FACTOR = 1.05;

export type SearchListingsArgs = {
  make?: string;
  model?: string;
  /** Legacy free-form body (Sedan, SUV, …). Never sent as Sedan to Auto.dev. */
  bodyStyle?: string;
  /** Preferred: car | suv | truck | van — filter after fetch; car-family omitted on provider. */
  bodyFamily?: "car" | "suv" | "truck" | "van";
  priceMaxUsd?: number;
  milesMax?: number;
  yearMin?: number;
  yearMax?: number;
  zip?: string;
  /** null / omitted = nationwide (do not invent 100). */
  radiusMi?: number;
  /** Post-filter only (automatic | manual | …). */
  transmission?: string;
  fuel?: string;
  drivetrain?: string;
  sort?: string;
  /** Provider page size for this call (SERV-chosen; capped by LIMIT_MAX). */
  limit?: number;
  /** 1-based provider page — SERV paginates so no inventory page stays hidden. */
  page?: number;
};

export type SearchFunnelStep = {
  step:
    | "provider_raw"
    | "normalized_vin_ymm"
    | "passenger_gate"
    | "transmission"
    | "body_family"
    | "price"
    | "miles"
    | "radius";
  count: number;
};

export type SearchRelaxHint =
  | "omit_body"
  | "widen_radius"
  | "raise_price"
  | "drop_transmission"
  | "drop_fuel"
  | "drop_drivetrain"
  | "next_model"
  | "widen_miles";

export type MakeModelYearArgs = {
  make: string;
  model: string;
  year: number;
};

export type MarketCompsArgs = {
  make: string;
  model: string;
  yearMin?: number;
  yearMax?: number;
  priceMaxUsd?: number;
  zip?: string;
  radiusMi?: number;
  limit?: number;
};

export type ToolArgIssue = { field: string; message: string };

export type ToolArgResult<T> = { ok: true; value: T } | { ok: false; issues: ToolArgIssue[] };

export type ListingCard = {
  vin: string;
  year: number;
  make: string;
  model: string;
  price: number | null;
  miles: number | null;
  drivetrain: string | null;
  transmission: string | null;
  fuel: string | null;
  bodyStyle: string | null;
  style: string | null;
  distanceMiles: number | null;
  /** Alias of distanceMiles for older prompts. */
  distance: number | null;
  city: string | null;
  state: string | null;
  createdAt: string | null;
  /** Listing detail-page URL from stored auto.dev data when present. */
  listingUrl: string | null;
};

export type FindAgentShopperFacts = {
  /** SERV-extracted budget from chat — used for offer ≤ budget anti-fab. */
  budgetUsd: number | null;
  zip: string | null;
  radiusMi: number | null;
};

export type FindAgentToolState = {
  /** VINs returned by any tool this run (uppercase). */
  knownVins: Set<string>;
  /** Full listings keyed by VIN for comps / finish mapping. */
  listingsByVin: Map<string, Listing>;
  /** Prior search_listings fingerprints this run (for duplicate detection). */
  searchFingerprints: string[];
  /**
   * Search filter keys the shopper set (origin=user on the form bag).
   * Drives constraintRoles — never a hardcoded HARD_KEYS list.
   */
  userHardKeys: Set<SearchFilterKey>;
  /** Facts SERV recorded from the chat (budget / ZIP / radius). */
  shopperFacts: FindAgentShopperFacts;
  /** When true, search / comps / submit_picks run only after brief confirm. */
  requireBriefConfirm: boolean;
  /** Shopper confirmed the pending submit_brief card. */
  briefConfirmed: boolean;
};

export type FindAgentToolDeps = {
  fetch: typeof fetch;
  autodevKey: string;
  autodev: Pick<
    AutodevDeps,
    "cache" | "counter" | "reserve" | "timeoutMs" | "maxAttempts" | "retryBaseMs" | "sleep"
  >;
  /** Optional seed inventory already in hand (match pool). */
  seedListings?: readonly Listing[];
  /** Full shopper chat transcript for budget.userQuote verbatim checks. */
  chatTranscript?: string | null;
};

/** Default page size when SERV omits limit — not a silent hide-rows cap. */
const LISTING_DEFAULT = 20;
/** Sane max rows per provider call; SERV paginates via `page` for the rest. */
const LIMIT_MAX = 50;

function asTrimmed(value: unknown, max = 80): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (!t) return null;
  return t.slice(0, max);
}

function asPositiveInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const n = Math.round(value);
    return n > 0 ? n : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return n > 0 ? n : null;
  }
  return null;
}

function asYear(value: unknown): number | null {
  const n = asPositiveInt(value);
  if (n == null) return null;
  if (n < 1980 || n > 2100) return null;
  return n;
}

/** US ZIP: 5 digits, optional +4. */
export function parseZipArg(value: unknown): ToolArgResult<string | undefined> {
  if (value == null || value === "") return { ok: true, value: undefined };
  const raw = asTrimmed(value, 20);
  if (!raw) return { ok: true, value: undefined };
  if (!/^\d{5}(-\d{4})?$/.test(raw)) {
    return { ok: false, issues: [{ field: "zip", message: "zip must be a 5-digit US ZIP (optional +4)." }] };
  }
  return { ok: true, value: raw.slice(0, 5) };
}

export function parseLimitArg(value: unknown): ToolArgResult<number> {
  if (value == null || value === "") return { ok: true, value: LISTING_DEFAULT };
  const n = asPositiveInt(value);
  if (n == null) {
    return {
      ok: false,
      issues: [{ field: "limit", message: `limit must be a positive integer ≤ ${LIMIT_MAX}.` }],
    };
  }
  if (n > LIMIT_MAX) {
    return { ok: false, issues: [{ field: "limit", message: `limit must be ≤ ${LIMIT_MAX}.` }] };
  }
  return { ok: true, value: n };
}

export function parsePageArg(value: unknown): ToolArgResult<number | undefined> {
  if (value == null || value === "") return { ok: true, value: undefined };
  const n = asPositiveInt(value);
  if (n == null) {
    return { ok: false, issues: [{ field: "page", message: "page must be a positive integer ≥ 1." }] };
  }
  return { ok: true, value: n };
}

export function parseSearchListingsArgs(raw: unknown): ToolArgResult<SearchListingsArgs> {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, issues: [{ field: "args", message: "search_listings args must be an object." }] };
  }
  const row = raw as Record<string, unknown>;
  const issues: ToolArgIssue[] = [];
  const zip = parseZipArg(row.zip);
  if (!zip.ok) issues.push(...zip.issues);
  const limit = parseLimitArg(row.limit);
  if (!limit.ok) issues.push(...limit.issues);
  const page = parsePageArg(row.page);
  if (!page.ok) issues.push(...page.issues);

  const yearMin = row.yearMin == null || row.yearMin === "" ? undefined : asYear(row.yearMin);
  const yearMax = row.yearMax == null || row.yearMax === "" ? undefined : asYear(row.yearMax);
  if (row.yearMin != null && row.yearMin !== "" && yearMin == null) {
    issues.push({ field: "yearMin", message: "yearMin must be a plausible model year." });
  }
  if (row.yearMax != null && row.yearMax !== "" && yearMax == null) {
    issues.push({ field: "yearMax", message: "yearMax must be a plausible model year." });
  }
  if (yearMin != null && yearMax != null && yearMin > yearMax) {
    issues.push({ field: "yearMin", message: "yearMin must be ≤ yearMax." });
  }

  const priceMaxUsd =
    row.priceMaxUsd == null || row.priceMaxUsd === "" ? undefined : asPositiveInt(row.priceMaxUsd);
  if (row.priceMaxUsd != null && row.priceMaxUsd !== "" && priceMaxUsd == null) {
    issues.push({ field: "priceMaxUsd", message: "priceMaxUsd must be a positive number." });
  }
  const milesMax = row.milesMax == null || row.milesMax === "" ? undefined : asPositiveInt(row.milesMax);
  if (row.milesMax != null && row.milesMax !== "" && milesMax == null) {
    issues.push({ field: "milesMax", message: "milesMax must be a positive number." });
  }
  const radiusMi = row.radiusMi == null || row.radiusMi === "" ? undefined : asPositiveInt(row.radiusMi);
  if (row.radiusMi != null && row.radiusMi !== "" && radiusMi == null) {
    issues.push({ field: "radiusMi", message: "radiusMi must be a positive number." });
  }

  if (issues.length > 0) return { ok: false, issues };

  const bodyFamilyRaw = asTrimmed(row.bodyFamily, 20)?.toLowerCase();
  const bodyFamilyArg =
    bodyFamilyRaw === "car" || bodyFamilyRaw === "suv" || bodyFamilyRaw === "truck" || bodyFamilyRaw === "van"
      ? bodyFamilyRaw
      : undefined;

  return {
    ok: true,
    value: {
      make: asTrimmed(row.make, 40) ?? undefined,
      model: asTrimmed(row.model, 40) ?? undefined,
      bodyStyle: asTrimmed(row.bodyStyle, 40) ?? undefined,
      bodyFamily: bodyFamilyArg,
      priceMaxUsd: priceMaxUsd ?? undefined,
      milesMax: milesMax ?? undefined,
      yearMin: yearMin ?? undefined,
      yearMax: yearMax ?? undefined,
      zip: zip.ok ? zip.value : undefined,
      radiusMi: radiusMi ?? undefined,
      transmission: asTrimmed(row.transmission, 40) ?? undefined,
      fuel: asTrimmed(row.fuel, 40) ?? undefined,
      drivetrain: asTrimmed(row.drivetrain, 40) ?? undefined,
      sort: asTrimmed(row.sort, 40) ?? undefined,
      limit: limit.ok ? limit.value : LISTING_DEFAULT,
      page: page.ok ? page.value : undefined,
    },
  };
}

export function parseMakeModelYearArgs(raw: unknown): ToolArgResult<MakeModelYearArgs> {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, issues: [{ field: "args", message: "args must be an object." }] };
  }
  const row = raw as Record<string, unknown>;
  const make = asTrimmed(row.make, 40);
  const model = asTrimmed(row.model, 40);
  const year = asYear(row.year);
  const issues: ToolArgIssue[] = [];
  if (!make) issues.push({ field: "make", message: "make is required." });
  if (!model) issues.push({ field: "model", message: "model is required." });
  if (year == null) issues.push({ field: "year", message: "year must be a plausible model year." });
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { make: make!, model: model!, year: year! } };
}

export function parseMarketCompsArgs(raw: unknown): ToolArgResult<MarketCompsArgs> {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, issues: [{ field: "args", message: "get_market_comps args must be an object." }] };
  }
  const row = raw as Record<string, unknown>;
  const make = asTrimmed(row.make, 40);
  const model = asTrimmed(row.model, 40);
  const issues: ToolArgIssue[] = [];
  if (!make) issues.push({ field: "make", message: "make is required." });
  if (!model) issues.push({ field: "model", message: "model is required." });
  const zip = parseZipArg(row.zip);
  if (!zip.ok) issues.push(...zip.issues);
  const limit = parseLimitArg(row.limit);
  if (!limit.ok) issues.push(...limit.issues);
  if (issues.length > 0) return { ok: false, issues };
  const yearMin = row.yearMin == null || row.yearMin === "" ? undefined : asYear(row.yearMin) ?? undefined;
  const yearMax = row.yearMax == null || row.yearMax === "" ? undefined : asYear(row.yearMax) ?? undefined;
  const priceMaxUsd =
    row.priceMaxUsd == null || row.priceMaxUsd === "" ? undefined : asPositiveInt(row.priceMaxUsd) ?? undefined;
  const radiusMi =
    row.radiusMi == null || row.radiusMi === "" ? undefined : asPositiveInt(row.radiusMi) ?? undefined;
  return {
    ok: true,
    value: {
      make: make!,
      model: model!,
      yearMin,
      yearMax,
      priceMaxUsd,
      zip: zip.ok ? zip.value : undefined,
      radiusMi,
      limit: limit.ok ? limit.value : LISTING_DEFAULT,
    },
  };
}

/** OpenAI/SERV chat tool definitions (strict function parameters). */
export function findAgentChatTools(): Array<{
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  const searchParams = {
    type: "object",
    additionalProperties: false,
    properties: {
      make: { type: ["string", "null"] },
      model: { type: ["string", "null"] },
      bodyStyle: { type: ["string", "null"] },
      bodyFamily: { type: ["string", "null"], description: "car|suv|truck|van — post-filter; never send Sedan to Auto.dev" },
      priceMaxUsd: { type: ["number", "null"] },
      milesMax: { type: ["number", "null"] },
      yearMin: { type: ["number", "null"] },
      yearMax: { type: ["number", "null"] },
      zip: { type: ["string", "null"] },
      radiusMi: { type: ["number", "null"] },
      transmission: { type: ["string", "null"] },
      fuel: { type: ["string", "null"] },
      drivetrain: { type: ["string", "null"] },
      sort: { type: ["string", "null"] },
      limit: {
        type: ["number", "null"],
        description: `Page size for this call (max ${LIMIT_MAX}). Omit for default ${LISTING_DEFAULT}.`,
      },
      page: {
        type: ["number", "null"],
        description: "1-based provider page. Request page+1 when truncated is true so nothing stays hidden.",
      },
    },
    required: [
      "make",
      "model",
      "bodyStyle",
      "bodyFamily",
      "priceMaxUsd",
      "milesMax",
      "yearMin",
      "yearMax",
      "zip",
      "radiusMi",
      "transmission",
      "fuel",
      "drivetrain",
      "sort",
      "limit",
      "page",
    ],
  };
  const mmyParams = {
    type: "object",
    additionalProperties: false,
    properties: {
      make: { type: "string" },
      model: { type: "string" },
      year: { type: "number" },
    },
    required: ["make", "model", "year"],
  };
  const compsParams = {
    type: "object",
    additionalProperties: false,
    properties: {
      make: { type: "string" },
      model: { type: "string" },
      yearMin: { type: ["number", "null"] },
      yearMax: { type: ["number", "null"] },
      priceMaxUsd: { type: ["number", "null"] },
      zip: { type: ["string", "null"] },
      radiusMi: { type: ["number", "null"] },
      limit: { type: ["number", "null"] },
    },
    required: ["make", "model", "yearMin", "yearMax", "priceMaxUsd", "zip", "radiusMi", "limit"],
  };
  return [
    {
      type: "function",
      function: {
        name: "ask_shopper",
        description:
          "Ask the shopper one clarifying question in the same chat before searching. Use when budget, location, or other material facts are missing. Code pauses for the shopper's reply — do not invent answers. Call again for further questions if needed. When enough, call record_shopper_facts (if applicable) then search_listings / submit_picks.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            question: { type: "string", description: "One clear English question for the shopper." },
          },
          required: ["question"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "record_shopper_facts",
        description:
          "Record budget / ZIP / radius the shopper stated in chat (SERV-extracted). Call before or while searching so offer ≤ budget anti-fab uses the stated budget. Omit unknown fields as null.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            budgetUsd: { type: ["number", "null"] },
            zip: { type: ["string", "null"] },
            radiusMi: { type: ["number", "null"], description: "Miles radius, or null for nationwide." },
          },
          required: ["budgetUsd", "zip", "radiusMi"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "submit_brief",
        description:
          "When you have enough facts, submit a compact search brief for the shopper to confirm before any search_listings. budget.userQuote must be verbatim shopper words from chat (with maxUsd). Code pauses for Confirm/Correct — do not search until confirmed.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            summary: { type: "string", description: "One short English summary of what you will search for." },
            budget: {
              type: "object",
              additionalProperties: false,
              properties: {
                maxUsd: { type: ["number", "null"] },
                userQuote: {
                  type: ["string", "null"],
                  description: "Verbatim shopper words for the budget from chat, or null if none stated.",
                },
              },
              required: ["maxUsd", "userQuote"],
            },
            zip: { type: ["string", "null"] },
            radiusMi: { type: ["number", "null"] },
            notes: { type: ["string", "null"] },
          },
          required: ["summary", "budget", "zip", "radiusMi", "notes"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_listings",
        description:
          "Search live dealer listings (asking prices). Pass limit/page for pagination (max 50 per call); when truncated=true request the next page so nothing stays hidden. Returns unfiltered provider rows plus an observational funnel, constraintRoles (hard = shopper origin=user; relaxable = SERV-chosen), and duplicateSearch when filters match a prior call — change a relaxable filter; code never auto-relaxes or forces filter changes. Never send Sedan/Coupe/Hatch as provider body — use bodyFamily=car. Sell-window and profit are NOT inventory filters. If provider_raw=0 with a car body requested, retry without body before raising budget.",
        parameters: searchParams,
      },
    },
    {
      type: "function",
      function: {
        name: "get_recalls_complaints",
        description: "NHTSA recalls and complaint count for a make/model/year (not VIN-specific open status).",
        parameters: mmyParams,
      },
    },
    {
      type: "function",
      function: {
        name: "get_safety_ratings",
        description: "NHTSA safety / NCAP star ratings for a make/model/year when available.",
        parameters: mmyParams,
      },
    },
    {
      type: "function",
      function: {
        name: "get_market_comps",
        description:
          "Same-model asking-price comps and a rough price band from listings already in hand or a fresh narrow search. Not true sold prices.",
        parameters: compsParams,
      },
    },
    {
      type: "function",
      function: {
        name: "submit_picks",
        description:
          "Submit the final find verdict with chosen cars. Code validates real VINs from tool results, offer ≤ budget, and offer ≤ asking. On validation failure the tool returns issues — fix and call submit_picks again. Do not invent cars. To pass with no pick, call submit_nothing_fits instead.",
        parameters: FIND_AGENT_RESULT_SCHEMA as unknown as Record<string, unknown>,
      },
    },
    {
      type: "function",
      function: {
        name: "submit_nothing_fits",
        description:
          "Terminal: no car fits after searching. Pass a written reason only. Code attaches journaled search_listings evidence (params, counts, HTTP status) automatically — do not re-document searches.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            reason: {
              type: "string",
              description:
                "Why nothing fits, referencing what you tried. Code already journals every search_listings call.",
            },
          },
          required: ["reason"],
        },
      },
    },
  ];
}

/** Flat Responses tool defs (name/description/parameters at top level). */
export function findAgentResponsesTools(): Array<{
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}> {
  return findAgentChatTools().map((tool) => ({
    type: "function" as const,
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }));
}

export function listingToCard(listing: Listing): ListingCard | null {
  const vin = listing.vin?.trim().toUpperCase();
  if (!vin) return null;
  const distance = listing.distanceMiles ?? null;
  // Prefer the feed's own detail-page URL (vdp); fall back to dealerUrl when present.
  const listingUrl = buyerListingHref(listing.vdp) ?? buyerListingHref(listing.dealerUrl);
  return {
    vin,
    year: listing.year,
    make: listing.make,
    model: listing.model,
    price: listing.priceUsd,
    miles: listing.miles,
    drivetrain: listing.drivetrain ?? null,
    transmission: listing.transmission ?? null,
    fuel: listing.fuel ?? null,
    bodyStyle: listing.bodyStyle ?? null,
    style: listing.style ?? null,
    distanceMiles: distance,
    distance,
    city: listing.city,
    state: listing.state,
    createdAt: listing.createdAt ?? null,
    listingUrl,
  };
}

/** Map listings → cards for the SERV-requested page size (not a silent hide-rows cap). */
export function capListingCards(listings: readonly Listing[], limit = LISTING_DEFAULT): ListingCard[] {
  const out: ListingCard[] = [];
  const max = Math.min(Math.max(1, limit), LIMIT_MAX);
  for (const row of listings) {
    if (out.length >= max) break;
    const card = listingToCard(row);
    if (card) out.push(card);
  }
  return out;
}

function rememberListings(state: FindAgentToolState, listings: readonly Listing[]): void {
  for (const row of listings) {
    const vin = row.vin?.trim().toUpperCase();
    if (!vin) continue;
    state.knownVins.add(vin);
    state.listingsByVin.set(vin, row);
  }
}

function resolveBodyIntent(args: SearchListingsArgs): string | undefined {
  if (args.bodyFamily) return args.bodyFamily;
  return args.bodyStyle?.trim() || undefined;
}

function toListingQuery(args: SearchListingsArgs): ListingQuery {
  const yearRange =
    args.yearMin != null && args.yearMax != null
      ? `${args.yearMin}-${args.yearMax}`
      : args.yearMin != null
        ? `${args.yearMin}-2100`
        : args.yearMax != null
          ? `1980-${args.yearMax}`
          : undefined;
  // Soft ceiling so borderline asks still arrive for local price filter.
  const providerPriceMax =
    args.priceMaxUsd != null ? Math.round(args.priceMaxUsd * SEARCH_LISTINGS_PRICE_SOFT_FACTOR) : undefined;
  const priceRange = providerPriceMax != null ? `1-${providerPriceMax}` : undefined;
  const milesRange = args.milesMax != null ? `0-${args.milesMax}` : undefined;
  return {
    make: args.make,
    model: args.model,
    // listingsSearchUrl applies providerBodyStyleParam (omits Sedan/car-family).
    bodyStyle: resolveBodyIntent(args),
    yearRange,
    priceRange,
    milesRange,
    used: true,
    zip: args.zip,
    distanceMiles: args.radiusMi,
    sort: args.sort,
    limit: Math.min(args.limit ?? LISTING_DEFAULT, LIMIT_MAX),
    page: args.page != null && args.page > 1 ? args.page : undefined,
  };
}

function transmissionMatches(want: string, listing: Listing): boolean {
  const have = (listing.transmission ?? "").trim().toLowerCase();
  if (!have) return true; // unknown is not a hard reject
  const w = want.trim().toLowerCase();
  if (!w) return true;
  if (w === "automatic" || w === "auto") {
    return /auto|cvt|dct|dual.?clutch|amt/.test(have) && !/manual/.test(have);
  }
  if (w === "manual") return /manual|stick|mt\b/.test(have);
  return have.includes(w);
}

function bodyIntentMatches(intent: string | undefined, listing: Listing): boolean {
  if (!intent?.trim()) return true;
  const family = bodyFamily(intent);
  if (family) {
    const observed = bodyFamily(listing.bodyStyle) ?? bodyFamily(listing.style ?? null);
    if (observed == null) return true;
    return observed === family;
  }
  return bodyStyleMatches(intent, listing);
}

/**
 * Apply inventory filters in documented funnel order and return step counts.
 * Sell-window / profit are intentionally absent (ranking/verdict only).
 */
export function applySearchListingsFunnel(
  listings: readonly Listing[],
  args: SearchListingsArgs,
): { listings: Listing[]; funnel: SearchFunnelStep[] } {
  const funnel: SearchFunnelStep[] = [{ step: "provider_raw", count: listings.length }];

  let cur = listings.filter((row) => Boolean(row.vin?.trim()) && row.year > 0 && Boolean(row.make) && Boolean(row.model));
  funnel.push({ step: "normalized_vin_ymm", count: cur.length });

  cur = cur.filter((row) => isPassengerOrLightTruck(row));
  funnel.push({ step: "passenger_gate", count: cur.length });

  if (args.transmission?.trim()) {
    cur = cur.filter((row) => transmissionMatches(args.transmission!, row));
  }
  funnel.push({ step: "transmission", count: cur.length });

  const bodyIntent = resolveBodyIntent(args);
  if (bodyIntent) {
    cur = cur.filter((row) => bodyIntentMatches(bodyIntent, row));
  }
  funnel.push({ step: "body_family", count: cur.length });

  if (args.priceMaxUsd != null) {
    const ceiling = Math.round(args.priceMaxUsd * SEARCH_LISTINGS_PRICE_SOFT_FACTOR);
    cur = cur.filter((row) => row.priceUsd != null && row.priceUsd > 0 && row.priceUsd <= ceiling);
  }
  funnel.push({ step: "price", count: cur.length });

  if (args.milesMax != null) {
    cur = cur.filter((row) => row.miles == null || row.miles <= args.milesMax!);
  }
  funnel.push({ step: "miles", count: cur.length });

  if (args.radiusMi != null && args.zip) {
    cur = cur.filter(
      (row) => row.distanceMiles == null || (Number.isFinite(row.distanceMiles) && row.distanceMiles <= args.radiusMi!),
    );
  }
  funnel.push({ step: "radius", count: cur.length });

  // Soft post-filters that are not separate funnel steps in the doc, but still applied.
  if (args.fuel?.trim()) {
    const want = args.fuel.trim().toLowerCase();
    cur = cur.filter((row) => (row.fuel ?? "").toLowerCase().includes(want));
  }
  if (args.drivetrain?.trim()) {
    const want = args.drivetrain.trim().toLowerCase();
    cur = cur.filter((row) => (row.drivetrain ?? "").toLowerCase().includes(want));
  }

  return { listings: cur, funnel };
}

export function relaxHintsFromFunnel(
  funnel: readonly SearchFunnelStep[],
  args: SearchListingsArgs,
): SearchRelaxHint[] {
  const hints: SearchRelaxHint[] = [];
  const byStep = Object.fromEntries(funnel.map((s) => [s.step, s.count])) as Record<string, number>;
  const bodyIntent = resolveBodyIntent(args);
  const carBody =
    Boolean(bodyIntent) &&
    (bodyFamily(bodyIntent) === "car" || /sedan|coupe|hatch|convertible|car/i.test(bodyIntent ?? ""));

  if ((byStep.provider_raw ?? 0) === 0) {
    if (carBody || Boolean(args.bodyStyle) || args.bodyFamily === "car") hints.push("omit_body");
    hints.push("next_model");
    if (args.radiusMi != null) hints.push("widen_radius");
    if (args.priceMaxUsd != null) hints.push("raise_price");
    return hints;
  }

  const ordered: Array<{ step: SearchFunnelStep["step"]; hint: SearchRelaxHint }> = [
    { step: "transmission", hint: "drop_transmission" },
    { step: "body_family", hint: "omit_body" },
    { step: "price", hint: "raise_price" },
    { step: "miles", hint: "widen_miles" },
    { step: "radius", hint: "widen_radius" },
  ];
  for (const { step, hint } of ordered) {
    const idx = funnel.findIndex((s) => s.step === step);
    if (idx <= 0) continue;
    const prev = funnel[idx - 1]!.count;
    const cur = funnel[idx]!.count;
    if (prev > 0 && cur === 0) hints.push(hint);
  }
  if (args.fuel?.trim() && (byStep.radius ?? byStep.miles ?? 0) > 0 && hints.length === 0) {
    // Fuel filtered after radius; if we ended at 0 with prior >0, suggest drop_fuel.
    const last = funnel[funnel.length - 1]?.count ?? 0;
    if (last === 0) hints.push("drop_fuel");
  }
  if (args.drivetrain?.trim() && hints.includes("drop_fuel") === false) {
    const last = funnel[funnel.length - 1]?.count ?? 0;
    if (last === 0 && (byStep.radius ?? 0) > 0) hints.push("drop_drivetrain");
  }
  return [...new Set(hints)];
}

function priceBand(prices: number[]): {
  count: number;
  lowUsd: number | null;
  medianUsd: number | null;
  highUsd: number | null;
  honesty: string;
} {
  if (prices.length === 0) {
    return {
      count: 0,
      lowUsd: null,
      medianUsd: null,
      highUsd: null,
      honesty: "No asking-price comps available. These are not sold prices.",
    };
  }
  const sorted = [...prices].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
  return {
    count: sorted.length,
    lowUsd: sorted[0]!,
    medianUsd: median,
    highUsd: sorted[sorted.length - 1]!,
    honesty: "Asking-price comps from live listings — not true sold/transaction prices.",
  };
}

export type ExecuteToolResult = {
  name: FindAgentToolName;
  ok: boolean;
  result: Record<string, unknown>;
  summary: string;
};

export function createFindAgentToolState(
  seed?: readonly Listing[],
  userHardKeys?: Iterable<SearchFilterKey> | null,
): FindAgentToolState {
  const state: FindAgentToolState = {
    knownVins: new Set(),
    listingsByVin: new Map(),
    searchFingerprints: [],
    userHardKeys: new Set(userHardKeys ?? []),
    shopperFacts: { budgetUsd: null, zip: null, radiusMi: null },
    requireBriefConfirm: false,
    briefConfirmed: false,
  };
  if (seed?.length) rememberListings(state, seed);
  return state;
}


export function parseAskShopperArgs(raw: unknown): ToolArgResult<{ question: string }> {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, issues: [{ field: "args", message: "ask_shopper args must be an object." }] };
  }
  const row = raw as Record<string, unknown>;
  const question = typeof row.question === "string" ? row.question.trim() : "";
  if (!question) {
    return { ok: false, issues: [{ field: "question", message: "question is required." }] };
  }
  return { ok: true, value: { question: question.slice(0, 500) } };
}

export function parseRecordShopperFactsArgs(raw: unknown): ToolArgResult<{
  budgetUsd: number | null;
  zip: string | null;
  radiusMi: number | null;
}> {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, issues: [{ field: "args", message: "record_shopper_facts args must be an object." }] };
  }
  const row = raw as Record<string, unknown>;
  const issues: ToolArgIssue[] = [];
  let budgetUsd: number | null = null;
  if (row.budgetUsd != null && row.budgetUsd !== "") {
    const n = asPositiveInt(row.budgetUsd);
    if (n == null || n > 500_000) {
      issues.push({ field: "budgetUsd", message: "budgetUsd must be a positive dollar amount." });
    } else {
      budgetUsd = n;
    }
  }
  let zip: string | null = null;
  if (row.zip != null && row.zip !== "") {
    const parsed = parseZipArg(row.zip);
    if (!parsed.ok) issues.push(...parsed.issues);
    else zip = parsed.value ?? null;
  }
  let radiusMi: number | null = null;
  if (row.radiusMi != null && row.radiusMi !== "") {
    const n = asPositiveInt(row.radiusMi);
    if (n == null || n > 3000) {
      issues.push({ field: "radiusMi", message: "radiusMi must be a positive miles value or null for nationwide." });
    } else {
      radiusMi = n;
    }
  } else if (row.radiusMi === null) {
    radiusMi = null;
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { budgetUsd, zip, radiusMi } };
}

const PRE_BRIEF_TOOLS = new Set(["ask_shopper", "record_shopper_facts", "submit_brief"]);

export async function executeFindAgentTool(
  name: string,
  rawArgs: unknown,
  deps: FindAgentToolDeps,
  state: FindAgentToolState,
): Promise<ExecuteToolResult> {
  if (state.requireBriefConfirm && !state.briefConfirmed && !PRE_BRIEF_TOOLS.has(name)) {
    return {
      name: name as FindAgentToolName,
      ok: false,
      result: {
        error: "brief_not_confirmed",
        message: "Search and verdict tools run only after the shopper confirms the brief.",
      },
      summary: `${name} rejected: brief not confirmed`,
    };
  }
  const govDeps: GovDeps = { fetch: deps.fetch };
  const autodevDeps: AutodevDeps = {
    fetch: deps.fetch,
    apiKey: deps.autodevKey,
    cache: deps.autodev.cache,
    counter: deps.autodev.counter,
    reserve: deps.autodev.reserve,
    timeoutMs: deps.autodev.timeoutMs,
    maxAttempts: deps.autodev.maxAttempts,
    retryBaseMs: deps.autodev.retryBaseMs,
    sleep: deps.autodev.sleep,
    source: "autodev",
  };

  if (name === "ask_shopper") {
    const parsed = parseAskShopperArgs(rawArgs);
    if (!parsed.ok) {
      return {
        name: "ask_shopper",
        ok: false,
        result: { error: "invalid_args", issues: parsed.issues },
        summary: `ask_shopper rejected: ${parsed.issues.map((i) => i.message).join("; ")}`,
      };
    }
    return {
      name: "ask_shopper",
      ok: true,
      result: { ok: true, paused: true, question: parsed.value.question },
      summary: `ask_shopper: ${parsed.value.question.slice(0, 80)}`,
    };
  }

  if (name === "record_shopper_facts") {
    const parsed = parseRecordShopperFactsArgs(rawArgs);
    if (!parsed.ok) {
      return {
        name: "record_shopper_facts",
        ok: false,
        result: { error: "invalid_args", issues: parsed.issues },
        summary: `record_shopper_facts rejected: ${parsed.issues.map((i) => i.message).join("; ")}`,
      };
    }
    if (parsed.value.budgetUsd != null) state.shopperFacts.budgetUsd = parsed.value.budgetUsd;
    if (parsed.value.zip != null) state.shopperFacts.zip = parsed.value.zip;
    if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) && Object.prototype.hasOwnProperty.call(rawArgs, "radiusMi")) {
      state.shopperFacts.radiusMi = parsed.value.radiusMi;
    }
    return {
      name: "record_shopper_facts",
      ok: true,
      result: { ok: true, facts: { ...state.shopperFacts } },
      summary: `record_shopper_facts budget=${state.shopperFacts.budgetUsd ?? "—"} zip=${state.shopperFacts.zip ?? "—"}`,
    };
  }

  if (name === "submit_brief") {
    const parsed = parseShopperBrief(rawArgs);
    if (!parsed.ok) {
      return {
        name: "submit_brief",
        ok: false,
        result: { error: "invalid_args", issues: parsed.issues },
        summary: `submit_brief rejected: ${parsed.issues.map((i) => i.message).join("; ")}`,
      };
    }
    const quoteCheck = checkBudgetUserQuote(parsed.brief.budget, deps.chatTranscript ?? "");
    if (!quoteCheck.ok) {
      return {
        name: "submit_brief",
        ok: false,
        result: { error: "budget_quote", status: quoteCheck.status, issues: [{ field: "budget", message: quoteCheck.message }] },
        summary: `submit_brief rejected: ${quoteCheck.status}`,
      };
    }
    const card = formatShopperBriefCard(parsed.brief);
    return {
      name: "submit_brief",
      ok: true,
      result: { ok: true, paused: true, brief: parsed.brief as ShopperBrief, card, quoteStatus: quoteCheck.status },
      summary: `submit_brief: ${parsed.brief.summary.slice(0, 80)}`,
    };
  }

  if (name === "search_listings") {
    const parsed = parseSearchListingsArgs(rawArgs);
    if (!parsed.ok) {
      return {
        name,
        ok: false,
        result: { error: "invalid_args", issues: parsed.issues },
        summary: `search_listings rejected: ${parsed.issues.map((i) => i.message).join("; ")}`,
      };
    }
    const query = toListingQuery(parsed.value);
    const bodyIntent = resolveBodyIntent(parsed.value);
    const providerBody =
      mapBodyStyleForProvider(bodyIntent) ?? providerBodyStyleParam(bodyIntent) ?? null;
    const providerUrl = listingsSearchUrl(query);
    const search = await autodevSearch(query, autodevDeps);
    if (!search.ok) {
      if (search.error === "upstream") {
        return {
          name,
          ok: false,
          result: {
            error: search.error,
            message: search.message,
            status: search.status,
            cause: search.cause,
            attempts: search.attempts,
          },
          summary: `search_listings failed: ${search.message} (status=${search.status} cause=${search.cause} attempts=${search.attempts})`,
        };
      }
      return {
        name,
        ok: false,
        result: { error: search.error, message: search.message },
        summary: `search_listings failed: ${search.message}`,
      };
    }
    // Observational funnel for SERV's eyes — product filters must not drop returned rows.
    const { listings: funnelKept, funnel } = applySearchListingsFunnel(search.listings, parsed.value);
    const proxy = buildThinSearchProxyResult({
      providerListings: search.listings,
      params: parsed.value,
      funnel,
    });
    const dropGate = assertThinSearchProxyDidNotDropProductRows({
      providerListings: search.listings,
      returnedListings: proxy.listings,
    });
    if (!dropGate.ok) {
      return {
        name,
        ok: false,
        result: { error: "thin_proxy_violation", message: dropGate.detail },
        summary: `search_listings architecture violation: ${dropGate.detail}`,
      };
    }
    rememberListings(state, proxy.listings);
    // Honor SERV page size (≤ LIMIT_MAX). Do not shrink below the requested page.
    const pageLimit = Math.min(parsed.value.limit ?? LISTING_DEFAULT, LIMIT_MAX);
    const cars = capListingCards(proxy.listings, pageLimit);
    const relaxHints = relaxHintsFromFunnel(funnel, parsed.value);
    const totalReturned = proxy.listings.length;
    const truncated = search.listings.length >= pageLimit;
    const zeroStep = [...funnel].reverse().find((s) => s.count === 0);
    const funnelKeptCount = funnelKept.length;
    const argsRecord = parsed.value as unknown as Record<string, unknown>;
    const fingerprint = fingerprintSearchFilters(argsRecord);
    const duplicate = duplicateSearchInfo(fingerprint, state.searchFingerprints);
    state.searchFingerprints.push(fingerprint);
    const constraintInfo = classifySearchConstraints(argsRecord, state.userHardKeys);
    const summary =
      duplicate != null
        ? `search_listings → DUPLICATE of call #${duplicate.priorCallIndex}; change a relaxable filter (raw=${funnel[0]?.count ?? 0})`
        : totalReturned === 0
          ? `search_listings → 0 usable (raw=${funnel[0]?.count ?? 0}; zero_at=${zeroStep?.step ?? "unknown"}); hints=${relaxHints.join(",") || "—"}`
          : `search_listings → ${totalReturned} provider hits (funnel would keep ${funnelKeptCount}), returning ${cars.length}`;
    return {
      name,
      ok: true,
      result: {
        query: {
          ...parsed.value,
          providerBodyStyle: providerBody,
          providerPriceMaxUsd:
            parsed.value.priceMaxUsd != null
              ? Math.round(parsed.value.priceMaxUsd * SEARCH_LISTINGS_PRICE_SOFT_FACTOR)
              : null,
          providerUrl,
        },
        /** Exact filters SERV asked for on this call. */
        searched: constraintInfo.searched,
        /** Per-filter hard vs relaxable roles — SERV decides; code never auto-relaxes. */
        constraintRoles: constraintInfo.roles,
        hardKeys: constraintInfo.hardKeys,
        relaxableKeys: constraintInfo.relaxableKeys,
        fingerprint,
        callIndex: state.searchFingerprints.length,
        duplicateSearch: duplicate,
        totalReturned,
        funnel,
        funnelWouldKeep: funnelKeptCount,
        productFiltersWouldDrop: proxy.productFiltersWouldDrop,
        listings: cars,
        // Back-compat aliases for earlier agent prompts / tests.
        count: totalReturned,
        providerRawCount: funnel[0]?.count ?? 0,
        returned: cars.length,
        cars,
        relaxHints,
        truncated,
        nextPage: truncated ? (parsed.value.page ?? 1) + 1 : null,
        cached: search.cached,
        honesty:
          "Asking prices only. Thin proxy: unfiltered provider rows + observational funnel — code does not drop rows for product decisions. Paginate with page/limit when truncated=true. Sell-window and profit floor are ranking/verdict, never silent deletes. If duplicateSearch is set, change a relaxable filter before re-searching — code never auto-relaxes. If provider_raw=0 with a car body, retry omit_body before raise_price. A pass/nothing-fits must explain what you tried and why nothing fit.",
      },
      summary,
    };
  }

  if (name === "get_recalls_complaints") {
    const parsed = parseMakeModelYearArgs(rawArgs);
    if (!parsed.ok) {
      return {
        name,
        ok: false,
        result: { error: "invalid_args", issues: parsed.issues },
        summary: `get_recalls_complaints rejected: ${parsed.issues.map((i) => i.message).join("; ")}`,
      };
    }
    const { make, model, year } = parsed.value;
    const [recalls, complaints] = await Promise.all([
      recallsFor(make, model, year, govDeps),
      complaintsFor(make, model, year, govDeps),
    ]);
    const recallRows = recalls.records.slice(0, 8).map((r) => ({
      campaign: r.campaignNumber || null,
      component: r.component || null,
      summary: (r.summary ?? "").slice(0, 240),
      parkIt: Boolean(r.parkIt),
      parkOutSide: Boolean(r.parkOutSide),
    }));
    return {
      name,
      ok: recalls.available || complaints.available,
      result: {
        make,
        model,
        year,
        recallsAvailable: recalls.available,
        recallCount: recalls.records.length,
        recalls: recallRows,
        recallsError: recalls.error ?? null,
        complaintsAvailable: complaints.available,
        complaintCount: complaints.count,
        complaintsUrl: complaints.url,
      },
      summary: `recalls+complaints ${year} ${make} ${model}: recalls=${recalls.records.length} complaints=${complaints.count ?? "n/a"}`,
    };
  }

  if (name === "get_safety_ratings") {
    const parsed = parseMakeModelYearArgs(rawArgs);
    if (!parsed.ok) {
      return {
        name,
        ok: false,
        result: { error: "invalid_args", issues: parsed.issues },
        summary: `get_safety_ratings rejected: ${parsed.issues.map((i) => i.message).join("; ")}`,
      };
    }
    const { make, model, year } = parsed.value;
    const ratings = await safetyRatingsFor(make, model, year, govDeps);
    return {
      name,
      ok: ratings.available,
      result: {
        make,
        model,
        year,
        available: ratings.available,
        variants: ratings.variants.slice(0, 3).map((v) => ({
          vehicleId: v.vehicleId,
          description: v.description,
          overallRating: v.overallRating,
          frontRating: v.frontRating,
          sideRating: v.sideRating,
          rolloverRating: v.rolloverRating,
          ratingStatus: v.ratingStatus,
        })),
        indexUrl: ratings.indexUrl,
        detailUrl: ratings.detailUrl,
      },
      summary: `safety ${year} ${make} ${model}: available=${ratings.available} variants=${ratings.variants.length}`,
    };
  }

  if (name === "get_market_comps") {
    const parsed = parseMarketCompsArgs(rawArgs);
    if (!parsed.ok) {
      return {
        name,
        ok: false,
        result: { error: "invalid_args", issues: parsed.issues },
        summary: `get_market_comps rejected: ${parsed.issues.map((i) => i.message).join("; ")}`,
      };
    }
    const args = parsed.value;
    const makeLc = args.make.toLowerCase();
    const modelLc = args.model.toLowerCase();
    const inHand = [...state.listingsByVin.values(), ...(deps.seedListings ?? [])].filter((row) => {
      if (row.make.toLowerCase() !== makeLc) return false;
      if (row.model.toLowerCase() !== modelLc) return false;
      if (args.yearMin != null && row.year < args.yearMin) return false;
      if (args.yearMax != null && row.year > args.yearMax) return false;
      if (args.priceMaxUsd != null && (row.priceUsd == null || row.priceUsd > args.priceMaxUsd)) return false;
      return true;
    });

    let source: "in_hand" | "fresh_search" | "mixed" = "in_hand";
    let listings = inHand;
    if (listings.length < 3) {
      const search = await autodevSearch(
        toListingQuery({
          make: args.make,
          model: args.model,
          yearMin: args.yearMin,
          yearMax: args.yearMax,
          priceMaxUsd: args.priceMaxUsd,
          zip: args.zip,
          radiusMi: args.radiusMi,
          limit: args.limit,
        }),
        autodevDeps,
      );
      if (search.ok) {
        rememberListings(state, search.listings);
        const merged = new Map<string, Listing>();
        for (const row of [...inHand, ...search.listings]) {
          const vin = row.vin?.trim().toUpperCase();
          if (vin) merged.set(vin, row);
        }
        listings = [...merged.values()];
        source = inHand.length > 0 ? "mixed" : "fresh_search";
      }
    }

    const cars = capListingCards(listings, Math.min(args.limit ?? LISTING_DEFAULT, LIMIT_MAX));
    const prices = cars.map((c) => c.price).filter((p): p is number => typeof p === "number" && p > 0);
    const band = priceBand(prices);
    return {
      name,
      ok: true,
      result: {
        make: args.make,
        model: args.model,
        source,
        cars,
        band,
      },
      summary: `market_comps ${args.make} ${args.model}: n=${band.count} median=${band.medianUsd ?? "n/a"} (${source})`,
    };
  }

  return {
    name: name as FindAgentToolName,
    ok: false,
    result: { error: "unknown_tool", name },
    summary: `unknown tool: ${name}`,
  };
}
