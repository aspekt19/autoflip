/**
 * Stage2C-followon — typed bounded inventory.search adjustments.
 * Must stay inside buyer mandate + server caps. Reject out-of-mandate without paid work.
 * Explicit null distanceMiles means nationwide when the mandate allows it (not ??-collapsed).
 */
import { MAX_DISTANCE_MILES } from "@/domain/need";
import { searchAskingPriceFloorUsd } from "./asking-price";
import type { ScoutMandate } from "./types";

export const SCOUT_SEARCH_PARAMS_VERSION = "scout-search-params/v1" as const;

/** Hard server caps on a single mid-loop adjustment (not client-raisable). */
export const SCOUT_SEARCH_SERVER_CAPS = {
  maxMakes: 4,
  maxModels: 6,
  /** Align with shared seller-distance technical ceiling so custom radii are not mid-loop blocked. */
  maxDistanceMiles: MAX_DISTANCE_MILES,
  maxMidLoopSearchesPerRun: 2,
  maxPriceUsd: 500_000,
  maxMiles: 500_000,
} as const;

export type ScoutSearchParams = {
  version: typeof SCOUT_SEARCH_PARAMS_VERSION;
  makes: string[];
  models: string[];
  zip: string | null;
  /** null = nationwide (only when mandate allows nationwide). */
  distanceMiles: number | null;
  /** Hard asking-price ceiling at query + ingestion. null = no explicit search price cap. */
  maxPriceUsd: number | null;
  /** Hard odometer ceiling at query + ingestion. null = no explicit miles cap. */
  maxMiles: number | null;
};

export type ScoutSearchValidation =
  | { ok: true; params: ScoutSearchParams; fingerprint: string }
  | {
      ok: false;
      reason: "out_of_mandate" | "invalid" | "duplicate" | "cap_exceeded";
      message: string;
    };

function normMake(s: string): string {
  return s.trim().toLowerCase();
}

function asStringList(raw: unknown, max: number): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return null;
    const t = item.trim();
    if (!t) continue;
    out.push(t);
    if (out.length > max) return null;
  }
  return out;
}

function readOptionalNonNeg(
  body: Record<string, unknown>,
  keys: string[],
): { present: boolean; value: number | null } | { error: string } {
  for (const key of keys) {
    if (!(key in body)) continue;
    const raw = body[key];
    if (raw === null) return { present: true, value: null };
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
      return { present: true, value: raw };
    }
    return { error: `${key} must be a non-negative number or null.` };
  }
  return { present: false, value: null };
}

/** Mandate defaults used for the initial inventory.search fingerprint. */
export function mandateToSearchParams(mandate: ScoutMandate): ScoutSearchParams {
  return {
    version: SCOUT_SEARCH_PARAMS_VERSION,
    makes: [...mandate.preferredMakes].slice(0, SCOUT_SEARCH_SERVER_CAPS.maxMakes),
    models: [],
    zip: mandate.zip,
    distanceMiles: mandate.maxDistanceMiles,
    maxPriceUsd: mandatePriceCap(mandate),
    maxMiles: mandate.maxMiles,
  };
}

/**
 * Explicit buyer asking-price hard cap when budget is known.
 * Personal and flip both use the stated budgetUsd — do not inflate to 1.25×
 * for search/qualification (that produced maxPriceUsd=25000 for a $20k mandate).
 * Soft ±5% buy-forbid envelope stays in gates, not the hard search cap.
 */
export function mandatePriceCap(mandate: ScoutMandate): number | null {
  if (!mandate.budgetKnown || mandate.budgetUsd == null) return null;
  return mandate.budgetUsd;
}

export function fingerprintSearchParams(params: ScoutSearchParams): string {
  const makes = [...params.makes].map(normMake).sort();
  const models = [...params.models].map(normMake).sort();
  return JSON.stringify({
    v: params.version,
    makes,
    models,
    zip: params.zip,
    distanceMiles: params.distanceMiles,
    maxPriceUsd: params.maxPriceUsd,
    maxMiles: params.maxMiles,
  });
}

/**
 * Validate planner args for inventory.search against mandate + server caps.
 * Does not invent licensed history or sold comps — search geo/make/model/price/miles.
 */
