import { parseUsdInput } from "./budget";

/** Same ceiling as MAX_DISTANCE_MILES in need.ts. Kept local to avoid an import cycle. */
const NOTE_RADIUS_MAX = 3000;
/**
 * Former silent default when a ZIP appeared without “within N miles”.
 * Kept as a named constant for Confirm UI copy — intake no longer invents this
 * into {@link NoteIntake.distanceMiles}; ZIP-only stays nationwide until the
 * shopper sets a radius.
 */
export const NOTE_DEFAULT_RADIUS_WHEN_ZIP = 100;

/**
 * Deterministic read of a Find note.
 * SERV extraction can still run later; this fills anything the model left blank
 * and parses prices the older dollar regex dropped ($15k, under 15k, 15,000).
 */

export type TransmissionPref = "automatic" | "manual";

export type HistoryPref = "no_salvage" | "no_accidents" | "no_salvage_no_accidents";

export const NOTE_BODY_STYLES = ["SUV", "Sedan", "Truck", "Hatchback", "Van", "Wagon", "Coupe", "Minivan"] as const;
export type NoteBodyStyle = (typeof NOTE_BODY_STYLES)[number];

export type NoteIntake = {
  budgetUsd: number | null;
  transmission: TransmissionPref | null;
  fuelEconomyPriority: boolean;
  historyPreference: HistoryPref | null;
  bodyStyle: NoteBodyStyle | null;
  yearMin: number | null;
  yearMax: number | null;
  milesMax: number | null;
  zip: string | null;
  /** City or place named in the note. Not a guessed ZIP. */
  locationPhrase: string | null;
  /**
   * Seller-distance radius. Only set when the note explicitly says
   * “within N miles”. A ZIP alone does not invent a radius — Confirm leaves
   * the search nationwide until the shopper picks one.
   */
  distanceMiles: number | null;
  mustHaves: string[];
  priorities: string[];
};

