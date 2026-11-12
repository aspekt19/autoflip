/**
 * Find-agent application tools — server-side keys only; args validated at the boundary.
 */
import { autodevSearch, type AutodevDeps } from "@/io/autodev";
import { complaintsFor, recallsFor, type GovDeps } from "@/io/gov";
import { safetyRatingsFor } from "@/io/nhtsa-safety";
import type { Listing } from "@/domain/types";
import type { ListingQuery } from "@/io/marketcheck";

export const FIND_AGENT_TOOL_NAMES = [
  "search_listings",
  "get_recalls_complaints",
  "get_safety_ratings",
  "get_market_comps",
] as const;
export type FindAgentToolName = (typeof FIND_AGENT_TOOL_NAMES)[number];

export type SearchListingsArgs = {
  make?: string;
  model?: string;
  bodyStyle?: string;
  priceMaxUsd?: number;
  milesMax?: number;
  yearMin?: number;
  yearMax?: number;
  zip?: string;
  radiusMi?: number;
  fuel?: string;
  drivetrain?: string;
  sort?: string;
  limit?: number;
};

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
  distance: number | null;
  city: string | null;
  state: string | null;
};

export type FindAgentToolState = {
  /** VINs returned by any tool this run (uppercase). */
  knownVins: Set<string>;
  /** Full listings keyed by VIN for comps / finish mapping. */
  listingsByVin: Map<string, Listing>;
};

export type FindAgentToolDeps = {
  fetch: typeof fetch;
  autodevKey: string;
  autodev: Pick<AutodevDeps, "cache" | "counter" | "reserve" | "timeoutMs">;
  /** Optional seed inventory already in hand (match pool). */
  seedListings?: readonly Listing[];
};

