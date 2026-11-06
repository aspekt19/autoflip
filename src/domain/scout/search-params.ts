/**
 * Stage2C — typed bounded inventory.search adjustments.
 * Must stay inside buyer mandate + server caps. Reject out-of-mandate without paid work.
 */
import type { ScoutMandate } from "./types";

export const SCOUT_SEARCH_PARAMS_VERSION = "scout-search-params/v1" as const;

/** Hard server caps on a single mid-loop adjustment (not client-raisable). */
export const SCOUT_SEARCH_SERVER_CAPS = {
  maxMakes: 4,
  maxModels: 6,
  maxDistanceMiles: 500,
  maxMidLoopSearchesPerRun: 2,
} as const;

export type ScoutSearchParams = {
  version: typeof SCOUT_SEARCH_PARAMS_VERSION;
  makes: string[];
  models: string[];
  zip: string | null;
  distanceMiles: number | null;
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

/** Mandate defaults used for the initial inventory.search fingerprint. */
export function mandateToSearchParams(mandate: ScoutMandate): ScoutSearchParams {
  return {
    version: SCOUT_SEARCH_PARAMS_VERSION,
    makes: [...mandate.preferredMakes].slice(0, SCOUT_SEARCH_SERVER_CAPS.maxMakes),
    models: [],
    zip: mandate.zip,
    distanceMiles: mandate.maxDistanceMiles,
  };
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
  });
}

/**
 * Validate planner args for inventory.search against mandate + server caps.
 * Does not invent licensed history or sold comps — search geo/make only.
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
  const effectiveMakes = makes.length > 0 ? makes : [...mandate.preferredMakes].slice(0, SCOUT_SEARCH_SERVER_CAPS.maxMakes);

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

  let distanceMiles: number | null;
  if (body.distanceMiles === undefined && body.maxDistanceMiles === undefined) {
    distanceMiles = mandate.maxDistanceMiles;
  } else {
    const rawDist = body.distanceMiles ?? body.maxDistanceMiles;
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
  if (distanceMiles != null && !zip) {
    return {
      ok: false,
      reason: "invalid",
      message: "distanceMiles requires a zip.",
    };
  }

  const params: ScoutSearchParams = {
    version: SCOUT_SEARCH_PARAMS_VERSION,
    makes: effectiveMakes,
    models,
    zip,
    distanceMiles,
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
  };
}