const MONEY_NUMBER = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)`;
const PRICE_KEYWORD =
  "under|below|budget|around|about|approximately|roughly|less than|up to";

function yearCap(now = new Date()): number {
  return now.getUTCFullYear() + 1;
}

function moneyValue(raw: string, k: boolean): number | null {
  const token = `${raw.replace(/,/g, "")}${k ? "k" : ""}`;
  const value = parseUsdInput(token);
  if (value == null || value < 1000 || value > 250_000) return null;
  return value;
}

function grandValue(raw: string): number | null {
  const base = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(base) || base <= 0) return null;
  const value = Math.round(base * 1000);
  if (value < 1000 || value > 250_000) return null;
  return value;
}

/** "12-15k" means 12,000–15,000. The price field is a maximum, so the high end is used. */
function rangeEnd(raw: string, own: string, other: string): number | null {
  if (own === "grand") return grandValue(raw);
  if (own === "k") return moneyValue(raw, true);
  if ((other === "k" || other === "grand") && Number(raw.replace(/,/g, "")) < 1000) {
    return other === "grand" ? grandValue(raw) : moneyValue(raw, true);
  }
  return moneyValue(raw, false);
}

function followedByMiles(text: string, end: number): boolean {
  return /^\s*(?:miles|mi)\b/i.test(text.slice(end));
}

/** Read a budget the shopper actually wrote. Does not guess a number that is not there. */
export function budgetFromText(text: string, now = new Date()): number | null {
  const cap = yearCap(now);
  const hits: Array<{ index: number; usd: number }> = [];

  const consider = (
    index: number,
    raw: string,
    k: boolean,
    end: number,
    opts: { dollar: boolean; keyword?: string },
  ) => {
    if (followedByMiles(text, end)) return;
    const digits = raw.replace(/[^\d]/g, "");
    const keyword = opts.keyword ?? "";
    if (
      !opts.dollar &&
      !k &&
      !raw.includes(",") &&
      /^\d{5}$/.test(digits) &&
      /^(?:near|in|from)$/i.test(keyword)
    ) {
      return;
    }
    if (
      !opts.dollar &&
      !k &&
      !raw.includes(",") &&
      digits.length === 4 &&
      Number(digits) >= 1980 &&
      Number(digits) <= cap &&
      !/^(?:under|below|budget|less than|up to)$/i.test(keyword)
    ) {
      return;
    }
    if (!opts.dollar && !opts.keyword) {
      const before = text.slice(Math.max(0, index - 24), index);
      if (/\b(?:max(?:imum)?|no more than|at most)\s*$/i.test(before)) return;
    }
    if (!opts.dollar && /\b(?:max(?:imum)?|no more than|at most)\b/i.test(opts.keyword ?? "")) {
      return;
    }
    const usd = moneyValue(raw, k);
    if (usd == null) return;
    hits.push({ index, usd });
  };

  const dollar = new RegExp(String.raw`\$\s*(${MONEY_NUMBER})\s*(k)?\b`, "gi");
  for (const match of text.matchAll(dollar)) {
    const raw = match[1] ?? "";
    const k = Boolean(match[2]);
    const end = (match.index ?? 0) + match[0].length;
    consider(match.index ?? 0, raw, k, end, { dollar: true });
  }

  const keyed = new RegExp(
    String.raw`\b(${PRICE_KEYWORD})\b[^$\n]{0,40}?(\$)?\s*(${MONEY_NUMBER})\s*(k)?\b`,
    "gi",
  );
  for (const match of text.matchAll(keyed)) {
    const raw = match[3] ?? "";
    const k = Boolean(match[4]);
    const end = (match.index ?? 0) + match[0].length;
    consider(match.index ?? 0, raw, k, end, { dollar: Boolean(match[2]), keyword: match[1] ?? "" });
  }

  const range = new RegExp(
    String.raw`\b(?:around|about|between|budget|roughly)\b[^$\n]{0,24}?\$?\s*(${MONEY_NUMBER})\s*(k|grand)?\s*(?:-|–|—|to|and)\s*\$?\s*(${MONEY_NUMBER})\s*(k|grand)?\b`,
    "gi",
  );
  for (const match of text.matchAll(range)) {
    const end = (match.index ?? 0) + match[0].length;
    if (followedByMiles(text, end)) continue;
    const leftSuffix = (match[2] ?? "").toLowerCase();
    const rightSuffix = (match[4] ?? "").toLowerCase();
    const left = rangeEnd(match[1] ?? "", leftSuffix, rightSuffix);
    const right = rangeEnd(match[3] ?? "", rightSuffix, leftSuffix);
    const usd = Math.max(left ?? 0, right ?? 0);
    if (usd >= 1000) hits.push({ index: match.index ?? 0, usd });
  }

  const grand = new RegExp(
    String.raw`\b(?:under|below|budget|around|about|approximately|roughly|less than|up to)?\s*\$?\s*(${MONEY_NUMBER})\s*grand\b`,
    "gi",
  );
  for (const match of text.matchAll(grand)) {
    const usd = grandValue(match[1] ?? "");
    if (usd == null) continue;
    hits.push({ index: match.index ?? 0, usd });
  }

  const tilde = new RegExp(String.raw`~\s*\$?\s*(${MONEY_NUMBER})\s*(k)?\b`, "gi");
  for (const match of text.matchAll(tilde)) {
    const raw = match[1] ?? "";
    const k = Boolean(match[2]);
    const end = (match.index ?? 0) + match[0].length;
    consider(match.index ?? 0, raw, k, end, { dollar: match[0].includes("$"), keyword: "around" });
  }

  const bare = new RegExp(String.raw`(?:^|[^\d$])(${MONEY_NUMBER}\s*k|\d{1,3}(?:,\d{3})+)\b`, "gi");
  for (const match of text.matchAll(bare)) {
    const token = (match[1] ?? "").replace(/\s+/g, "");
    const k = /k$/i.test(token);
    const raw = token.replace(/k$/i, "");
    const full = match[0];
    const lead = full.length - (match[1]?.length ?? 0);
    const index = (match.index ?? 0) + lead;
    const end = index + (match[1]?.length ?? 0);
    consider(index, raw, k, end, { dollar: false });
  }

  hits.sort((a, b) => a.index - b.index);
  return hits[0]?.usd ?? null;
}

export function transmissionFromText(text: string): TransmissionPref | null {
  const auto = /\bautomatics?\b|\bauto transmission\b/i.exec(text);
  const manual = /\bmanuals?\b|\bstick(?:\s|-)?shift\b|\bstandard transmission\b/i.exec(text);
  if (auto && manual) return auto.index <= manual.index ? "automatic" : "manual";
  if (auto) return "automatic";
  if (manual) return "manual";
  return null;
}

export function fuelEconomyFromText(text: string): boolean {
  return /\b(?:good on gas|gas mileage|fuel economy|fuel[- ]efficient|efficient on gas|cheap on gas|saves? gas|\bmpg\b)\b/i.test(
    text,
  );
}

export function historyFromText(text: string): HistoryPref | null {
  const salvage =
    /\b(?:no|not|nothing|without|avoid|exclude|excluding)\s+(?:a\s+|any\s+|the\s+)?(?:salvage|rebuilt|branded title)\b/i.test(
      text,
    ) ||
    /\bnothing\s+salvage\b/i.test(text) ||
    /\bclean title\b/i.test(text);
  const accidents =
    /\b(?:no|not|without|avoid|exclude|excluding)\s+(?:a\s+|any\s+|prior\s+|previous\s+)?accidents?\b/i.test(text) ||
    /\b(?:no|without)\s+(?:an?\s+)?accident\s+history\b/i.test(text) ||
    /\bnothing\b[^.]{0,60}\baccident(?:\s+history)?\b/i.test(text) ||
    /\bno\s+accidents?\b/i.test(text) ||
    /\bdon'?t want\b[^.]{0,40}\baccidents?\b/i.test(text);
  if (salvage && accidents) return "no_salvage_no_accidents";
  if (salvage) return "no_salvage";
  if (accidents) return "no_accidents";
  return null;
}

export function bodyFromIntake(text: string): NoteBodyStyle | null {
  if (/\b(?:minivans?|mini-vans?)\b/i.test(text)) return "Minivan";
  if (/\b(?:suvs?|crossovers?)\b/i.test(text)) return "SUV";
  if (/\b(?:pick-?ups?|trucks?)\b/i.test(text)) return "Truck";
  if (/\bhatchbacks?\b/i.test(text)) return "Hatchback";
  if (/\bwagons?\b/i.test(text)) return "Wagon";
  if (/\bcoupes?\b/i.test(text)) return "Coupe";
  if (/\bvans?\b/i.test(text)) return "Van";
  if (/\bsedans?\b/i.test(text)) return "Sedan";
  return null;
}

export function yearsFromNote(text: string, now = new Date()): { yearMin: number | null; yearMax: number | null } {
  const cap = yearCap(now);
  const Y = String.raw`(19\d{2}|20\d{2})`;
  const ok = (year: number) => year >= 1980 && year <= cap;
  const range = text.match(new RegExp(String.raw`\b${Y}\s*(?:-|–|—|to|through)\s*${Y}\b`, "i"));
  if (range) {
    let lo = Number(range[1]);
    let hi = Number(range[2]);
    if (lo > hi) [lo, hi] = [hi, lo];
    if (ok(lo) && ok(hi)) return { yearMin: lo, yearMax: hi };
  }
  const floor =
    text.match(
      new RegExp(
        String.raw`\b(?:no older than|newer than|after|from|minimum year|oldest(?: model year)?(?: of| is)?)\s+${Y}\b`,
        "i",
      ),
    ) || text.match(new RegExp(String.raw`\b${Y}\s*(?:or newer|and newer|or later|\+|and up)\b`, "i"));
  if (floor) {
    const year = Number(floor[1]);
    if (ok(year)) return { yearMin: year, yearMax: null };
  }
  const ceiling = text.match(new RegExp(String.raw`\b(?:no newer than|older than|up to year)\s+${Y}\b`, "i"));
  if (ceiling) {
    const year = Number(ceiling[1]);
    if (ok(year)) return { yearMin: null, yearMax: year };
  }
  const exact = text.match(new RegExp(String.raw`\b(?:model year|year)\s+${Y}\b`, "i"));
  if (exact) {
    const year = Number(exact[1]);
    if (ok(year)) return { yearMin: year, yearMax: year };
  }
  const bare = text.match(
    new RegExp(
      String.raw`\b(?:a|an)\s+${Y}\b|\b${Y}\s+(?:honda|toyota|ford|chevy|chevrolet|nissan|hyundai|kia|mazda|subaru|bmw|audi|volkswagen|vw|jeep|gmc|ram|dodge)\b`,
      "i",
    ),
  );
  if (bare) {
    const year = Number(bare[1] || bare[2]);
    if (ok(year)) return { yearMin: year, yearMax: year };
  }
  return { yearMin: null, yearMax: null };
}

/** Odometer cap. A price like “under 15k” is not mileage unless the note says miles. */
export function milesCapFromNote(text: string): number | null {
  const patterns = [
    /(?:up to|under|less than|no more than|max(?:imum)?|at most)\s+([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+(?:\.[0-9]+)?)\s*(k)?\s*(miles|mi)\b/i,
    /\b(?:max(?:imum)?|no more than|at most)\s+([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+(?:\.[0-9]+)?)\s*(k)\b/i,
    /\b([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+(?:\.[0-9]+)?)\s*(k)?\s*(?:miles|mi)\s*(?:or less|or under|max|maximum|cap)\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match || match[0].includes("$")) continue;
    let value = Number(match[1]!.replace(/,/g, ""));
    if (match[2]) value *= 1000;
    if (!Number.isFinite(value) || value < 1_000 || value > 400_000) continue;
    return Math.round(value);
  }
  return null;
}

const PLACE_STOP = new Set([
  "good",
  "bad",
  "the",
  "a",
  "an",
  "my",
  "this",
  "that",
  "me",
  "us",
  "it",
  "town",
  "general",
  "city",
  "fact",
  "order",
  "case",
  "person",
  "need",
  "budget",
  "cash",
  "gas",
  "miles",
  "mile",
  "year",
  "total",
  "shape",
  "condition",
  "accident",
  "salvage",
  "stock",
  "time",
  "mind",
  "addition",
  "particular",
  "terms",
  "hand",
  "other",
  "under",
  "about",
  "over",
  "between",
  "above",
  "below",
]);

export function locationPhraseFromText(text: string): string | null {
  const re = /\b(?:near|in|around|from)\s+([A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,2})/gi;
  for (const match of text.matchAll(re)) {
    const phrase = match[1]!.trim().replace(/[.,]$/, "");
    const first = phrase.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (!first || PLACE_STOP.has(first)) continue;
    return phrase;
  }
  return null;
}

export function zipFromNote(text: string, budgetUsd: number | null): string | null {
  const re = /\b(\d{5})(?:-\d{4})?\b/g;
  for (const match of text.matchAll(re)) {
    const zip = match[1]!;
    const index = match.index ?? 0;
    const before = text.slice(Math.max(0, index - 1), index);
    if (before === "$") continue;
    if (budgetUsd != null && Number(zip) === budgetUsd) continue;
    const after = text.slice(index + zip.length, index + zip.length + 10);
    if (/^\s*(?:miles|mi|k)\b/i.test(after)) continue;
    return zip;
  }
  return null;
}

export function radiusFromNote(text: string): number | null {
  const match = text.match(/\b(?:within|inside)\s+(\d{1,4})\s*(?:miles|mi)\b/i);
  if (!match) return null;
  const miles = Number(match[1]);
  if (!Number.isFinite(miles) || miles <= 0 || miles > NOTE_RADIUS_MAX) return null;
  return Math.round(miles);
}

function historyMusts(history: HistoryPref | null): string[] {
  if (history === "no_salvage_no_accidents") return ["no salvage", "no accident history"];
  if (history === "no_salvage") return ["no salvage"];
  if (history === "no_accidents") return ["no accident history"];
  return [];
}

export function intakeFromNote(text: string, now = new Date()): NoteIntake {
  const budgetUsd = budgetFromText(text, now);
  const transmission = transmissionFromText(text);
  const fuelEconomyPriority = fuelEconomyFromText(text);
  const historyPreference = historyFromText(text);
  const bodyStyle = bodyFromIntake(text);
  const years = yearsFromNote(text, now);
  const milesMax = milesCapFromNote(text);
  const zip = zipFromNote(text, budgetUsd);
  const locationPhrase = locationPhraseFromText(text);
  const radius = radiusFromNote(text);
  const mustHaves = [
    transmission === "automatic" ? "automatic" : null,
    transmission === "manual" ? "manual" : null,
    ...historyMusts(historyPreference),
    bodyStyle,
  ].filter((item): item is string => Boolean(item));
  const priorities = fuelEconomyPriority ? ["fuel economy"] : [];
  return {
    budgetUsd,
    transmission,
    fuelEconomyPriority,
    historyPreference,
    bodyStyle,
    yearMin: years.yearMin,
    yearMax: years.yearMax,
    milesMax,
    zip,
    locationPhrase,
    // Only an explicit “within N miles” sets radius. ZIP alone → nationwide until Confirm.
    distanceMiles: radius,
    mustHaves,
    priorities,
  };
}