const LISTING_CAP = 12;
const LIMIT_MAX = 20;

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
  if (value == null || value === "") return { ok: true, value: 12 };
  const n = asPositiveInt(value);
  if (n == null) {
    return { ok: false, issues: [{ field: "limit", message: "limit must be a positive integer ≤ 20." }] };
  }
  if (n > LIMIT_MAX) {
    return { ok: false, issues: [{ field: "limit", message: `limit must be ≤ ${LIMIT_MAX}.` }] };
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

  return {
    ok: true,
    value: {
      make: asTrimmed(row.make, 40) ?? undefined,
      model: asTrimmed(row.model, 40) ?? undefined,
      bodyStyle: asTrimmed(row.bodyStyle, 40) ?? undefined,
      priceMaxUsd: priceMaxUsd ?? undefined,
      milesMax: milesMax ?? undefined,
      yearMin: yearMin ?? undefined,
      yearMax: yearMax ?? undefined,
      zip: zip.ok ? zip.value : undefined,
      radiusMi: radiusMi ?? undefined,
      fuel: asTrimmed(row.fuel, 40) ?? undefined,
      drivetrain: asTrimmed(row.drivetrain, 40) ?? undefined,
      sort: asTrimmed(row.sort, 40) ?? undefined,
      limit: limit.ok ? limit.value : 12,
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
      limit: limit.ok ? limit.value : 12,
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
      priceMaxUsd: { type: ["number", "null"] },
      milesMax: { type: ["number", "null"] },
      yearMin: { type: ["number", "null"] },
      yearMax: { type: ["number", "null"] },
      zip: { type: ["string", "null"] },
      radiusMi: { type: ["number", "null"] },
      fuel: { type: ["string", "null"] },
      drivetrain: { type: ["string", "null"] },
      sort: { type: ["string", "null"] },
      limit: { type: ["number", "null"] },
    },
    required: [
      "make",
      "model",
      "bodyStyle",
      "priceMaxUsd",
      "milesMax",
      "yearMin",
      "yearMax",
      "zip",
      "radiusMi",
      "fuel",
      "drivetrain",
      "sort",
      "limit",
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
        name: "search_listings",
        description:
          "Search live dealer listings (asking prices). Prefer tight filters first; relax soft conditions and re-search when empty or poor.",
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
  ];
}

export function listingToCard(listing: Listing): ListingCard | null {
  const vin = listing.vin?.trim().toUpperCase();
  if (!vin) return null;
  return {
    vin,
    year: listing.year,
    make: listing.make,
    model: listing.model,
    price: listing.priceUsd,
    miles: listing.miles,
    drivetrain: listing.drivetrain,
    distance: listing.distanceMiles ?? null,
    city: listing.city,
    state: listing.state,
  };
}

export function capListingCards(listings: readonly Listing[], limit = LISTING_CAP): ListingCard[] {
  const out: ListingCard[] = [];
  for (const row of listings) {
    if (out.length >= limit) break;
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

function toListingQuery(args: SearchListingsArgs): ListingQuery {
  const yearRange =
    args.yearMin != null && args.yearMax != null
      ? `${args.yearMin}-${args.yearMax}`
      : args.yearMin != null
        ? `${args.yearMin}-2100`
        : args.yearMax != null
          ? `1980-${args.yearMax}`
          : undefined;
  const priceRange = args.priceMaxUsd != null ? `0-${args.priceMaxUsd}` : undefined;
  const milesRange = args.milesMax != null ? `0-${args.milesMax}` : undefined;
  return {
    make: args.make,
    model: args.model,
    bodyStyle: args.bodyStyle,
    yearRange,
    priceRange,
    milesRange,
    used: true,
    zip: args.zip,
    distanceMiles: args.radiusMi,
    sort: args.sort,
    limit: Math.min(args.limit ?? 12, LIMIT_MAX),
  };
}

function filterClientSide(
  listings: readonly Listing[],
  opts: { fuel?: string; drivetrain?: string },
): Listing[] {
  let out = [...listings];
  if (opts.fuel?.trim()) {
    const want = opts.fuel.trim().toLowerCase();
    out = out.filter((row) => (row.fuel ?? "").toLowerCase().includes(want));
  }
  if (opts.drivetrain?.trim()) {
    const want = opts.drivetrain.trim().toLowerCase();
    out = out.filter((row) => (row.drivetrain ?? "").toLowerCase().includes(want));
  }
  return out;
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

export function createFindAgentToolState(seed?: readonly Listing[]): FindAgentToolState {
  const state: FindAgentToolState = {
    knownVins: new Set(),
    listingsByVin: new Map(),
  };
  if (seed?.length) rememberListings(state, seed);
  return state;
}

export async function executeFindAgentTool(
  name: string,
  rawArgs: unknown,
  deps: FindAgentToolDeps,
  state: FindAgentToolState,
): Promise<ExecuteToolResult> {
  const govDeps: GovDeps = { fetch: deps.fetch };
  const autodevDeps: AutodevDeps = {
    fetch: deps.fetch,
    apiKey: deps.autodevKey,
    cache: deps.autodev.cache,
    counter: deps.autodev.counter,
    reserve: deps.autodev.reserve,
    timeoutMs: deps.autodev.timeoutMs,
    source: "autodev",
  };

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
    const search = await autodevSearch(query, autodevDeps);
    if (!search.ok) {
      return {
        name,
        ok: false,
        result: { error: search.error, message: search.message },
        summary: `search_listings failed: ${search.message}`,
      };
    }
    const filtered = filterClientSide(search.listings, {
      fuel: parsed.value.fuel,
      drivetrain: parsed.value.drivetrain,
    });
    rememberListings(state, filtered);
    const cars = capListingCards(filtered, Math.min(parsed.value.limit ?? LISTING_CAP, LISTING_CAP));
    return {
      name,
      ok: true,
      result: {
        count: filtered.length,
        returned: cars.length,
        cars,
        query: parsed.value,
        cached: search.cached,
      },
      summary: `search_listings → ${filtered.length} hits, returning ${cars.length}`,
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

    const cars = capListingCards(listings, Math.min(args.limit ?? LISTING_CAP, LISTING_CAP));
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