export function validateScoutSearchParams(
  raw: unknown,
  mandate: ScoutMandate,
  opts?: { priorFingerprints?: Iterable<string>; midLoopSearchCount?: number },
): ScoutSearchValidation {
  const midCount = opts?.midLoopSearchCount ?? 0;
  if (midCount >= SCOUT_SEARCH_SERVER_CAPS.maxMidLoopSearchesPerRun) {
    return {
      ok: false,
      reason: "cap_exceeded",
      message: `Mid-loop inventory.search cap reached (${SCOUT_SEARCH_SERVER_CAPS.maxMidLoopSearchesPerRun}) — no adapter call.`,
    };
  }

  const body =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const makes = asStringList(body.makes ?? body.preferredMakes, SCOUT_SEARCH_SERVER_CAPS.maxMakes);
  if (makes === null) {
    return { ok: false, reason: "invalid", message: "makes must be a string array within server caps." };
  }
  const models = asStringList(body.models, SCOUT_SEARCH_SERVER_CAPS.maxModels);
  if (models === null) {
    return { ok: false, reason: "invalid", message: "models must be a string array within server caps." };
  }

  // Default makes to mandate preferred when omitted.
  const effectiveMakes =
    makes.length > 0 ? makes : [...mandate.preferredMakes].slice(0, SCOUT_SEARCH_SERVER_CAPS.maxMakes);

  if (!mandate.openToOtherMakes && mandate.preferredMakes.length > 0) {
    const allowed = new Set(mandate.preferredMakes.map(normMake));
    for (const m of effectiveMakes) {
      if (!allowed.has(normMake(m))) {
        return {
          ok: false,
          reason: "out_of_mandate",
          message: `Make ${m} is outside mandate preferredMakes (openToOtherMakes=false) — rejected without adapter call.`,
        };
      }
    }
  }

  let zip: string | null;
  if (body.zip === undefined) {
    zip = mandate.zip;
  } else if (body.zip === null) {
    zip = null;
  } else if (typeof body.zip === "string" && /^\d{5}$/.test(body.zip.trim())) {
    zip = body.zip.trim();
  } else {
    return { ok: false, reason: "invalid", message: "zip must be a 5-digit US ZIP or null." };
  }

  // Cannot invent a different ZIP when mandate fixed one.
  if (mandate.zip && zip && zip !== mandate.zip) {
    return {
      ok: false,
      reason: "out_of_mandate",
      message: `zip ${zip} differs from mandate zip ${mandate.zip} — rejected without adapter call.`,
    };
  }
  // Nationwide (null zip) only when mandate has no zip, or explicit null when mandate zip null.
  if (mandate.zip && zip === null && body.zip === null) {
    return {
      ok: false,
      reason: "out_of_mandate",
      message: "Cannot drop mandate zip to nationwide mid-loop — rejected without adapter call.",
    };
  }

  // Explicit null must not be collapsed by ?? onto a sibling key (nationwide semantics).
  let distanceMiles: number | null;
  if ("distanceMiles" in body) {
    const rawDist = body.distanceMiles;
    if (rawDist === null) {
      distanceMiles = null;
    } else if (typeof rawDist === "number" && Number.isFinite(rawDist) && rawDist >= 0) {
      distanceMiles = rawDist;
    } else {
      return {
        ok: false,
        reason: "invalid",
        message: "distanceMiles must be a non-negative number or null.",
      };
    }
  } else if ("maxDistanceMiles" in body) {
    const rawDist = body.maxDistanceMiles;
    if (rawDist === null) {
      distanceMiles = null;
    } else if (typeof rawDist === "number" && Number.isFinite(rawDist) && rawDist >= 0) {
      distanceMiles = rawDist;
    } else {
      return {
        ok: false,
        reason: "invalid",
        message: "maxDistanceMiles must be a non-negative number or null.",
      };
    }
  } else {
    distanceMiles = mandate.maxDistanceMiles;
  }

  if (distanceMiles != null && distanceMiles > SCOUT_SEARCH_SERVER_CAPS.maxDistanceMiles) {
    return {
      ok: false,
      reason: "out_of_mandate",
      message: `distanceMiles ${distanceMiles} exceeds server cap ${SCOUT_SEARCH_SERVER_CAPS.maxDistanceMiles} — rejected without adapter call.`,
    };
  }
  if (
    mandate.maxDistanceMiles != null &&
    distanceMiles != null &&
    distanceMiles > mandate.maxDistanceMiles
  ) {
    return {
      ok: false,
      reason: "out_of_mandate",
      message: `distanceMiles ${distanceMiles} exceeds mandate maxDistanceMiles ${mandate.maxDistanceMiles} — rejected without adapter call.`,
    };
  }
  // Explicit nationwide (null) only when mandate already allows nationwide.
  if (distanceMiles === null && mandate.maxDistanceMiles != null) {
    return {
      ok: false,
      reason: "out_of_mandate",
      message: `distanceMiles null (nationwide) expands past mandate maxDistanceMiles ${mandate.maxDistanceMiles} — rejected without adapter call.`,
    };
  }
  if (distanceMiles != null && !zip) {
    return {
      ok: false,
      reason: "invalid",
      message: "distanceMiles requires a zip.",
    };
  }

  const priceRead = readOptionalNonNeg(body, ["maxPriceUsd", "priceMax", "maxPrice"]);
  if ("error" in priceRead) {
    return { ok: false, reason: "invalid", message: priceRead.error };
  }
  const milesRead = readOptionalNonNeg(body, ["maxMiles", "milesMax", "maxMileage"]);
  if ("error" in milesRead) {
    return { ok: false, reason: "invalid", message: milesRead.error };
  }

  const mandateCap = mandatePriceCap(mandate);
  let maxPriceUsd: number | null = priceRead.present ? priceRead.value : mandateCap;
  if (maxPriceUsd != null && maxPriceUsd > SCOUT_SEARCH_SERVER_CAPS.maxPriceUsd) {
    return {
      ok: false,
      reason: "out_of_mandate",
      message: `maxPriceUsd exceeds server cap ${SCOUT_SEARCH_SERVER_CAPS.maxPriceUsd}.`,
    };
  }
  if (mandateCap != null && maxPriceUsd != null && maxPriceUsd > mandateCap) {
    return {
      ok: false,
      reason: "out_of_mandate",
      message: `maxPriceUsd ${maxPriceUsd} exceeds mandate price cap ${mandateCap} — rejected without adapter call.`,
    };
  }
  if (mandateCap != null && maxPriceUsd === null && priceRead.present) {
    return {
      ok: false,
      reason: "out_of_mandate",
      message: "Cannot drop mandate price cap to null mid-loop — rejected without adapter call.",
    };
  }
  // Always enforce known mandate price cap even when planner omitted it.
  if (mandateCap != null && (maxPriceUsd == null || maxPriceUsd > mandateCap)) {
    maxPriceUsd = mandateCap;
  }

  let maxMiles: number | null = milesRead.present ? milesRead.value : mandate.maxMiles;
  if (maxMiles != null && maxMiles > SCOUT_SEARCH_SERVER_CAPS.maxMiles) {
    return {
      ok: false,
      reason: "out_of_mandate",
      message: `maxMiles exceeds server cap ${SCOUT_SEARCH_SERVER_CAPS.maxMiles}.`,
    };
  }
  if (mandate.maxMiles != null && maxMiles != null && maxMiles > mandate.maxMiles) {
    return {
      ok: false,
      reason: "out_of_mandate",
      message: `maxMiles ${maxMiles} exceeds mandate maxMiles ${mandate.maxMiles} — rejected without adapter call.`,
    };
  }
  if (mandate.maxMiles != null && maxMiles === null && milesRead.present) {
    return {
      ok: false,
      reason: "out_of_mandate",
      message: "Cannot drop mandate maxMiles to null mid-loop — rejected without adapter call.",
    };
  }
  if (mandate.maxMiles != null && (maxMiles == null || maxMiles > mandate.maxMiles)) {
    maxMiles = mandate.maxMiles;
  }

  const params: ScoutSearchParams = {
    version: SCOUT_SEARCH_PARAMS_VERSION,
    makes: effectiveMakes,
    models,
    zip,
    distanceMiles,
    maxPriceUsd,
    maxMiles,
  };
  const fingerprint = fingerprintSearchParams(params);
  if (opts?.priorFingerprints) {
    for (const prior of opts.priorFingerprints) {
      if (prior === fingerprint) {
        return {
          ok: false,
          reason: "duplicate",
          message: "Duplicate inventory.search params — rejected without adapter call (no paid work).",
        };
      }
    }
  }

  return { ok: true, params, fingerprint };
}

