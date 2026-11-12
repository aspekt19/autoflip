/**
 * Free city/state → representative ZIP table for Find intake.
 * Used when a note names a place without digits; never invents a ZIP for
 * unknown places (caller must show “needed”).
 */

const STATE_ABBR: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
  "district of columbia": "DC",
};

/** city|ST → 5-digit ZIP (city centroid / main post office). */
const CITY_ZIP: Record<string, string> = {
  "columbus|OH": "43215",
  "cleveland|OH": "44114",
  "cincinnati|OH": "45202",
  "omaha|NE": "68102",
  "lincoln|NE": "68508",
  "austin|TX": "78701",
  "dallas|TX": "75201",
  "houston|TX": "77002",
  "san antonio|TX": "78205",
  "chicago|IL": "60601",
  "denver|CO": "80202",
  "seattle|WA": "98101",
  "portland|OR": "97201",
  "phoenix|AZ": "85004",
  "tucson|AZ": "85701",
  "atlanta|GA": "30303",
  "miami|FL": "33130",
  "orlando|FL": "32801",
  "tampa|FL": "33602",
  "boston|MA": "02108",
  "new york|NY": "10001",
  "brooklyn|NY": "11201",
  "los angeles|CA": "90012",
  "san francisco|CA": "94102",
  "san diego|CA": "92101",
  "san jose|CA": "95113",
  "minneapolis|MN": "55401",
  "detroit|MI": "48226",
  "kansas city|MO": "64105",
  "st louis|MO": "63101",
  "saint louis|MO": "63101",
  "nashville|TN": "37203",
  "charlotte|NC": "28202",
  "raleigh|NC": "27601",
  "indianapolis|IN": "46204",
  "milwaukee|WI": "53202",
  "pittsburgh|PA": "15222",
  "philadelphia|PA": "19107",
  "baltimore|MD": "21201",
  "washington|DC": "20001",
  "las vegas|NV": "89101",
  "salt lake city|UT": "84101",
  "albuquerque|NM": "87102",
  "oklahoma city|OK": "73102",
  "tulsa|OK": "74103",
  "richmond|VA": "23219",
  "norfolk|VA": "23510",
  "jacksonville|FL": "32202",
  "memphis|TN": "38103",
  "louisville|KY": "40202",
  "buffalo|NY": "14202",
  "rochester|NY": "14604",
  "sacramento|CA": "95814",
  "oakland|CA": "94607",
  "fresno|CA": "93721",
};

export type LocationZipResolution = {
  zip: string | null;
  /**
   * How the ZIP was obtained:
   * - note_zip — buyer typed the 5 digits (only case for “from your note”)
   * - inferred_from_city — city/state table lookup (never “from your note”)
   */
  from: "note_zip" | "inferred_from_city" | null;
  /** True when a place was named but no ZIP could be resolved. */
  needed: boolean;
  /** Normalised city label when resolved from phrase (e.g. "Columbus, OH"). */
  cityLabel: string | null;
};

function normalizeStateToken(token: string): string | null {
  const t = token.trim().toLowerCase().replace(/\./g, "");
  if (/^[a-z]{2}$/.test(t)) return t.toUpperCase();
  return STATE_ABBR[t] ?? null;
}

const PLACE_SUFFIX = /\s+(?:area|metro|metropolitan area|region|vicinity)$/i;

/** City names in the free table, longest first so "san francisco" wins over "san". */
export function knownCityNames(): string[] {
  const names = new Set<string>();
  for (const key of Object.keys(CITY_ZIP)) {
    const city = key.split("|")[0];
    if (city) names.add(city);
  }
  return [...names].sort((a, b) => b.length - a.length);
}

/**
 * A table city written as a place, including "Atlanta area".
 * A bare city word is left to the near/in/around parser so a model name
 * that shares a city (Lincoln) is not treated as a location.
 */
