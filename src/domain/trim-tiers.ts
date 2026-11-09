/**
 * Lemonless trim steps for adjusting one listing's asking price toward another.
 * A higher tier is more equipment. This is an equipment order, not a sold-price study.
 * Each step is worth TRIM_STEP_RATE of a typical asking price (see adjusted-comparables).
 * A name that is not in the list is unknown: no dollar adjustment, and the estimate gets wider.
 * Model lists win over the generic list so "SE" can be the base Tucson and a mid Camry.
 */

export const TRIM_STEP_RATE = 0.04;

const NOISE = new Set([
  "awd",
  "fwd",
  "rwd",
  "4wd",
  "4x4",
  "2wd",
  "4x2",
  "quattro",
  "sedan",
  "coupe",
  "wagon",
  "hatchback",
  "suv",
  "truck",
  "hybrid",
  "phev",
  "plugin",
  "plug",
  "in",
  "turbo",
  "v6",
  "v8",
  "v4",
  "i4",
  "i6",
  "gas",
  "gasoline",
  "diesel",
  "electric",
  "automatic",
  "manual",
  "cvt",
]);

/** Equipment order by make + model. Keys are normalized trim names. */
const MODEL_TIERS: Record<string, Record<string, number>> = {
  "toyota camry": {
    l: 0,
    le: 1,
    se: 2,
    xle: 3,
    xse: 4,
    trd: 5,
  },
  "toyota corolla": { l: 0, le: 1, se: 2, xle: 3, xse: 4 },
  "toyota rav4": { le: 0, xle: 1, "xle premium": 2, adventure: 2, trd: 3, limited: 3 },
  "honda cr-v": { lx: 0, ex: 1, "ex l": 2, exl: 2, touring: 3 },
  "honda accord": { lx: 0, sport: 1, ex: 2, "ex l": 3, exl: 3, touring: 4 },
  "honda civic": { lx: 0, sport: 1, ex: 2, "ex l": 3, exl: 3, touring: 4, si: 3, "type r": 5, typer: 5 },
  "hyundai tucson": { se: 0, eco: 1, sel: 1, sport: 1, "n line": 2, nline: 2, xrt: 2, limited: 3 },
  "kia sportage": { lx: 0, ex: 1, sx: 2, "sx turbo": 3, sxturbo: 3 },
};

/** Used only when that make and model have no list of their own. */
const GENERIC_TIERS: Record<string, number> = {
  base: 0,
  l: 0,
  s: 0,
  lx: 0,
  le: 1,
  sv: 1,
  se: 2,
  sel: 2,
  ex: 2,
  xle: 3,
  exl: 3,
  "ex l": 3,
  xse: 4,
  limited: 4,
  touring: 4,
  sx: 3,
  platinum: 5,
  trd: 5,
};

function modelKey(make: string, model: string): string {
  return `${make.trim().toLowerCase()} ${model.trim().toLowerCase()}`.replace(/\s+/g, " ");
}

export function normalizeTrimName(value: string | null | undefined): string {
  if (!value) return "";
  const tokens = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token && !NOISE.has(token));
  return tokens.join(" ");
}

function lookupTier(table: Record<string, number>, normalized: string): number | null {
  if (!normalized) return null;
  if (Object.prototype.hasOwnProperty.call(table, normalized)) return table[normalized] ?? null;
  const compact = normalized.replace(/ /g, "");
  if (Object.prototype.hasOwnProperty.call(table, compact)) return table[compact] ?? null;
  return null;
}

export type TrimTierHit = {
  tier: number;
  /** Normalized name that matched the list. */
  name: string;
};

/**
 * Tier for a trim name, or null when the name is missing or not on the list.
 * Model-specific lists do not fall through to the generic list.
 */
export function trimTier(make: string, model: string, trim: string | null | undefined): TrimTierHit | null {
  const normalized = normalizeTrimName(trim);
  if (!normalized) return null;
  const modelTable = MODEL_TIERS[modelKey(make, model)];
  if (modelTable) {
    const tier = lookupTier(modelTable, normalized);
    return tier == null ? null : { tier, name: normalized };
  }
  const tier = lookupTier(GENERIC_TIERS, normalized);
  return tier == null ? null : { tier, name: normalized };
}