/** Apply validated search params onto a mandate copy for one adapter dispatch. */
export function mandateWithSearch(mandate: ScoutMandate, search: ScoutSearchParams): ScoutMandate {
  return {
    ...mandate,
    preferredMakes: search.makes.length ? search.makes : mandate.preferredMakes,
    zip: search.zip,
    maxDistanceMiles: search.distanceMiles,
    maxMiles: search.maxMiles,
    // Preserve budgetKnown/budgetUsd; search maxPriceUsd is enforced at filter/query separately.
  };
}

/** Build Auto.dev priceRange / milesRange query fragments (asking prices, not sold). */
export function searchQueryRanges(search: ScoutSearchParams | null | undefined): {
  priceRange?: string;
  milesRange?: string;
} {
  const out: { priceRange?: string; milesRange?: string } = {};
  if (search?.maxPriceUsd != null && search.maxPriceUsd > 0) {
    const max = Math.round(search.maxPriceUsd);
    // Auto.dev sort=price + price=1-N fills the limit with micro/placeholder asks.
    // When the budget can include a credible retail ask, start at the search floor
    // (complements year-aware genuine-purchase checks — not a magic floor alone).
    // Budgets below the floor still query 1-max (do not invent a higher ceiling).
    const min = searchAskingPriceFloorUsd(max);
    out.priceRange = `${min}-${max}`;
  }
  if (search?.maxMiles != null && search.maxMiles >= 0) {
    out.milesRange = `0-${Math.round(search.maxMiles)}`;
  }
  return out;
}