export function cityPhraseInText(text: string): string | null {
  for (const city of knownCityNames()) {
    const escaped = city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\s+(?:area|metro|region)\\b`, "i");
    if (re.test(text)) return city;
  }
  return null;
}

/** Parse "Columbus OH", "Columbus, Ohio", "near Austin TX", "Atlanta area". */
export function parseCityStatePhrase(phrase: string): { city: string; state: string } | null {
  const cleaned = phrase
    .trim()
    .replace(/^near\s+/i, "")
    .replace(/^in\s+/i, "")
    .replace(/^around\s+/i, "")
    .replace(/^from\s+/i, "")
    .replace(PLACE_SUFFIX, "")
    .replace(/[.,]+$/g, "")
    .trim();
  if (!cleaned) return null;
  const comma = cleaned.match(/^(.+?),\s*([A-Za-z.]{2,})$/);
  if (comma) {
    const state = normalizeStateToken(comma[2]!);
    const city = comma[1]!.trim().toLowerCase().replace(/\s+/g, " ");
    if (state && city) return { city, state };
  }
  const parts = cleaned.split(/\s+/);
  if (parts.length === 1) {
    const city = parts[0]!.toLowerCase();
    const hits = Object.keys(CITY_ZIP).filter((key) => key.startsWith(`${city}|`));
    if (hits.length === 1) {
      const state = hits[0]!.split("|")[1];
      if (state) return { city, state };
    }
    return null;
  }
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1]!;
  const state = normalizeStateToken(last);
  if (!state) return null;
  const city = parts.slice(0, -1).join(" ").toLowerCase().replace(/\s+/g, " ");
  if (!city) return null;
  return { city, state };
}

export function zipForCityState(city: string, state: string): string | null {
  const key = `${city.trim().toLowerCase().replace(/\s+/g, " ")}|${state.trim().toUpperCase()}`;
  return CITY_ZIP[key] ?? null;
}

/**
 * Prefer an explicit 5-digit ZIP from the note; else resolve city+state via the free table.
 * Unknown places → needed (caller must show “needed”, never a stale wizard ZIP).
 */
export function resolveLocationZip(input: {
  zip: string | null | undefined;
  locationPhrase: string | null | undefined;
}): LocationZipResolution {
  const zip =
    typeof input.zip === "string" && /^\d{5}$/.test(input.zip.trim()) ? input.zip.trim() : null;
  if (zip) {
    return { zip, from: "note_zip", needed: false, cityLabel: null };
  }
  const phrase = typeof input.locationPhrase === "string" ? input.locationPhrase.trim() : "";
  if (!phrase) {
    return { zip: null, from: null, needed: false, cityLabel: null };
  }
  // "near me" is not a city — ZIP stays optional; blank search is nationwide.
  if (/^near\s+me\??$/i.test(phrase)) {
    return { zip: null, from: null, needed: false, cityLabel: phrase };
  }
  const parsed = parseCityStatePhrase(phrase);
  if (!parsed) {
    return { zip: null, from: null, needed: true, cityLabel: phrase };
  }
  const resolved = zipForCityState(parsed.city, parsed.state);
  const cityTitle = parsed.city.replace(/\b\w/g, (c) => c.toUpperCase());
  const label = `${cityTitle}, ${parsed.state}`;
  if (!resolved) {
    return { zip: null, from: null, needed: true, cityLabel: label };
  }
  return { zip: resolved, from: "inferred_from_city", needed: false, cityLabel: label };
}

/** Buyer-facing ZIP field mark — never “from your note” unless digits came from the note. */
export function zipFieldMark(resolution: LocationZipResolution | null | undefined): string | null {
  if (!resolution) return null;
  if (resolution.from === "note_zip") return "from your note";
  if (resolution.from === "inferred_from_city" && resolution.cityLabel) {
    return `near ${resolution.cityLabel} (inferred)`;
  }
  if (resolution.needed) return "needed";
  return null;
}
