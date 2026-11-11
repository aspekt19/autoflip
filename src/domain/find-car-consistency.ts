/**
 * Free per-car consistency check.
 * Compares the listing with an already-decoded VIN (same vPIC lookup Find already runs)
 * and with feed fields the listing already parsed. No new paid source. No network here.
 *
 * Year / make / model mismatch → excluded from the pick.
 * Trim, drivetrain, or engine mismatch, rental/fleet use, or a reported accident
 * → condition penalty + a seller question.
 * Days listed is context only (0 points).
 */

import type { EvidenceFact, EvidenceState } from "./find-evidence-state";
import { listingAgeDays } from "./flip-rank";
import type { BestDealListing } from "./find-best-deal";
import type { FindFreeGovReceipt } from "./find-free-gov";
import { buyerListingHref } from "./find-listing-link";
import { redactUntrustedPromptText } from "./screen";

export const CAR_CONSISTENCY_CHECK_ID = "free_car_consistency" as const;

/** Points subtracted from the condition factor. Capped by the caller at the condition weight. */
export const CONSISTENCY_MISMATCH_PENALTY = 4;
export const CONSISTENCY_FLEET_PENALTY = 6;
export const CONSISTENCY_ACCIDENT_PENALTY = 6;

export type VpicSpecs = {
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  drivetrain: string | null;
  engine: string | null;
  fuel: string | null;
  /** NHTSA BodyClass. Absent on older decodes. */
  bodyClass?: string | null;
};

export type CarConsistencyReceipt = {
  key: string;
  vin: string | null;
  year: number;
  make: string;
  model: string;
  fields: EvidenceFact[];
  identityMismatch: boolean;
  excludedReason: string | null;
  /** Negative or zero. Days listed never contributes. */
  conditionPenalty: number;
  sellerQuestions: string[];
  daysListed: number | null;
  /** vPIC BodyClass for this VIN, when the decode published one. */
  bodyClass?: string | null;
};

const FLEET_RE = /fleet|rental|commercial|taxi|livery/i;

const MAKE_CANON: Record<string, string> = {
  chevy: "chevrolet",
  chevrolet: "chevrolet",
  vw: "volkswagen",
  volkswagen: "volkswagen",
  mercedes: "mercedesbenz",
  "mercedes benz": "mercedesbenz",
  mercedesbenz: "mercedesbenz",
};

/**
 * Drivetrain / body / powertrain words dealers paste into the trim field.
 * Not a trim-level difference. Shared by VIN comparison and listing-URL titles
 * so a slug-only "AWD" or "crew cab" cannot disagree with the card.
 */
const TRIM_NOISE = new Set([
  "awd",
  "4wd",
  "4x4",
  "fwd",
  "rwd",
  "2wd",
  "4x2",
  "quattro",
  "xdrive",
  "4matic",
  "sh",
  "all",
  "wheel",
  "wheels",
  "drive",
  "driven",
  "sedan",
  "coupe",
  "suv",
  "wagon",
  "hatchback",
  "hatch",
  "convertible",
  "utility",
  "crossover",
  "4dr",
  "2dr",
  "5dr",
  "3dr",
  "4d",
  "2d",
  "5d",
  "door",
  "doors",
  "dr",
  "crew",
  "cab",
  "pickup",
  "truck",
  "van",
  "minivan",
  "cargo",
  "passenger",
  "extended",
  "quad",
  "mega",
  "supercrew",
  "supercab",
  "super",
  "regular",
  "short",
  "long",
  "bed",
  "double",
  "king",
  "access",
  "duty",
  "heavy",
  "sdn",
  "conv",
  "v6",
  "v8",
  "v4",
  "i4",
  "i6",
  "h4",
  "h6",
  "cvt",
  "automatic",
  "manual",
  "hybrid",
  "phev",
  "diesel",
  "gas",
  "gasoline",
]);

function norm(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function compactName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function containsTokenSequence(haystack: string, needle: string): boolean {
  const hay = haystack.split(" ");
  const need = needle.split(" ");
  if (need.length === 0 || need.length > hay.length) return false;
  for (let i = 0; i <= hay.length - need.length; i += 1) {
    if (need.every((token, index) => hay[i + index] === token)) return true;
  }
  return false;
}

/**
 * Year/make/model match.
 * Punctuation-only differences (CR-V / CRV, F-150 / F150) match.
 * A missing side is unknown (null), never a mismatch.
 * Substring traps ("Accord" vs "Cord") do not match.
 */
export function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean | null {
  const left = norm(a);
  const right = norm(b);
  if (!left || !right) return null;
  if (left === right) return true;
  const leftCompact = compactName(left);
  const rightCompact = compactName(right);
  if (leftCompact && rightCompact && leftCompact === rightCompact) return true;
  if (containsTokenSequence(left, right) || containsTokenSequence(right, left)) return true;
  return false;
}

export function makesMatch(a: string | null | undefined, b: string | null | undefined): boolean | null {
  const left = norm(a);
  const right = norm(b);
  if (!left || !right) return null;
  const leftCanon = MAKE_CANON[left] ?? left;
  const rightCanon = MAKE_CANON[right] ?? right;
  if (leftCanon === rightCanon) return true;
  return namesMatch(leftCanon, rightCanon);
}

type DrivetrainBucket = "awd" | "fwd" | "rwd" | "two_wheel";

function drivetrainBucket(value: string | null | undefined): DrivetrainBucket | null {
  const n = norm(value);
  if (!n) return null;
  if (/\b(awd|4wd|4x4|all wheel|four wheel|4 wheel|quattro|xdrive|4matic|sh awd|all4)\b/.test(n)) return "awd";
  if (/\b(fwd|front wheel)\b/.test(n) || n === "front") return "fwd";
  if (/\b(rwd|rear wheel)\b/.test(n) || n === "rear") return "rwd";
  // 2WD / 4x2 is two driven wheels, but the axle (front vs rear) is not stated.
  if (/\b(2wd|4x2|two wheel|2 wheel)\b/.test(n)) return "two_wheel";
  return null;
}

/** True match, false confirmed mismatch, null when either side is missing or too vague to penalize. */
export function drivetrainsMatch(
  listing: string | null | undefined,
  decoded: string | null | undefined,
): boolean | null {
  const left = drivetrainBucket(listing);
  const right = drivetrainBucket(decoded);
  if (!left || !right) return null;
  if (left === right) return true;
  if (left === "two_wheel" && (right === "fwd" || right === "rwd")) return null;
  if (right === "two_wheel" && (left === "fwd" || left === "rwd")) return null;
  return false;
}

function fuelBucket(value: string | null | undefined): string | null {
  const n = norm(value);
  if (!n) return null;
  if (/electric|bev|ev\b/.test(n) && !/hybrid/.test(n)) return "electric";
  if (/diesel/.test(n)) return "diesel";
  if (/hybrid|phev/.test(n)) return "hybrid";
  if (/flex|e85|ethanol/.test(n)) return "flex";
  if (/gas|petrol|unleaded|regular|premium/.test(n)) return "gas";
  return null;
}

type EngineParts = { liters: number | null; cylinders: number | null };

function engineParts(value: string | null | undefined): EngineParts | null {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return null;
  let liters: number | null = null;
  const literMatch = raw.match(/(\d+(?:\.\d+)?)\s*[- ]?\s*(?:liters|liter|litres|litre|l)\b/);
  if (literMatch) liters = Number(literMatch[1]);
  else {
    const cc = raw.match(/(\d{3,4})\s*cc\b/);
    if (cc) liters = Math.round((Number(cc[1]) / 1000) * 10) / 10;
  }
  let cylinders: number | null = null;
  const cylMatch = raw.match(/\b(\d{1,2})\s*[- ]?\s*(?:cylinders|cylinder|cyl)\b/);
  if (cylMatch) cylinders = Number(cylMatch[1]);
  else if (/\bv[\s-]*8\b/.test(raw)) cylinders = 8;
  else if (/\bv[\s-]*6\b/.test(raw)) cylinders = 6;
  else if (/\b(?:v|i)[\s-]*4\b|\binline[\s-]*4\b/.test(raw)) cylinders = 4;
  if (liters == null && cylinders == null && !/electric/.test(raw)) return { liters: null, cylinders: null };
  return { liters, cylinders };
}

/**
 * Compare displacement and cylinder count only.
 * "2.4L" matches "2.4L 4 cyl". "2.0L" does not match "3.2L" (a shared digit is not a match).
 * Missing or unstructured text is unknown — not a penalty.
 */
export function enginesMatch(listing: string | null | undefined, decoded: string | null | undefined): boolean | null {
  const leftRaw = (listing ?? "").trim().toLowerCase();
  const rightRaw = (decoded ?? "").trim().toLowerCase();
  if (!leftRaw || !rightRaw) return null;
  if (/electric/.test(leftRaw) && /electric/.test(rightRaw)) return true;
  const left = engineParts(listing);
  const right = engineParts(decoded);
  if (!left || !right) return null;
  const litersKnown = left.liters != null && right.liters != null;
  const cylindersKnown = left.cylinders != null && right.cylinders != null;
  if (!litersKnown && !cylindersKnown) return null;
  if (litersKnown && Math.abs(left.liters! - right.liters!) > 0.05) return false;
  if (cylindersKnown && left.cylinders !== right.cylinders) return false;
  return true;
}

function trimTokens(value: string | null | undefined): string[] | null {
  const n = norm(value);
  if (!n) return null;
  const tokens = n.split(" ").filter((token) => token && !TRIM_NOISE.has(token));
  return tokens.length > 0 ? tokens : null;
}

/**
 * Trim match. Hyphen/spacing variants match (EX-L, EX L, EXL).
 * Drivetrain words inside the trim do not count.
 * "LX" does not match "EX-L". A missing side is unknown.
 */
export function trimsMatch(listing: string | null | undefined, decoded: string | null | undefined): boolean | null {
  const left = trimTokens(listing);
  const right = trimTokens(decoded);
  if (!left || !right) return null;
  const compact = (tokens: string[]) => tokens.join("");
  if (compact(left) === compact(right)) return true;
  const rightSet = new Set(right);
  if (left.every((token) => rightSet.has(token))) return true;
  if (left.length === 1 && left[0] === compact(right)) return true;
  if (right.length === 1 && right[0] === compact(left)) return true;
  return false;
}

const URL_TRIM_NOISE = new Set([
  ...TRIM_NOISE,
  "used",
  "new",
  "certified",
  "pre",
  "owned",
  "preowned",
  "cpo",
  "for",
  "sale",
  "the",
  "and",
  "at",
  "near",
  "with",
  "w",
  "car",
  "cars",
  "vehicle",
  "vehicles",
  "inventory",
  "vdp",
  "listing",
  "listings",
  "detail",
  "details",
  "view",
  "auto",
  "autos",
  "html",
  "htm",
  "aspx",
  "php",
  "jsp",
  "sportutility",
]);

const STATE_CODES = new Set([
  "al", "ak", "az", "ar", "ca", "co", "ct", "dc", "de", "fl", "ga", "hi", "ia", "id", "il", "in",
  "ks", "ky", "la", "ma", "md", "me", "mi", "mn", "mo", "ms", "mt", "nc", "nd", "ne", "nh", "nj",
  "nm", "nv", "ny", "oh", "ok", "or", "pa", "ri", "sc", "sd", "tn", "tx", "ut", "va", "vt", "wa",
  "wi", "wv", "wy",
]);

function showTrimToken(token: string): string {
  if (token.length <= 3) return token.toUpperCase();
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/**
 * Stock numbers, hashes, and UUID pieces are not trim names.
 * A token counts when it is hex (or all digits) and long enough to be an id.
 * Letter-only trim words (EX, LX, TRD, XSE) stay.
 */
export function isOpaqueListingIdToken(token: string): boolean {
  if (!token) return true;
  if (/^\d+$/.test(token)) return true;
  if (/^[0-9a-f]{8,}$/i.test(token)) return true;
  return /^[0-9a-f]+$/i.test(token) && /\d/.test(token) && /[a-f]/i.test(token) && token.length >= 4;
}

/** Trim words a dealer title can actually name. Anything else in a slug is not a trim. */
const KNOWN_TRIM_WORDS = new Set([
  "sport",
  "touring",
  "trd",
  "xse",
  "xle",
  "limited",
  "ex",
  "lx",
  "se",
  "sel",
  "eco",
  "sx",
  "sxl",
  "xlt",
  "le",
  "gt",
  "platinum",
  "lariat",
  "premium",
  "base",
  "hybrid",
  "nightshade",
  "adventure",
  "signature",
  "preferred",
  "carbon",
  "ultimate",
  "convenience",
  "essential",
  "sv",
  "sl",
  "sr",
  "xl",
  "raptor",
  "denali",
  "latitude",
  "altitude",
  "rubicon",
  "sahara",
  "trailhawk",
  "overland",
  "summit",
  "rebel",
  "calligraphy",
  "prestige",
  "titanium",
  "sxt",
  "st",
  "si",
]);

const KNOWN_TRIM_PHRASES: string[][] = [
  ["grand", "touring"],
  ["king", "ranch"],
  ["sport", "touring"],
  ["n", "line"],
  ["ex", "l"],
  ["sx", "turbo"],
];

/** Words such as "king" are cab noise alone, but they still count inside a known trim phrase. */
const KNOWN_TRIM_PHRASE_TOKENS = new Set(KNOWN_TRIM_PHRASES.flat());

function knownTrimPhrase(tokens: string[]): string | null {
  const kept: string[] = [];
  let index = 0;
  while (index < tokens.length) {
    const phrase = KNOWN_TRIM_PHRASES.find((parts) =>
      parts.every((part, offset) => tokens[index + offset] === part),
    );
    if (phrase) {
      kept.push(...phrase);
      index += phrase.length;
      continue;
    }
    const token = tokens[index]!;
    if (KNOWN_TRIM_WORDS.has(token)) kept.push(token);
    index += 1;
  }
  if (kept.length === 0) return null;
  return kept.map(showTrimToken).join(" ");
}

/** Drop a contiguous token run whose letters equal the compact model name (rav+4, cr+v, f+150). */
function dropCompactSpans(tokens: string[], compactTarget: string): string[] {
  if (!compactTarget) return tokens;
  const out: string[] = [];
  let index = 0;
  while (index < tokens.length) {
    let built = "";
    let matched = 0;
    for (let end = index; end < tokens.length; end += 1) {
      built += tokens[end];
      if (built === compactTarget) {
        matched = end - index + 1;
        break;
      }
      if (!compactTarget.startsWith(built)) break;
    }
    if (matched > 0) {
      index += matched;
      continue;
    }
    out.push(tokens[index]!);
    index += 1;
  }
  return out;
}

/**
 * Trim words in a dealer listing URL title.
 * Card trim often comes from the listing feed's vehicle description (a VIN decode).
 * The dealer page title is a separate source and is not used to rename the card.
 */
function trimTokensFromTitleText(
  text: string,
  car: { year?: number | null; make?: string | null; model?: string | null },
): string | null {
  const modelCompact = compactName(car.model ?? "");
  let head = text.replace(/[-_]+/g, " ");
  head = head.replace(/\bsport\s+utility\b/gi, " ");
  head = head.split(/\bfor sale\b/i)[0] ?? head;
  const inParts = head.split(/\bin\b/i);
  if (inParts.length > 1) {
    const left = inParts[0] ?? "";
    if (/\b(19|20)\d{2}\b/.test(left) || (modelCompact && compactName(left).includes(modelCompact))) {
      head = left;
    }
  }
  const makeTokens = new Set(norm(car.make).split(" ").filter(Boolean));
  const kept = norm(head)
    .split(" ")
    .filter((token) => {
      if (!token || (URL_TRIM_NOISE.has(token) && !KNOWN_TRIM_PHRASE_TOKENS.has(token))) return false;
      if (makeTokens.has(token)) return false;
      if (/^(19|20)\d{2}$/.test(token) || /^\d{5}$/.test(token)) return false;
      if (/^\d+l$/.test(token) || /^\d+t$/.test(token)) return false;
      if (/^[a-z]\d{3,}$/.test(token) || /^\d{3,}[a-z]$/.test(token)) return false;
      if (/^[a-hj-npr-z0-9]{11,17}$/i.test(token)) return false;
      if (isOpaqueListingIdToken(token)) return false;
      if (STATE_CODES.has(token)) return false;
      return true;
    });
  const tokens = dropCompactSpans(kept, modelCompact).filter((token) => !isOpaqueListingIdToken(token));
  return knownTrimPhrase(tokens);
}

/**
 * Trim words in a dealer listing URL, or in a separate listing title when the
 * path is only an id. Opaque ids are never returned.
 */
export function trimPhraseFromListingUrl(
  url: string | null | undefined,
  car: { year?: number | null; make?: string | null; model?: string | null },
  listingTitle?: string | null,
): string | null {
  const fromTitle = listingTitle ? trimTokensFromTitleText(listingTitle, car) : null;
  const href = buyerListingHref(url);
  if (!href) return fromTitle;
  let pathname = "";
  try {
    pathname = decodeURIComponent(new URL(href).pathname);
  } catch {
    return fromTitle;
  }
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return fromTitle;
  const modelCompact = compactName(car.model ?? "");
  const yearText = car.year != null ? String(car.year) : "";
  const readable = segments.filter((segment) => !segment.split(/[-_]+/).every((part) => isOpaqueListingIdToken(norm(part).replace(/\s/g, "")) || isOpaqueListingIdToken(part.toLowerCase())));
  let slug = readable[readable.length - 1] ?? "";
  for (const segment of readable) {
    const compact = compactName(segment);
    if ((modelCompact && compact.includes(modelCompact)) || (yearText && segment.includes(yearText))) {
      slug = segment;
    }
  }
  const fromSlug = slug ? trimTokensFromTitleText(slug, car) : null;
  return fromSlug ?? fromTitle;
}

export type TrimSourceDisagreement = {
  displayedTrim: string;
  listingTitleTrim: string;
  decodedTrim: string | null;
  /** Buyer sentence naming each source. Does not rename the card. */
  note: string;
  sellerQuestion: string;
};

/**
 * When the dealer link title and the trim we show disagree, say which source said what.
 * The card title stays the listing-data trim — this does not relabel it.
 */
export function trimSourceDisagreement(input: {
  year: number;
  make: string;
  model: string;
  displayedTrim: string | null | undefined;
  listingUrl: string | null | undefined;
  decodedTrim?: string | null;
  /** Human listing title, used when the URL path is only an id. */
  listingTitle?: string | null;
}): TrimSourceDisagreement | null {
  const displayed = (input.displayedTrim ?? "").replace(/\s+/g, " ").trim();
  if (!displayed) return null;
  const listingTitleTrim = trimPhraseFromListingUrl(input.listingUrl, input, input.listingTitle);
  if (!listingTitleTrim) return null;
  if (trimsMatch(displayed, listingTitleTrim) !== false) return null;
  const title = `${input.year} ${input.make} ${input.model}`;
  const decoded = (input.decodedTrim ?? "").replace(/\s+/g, " ").trim();
  const sentences = [
    `Trim names disagree on this ${title}.`,
    `Listing data on this card says ${displayed}.`,
    `The dealer listing link title says ${listingTitleTrim}.`,
  ];
  if (decoded && trimsMatch(decoded, displayed) === true) {
    sentences.push(`Government vehicle specs also say ${decoded}.`);
  } else if (decoded && trimsMatch(decoded, displayed) === false) {
    sentences.push(`Government vehicle specs say ${decoded}.`);
  }
  return {
    displayedTrim: displayed,
    listingTitleTrim,
    decodedTrim: decoded || null,
    note: sentences.join(" ").replace(/\.{2,}/g, "."),
    sellerQuestion: `Ask the seller to confirm the trim on the ${title} — the dealer listing link says ${listingTitleTrim}, and the listing data on this card says ${displayed}.`,
  };
}

function field(
  name: string,
  state: EvidenceState,
  source: EvidenceFact["source"],
  plain: string,
): EvidenceFact {
  return { field: name, state, source, plain };
}

export function vpicSpecsFromReceipt(receipt: FindFreeGovReceipt): VpicSpecs | null {
  const specs = receipt.vpicSpecs;
  if (!specs) return null;
  if (receipt.status !== "ok") return null;
  return specs;
}

export function bestDealCarKey(row: {
  vin?: string | null;
  year: number;
  make: string;
  model: string;
  priceUsd?: number | null;
  miles?: number | null;
}): string {
  const vin = typeof row.vin === "string" && row.vin.trim() ? row.vin.trim().toUpperCase() : "";
  if (vin && !vin.startsWith("UNKNOWN-")) return vin;
  return `${row.year}|${row.make}|${row.model}|${row.priceUsd ?? ""}|${row.miles ?? ""}`.toLowerCase();
}

function titleOf(row: { year: number; make: string; model: string }): string {
  return `${row.year} ${row.make} ${row.model}`;
}

export function buildCarConsistencyReceipt(
  row: BestDealListing,
  specs: VpicSpecs | null,
  now: Date = new Date(),
): CarConsistencyReceipt {
  const key = bestDealCarKey(row);
  const title = titleOf(row);
  const fields: EvidenceFact[] = [];
  const sellerQuestions: string[] = [];
  let penalty = 0;

  const compareName = (
    name: "year" | "make" | "model",
    listingValue: string,
    decoded: string | null,
    label: string,
  ) => {
    if (!specs) {
      fields.push(
        field(name, "not_checked", "government", `${title}: ${label} has not been compared with a VIN decode yet.`),
      );
      return;
    }
    if (!decoded) {
      fields.push(
        field(name, "could_not_check", "government", `${title}: Couldn't confirm ${label} from the VIN decode.`),
      );
      return;
    }
    const listingCompare = name === "year" ? String(row.year) : listingValue;
    const matched =
      name === "year"
        ? String(row.year) === String(decoded)
        : name === "make"
          ? makesMatch(listingCompare, decoded)
          : namesMatch(listingCompare, decoded);
    if (matched === true) {
      fields.push(
        field(name, "none_found", "government", `${title}: VIN ${label} matches the listing (${decoded}).`),
      );
    } else if (matched === false) {
      fields.push(
        field(
          name,
          "issue_found",
          "government",
          `${title}: VIN ${label} is ${decoded}, but the listing says ${listingCompare}.`,
        ),
      );
    } else {
      fields.push(field(name, "could_not_check", "government", `${title}: Couldn't confirm ${label} from the VIN decode.`));
    }
  };

  compareName("year", String(row.year), specs?.year != null ? String(specs.year) : null, "year");
  compareName("make", row.make, specs?.make ?? null, "make");
  compareName("model", row.model, specs?.model ?? null, "model");

  const identityMismatch = fields.some(
    (f) => (f.field === "year" || f.field === "make" || f.field === "model") && f.state === "issue_found",
  );
  const excludedReason = identityMismatch
    ? `${title} is left out of the pick because the VIN year, make, or model does not match the listing.`
    : null;

  const trimState = trimsMatch(row.trim, specs?.trim ?? null);
  if (!specs) {
    fields.push(field("trim", "not_checked", "government", `${title}: Trim has not been compared with a VIN decode yet.`));
  } else if (trimState == null) {
    fields.push(field("trim", "could_not_check", "government", `${title}: Couldn't confirm trim from the VIN decode.`));
  } else if (trimState) {
    fields.push(field("trim", "none_found", "government", `${title}: VIN trim matches the listing.`));
  } else {
    fields.push(
      field(
        "trim",
        "issue_found",
        "government",
        `${title}: Listing trim does not match the VIN${row.trim ? ` (listing says ${redactUntrustedPromptText(row.trim, 40)})` : ""}.`,
      ),
    );
    penalty += CONSISTENCY_MISMATCH_PENALTY;
    sellerQuestions.push(`Ask the seller to confirm the trim on the ${title} — the listing trim does not match the VIN.`);
  }

  const driveState = specs ? drivetrainsMatch(row.drivetrain, specs.drivetrain) : null;
  if (!specs) {
    fields.push(
      field("drivetrain", "not_checked", "government", `${title}: Drivetrain has not been compared with a VIN decode yet.`),
    );
  } else if (driveState == null) {
    fields.push(
      field("drivetrain", "could_not_check", "government", `${title}: Couldn't confirm drivetrain from the VIN decode.`),
    );
  } else if (driveState) {
    fields.push(field("drivetrain", "none_found", "government", `${title}: VIN drivetrain matches the listing.`));
  } else {
    fields.push(
      field("drivetrain", "issue_found", "government", `${title}: Listing drivetrain does not match the VIN.`),
    );
    penalty += CONSISTENCY_MISMATCH_PENALTY;
    sellerQuestions.push(`Ask the seller to confirm drivetrain on the ${title} — it does not match the VIN.`);
  }

  const engineState = specs ? enginesMatch(row.engine, specs.engine) : null;
  if (!specs) {
    fields.push(field("engine", "not_checked", "government", `${title}: Engine has not been compared with a VIN decode yet.`));
  } else if (engineState == null) {
    fields.push(field("engine", "could_not_check", "government", `${title}: Couldn't confirm the engine from the VIN decode.`));
  } else if (engineState) {
    fields.push(field("engine", "none_found", "government", `${title}: VIN engine matches the listing.`));
  } else {
    fields.push(field("engine", "issue_found", "government", `${title}: Listing engine does not match the VIN.`));
    penalty += CONSISTENCY_MISMATCH_PENALTY;
    sellerQuestions.push(`Ask the seller to confirm the engine on the ${title} — it does not match the VIN.`);
  }

  const fuelListing = fuelBucket(row.fuel);
  const fuelDecoded = fuelBucket(specs?.fuel ?? null);
  if (!specs) {
    fields.push(field("fuel", "not_checked", "government", `${title}: Fuel type has not been compared with a VIN decode yet.`));
  } else if (!fuelListing || !fuelDecoded) {
    fields.push(field("fuel", "could_not_check", "government", `${title}: Couldn't confirm fuel type from the VIN decode.`));
  } else if (fuelListing === fuelDecoded) {
    fields.push(field("fuel", "none_found", "government", `${title}: VIN fuel type matches the listing.`));
  } else {
    fields.push(
      field("fuel", "issue_found", "government", `${title}: Listing fuel type does not match the VIN.`),
    );
    sellerQuestions.push(`Ask the seller to confirm the fuel type on the ${title} — it does not match the VIN.`);
  }

  if (row.accidentCount == null) {
    fields.push(
      field(
        "accidents",
        "not_checked",
        "listing_says",
        `${title}: Listing does not say whether accidents were reported.`,
      ),
    );
  } else if (row.accidentCount > 0) {
    fields.push(
      field(
        "accidents",
        "issue_found",
        "listing_says",
        `${title}: Listing says ${row.accidentCount} accident${row.accidentCount === 1 ? "" : "s"} reported.`,
      ),
    );
    penalty += CONSISTENCY_ACCIDENT_PENALTY;
    sellerQuestions.push(
      `Ask the seller for accident records on the ${title} — the listing says accidents were reported.`,
    );
  } else {
    fields.push(
      field(
        "accidents",
        "none_found",
        "listing_says",
        `${title}: Listing says no accidents were reported (seller claim, not a history report).`,
      ),
    );
  }

  if (row.ownerCount == null && row.oneOwner == null) {
    fields.push(
      field("owners", "not_checked", "listing_says", `${title}: Listing does not say how many owners.`),
    );
  } else if (row.oneOwner === true || row.ownerCount === 1) {
    fields.push(field("owners", "none_found", "listing_says", `${title}: Listing says one owner.`));
  } else if (typeof row.ownerCount === "number") {
    fields.push(
      field("owners", "none_found", "listing_says", `${title}: Listing says ${row.ownerCount} owners.`),
    );
  } else {
    fields.push(field("owners", "could_not_check", "listing_says", `${title}: Couldn't confirm owner count from the listing.`));
  }

  const usage = row.usageType ?? null;
  if (!usage) {
    fields.push(
      field("usage", "not_checked", "listing_says", `${title}: Listing does not say whether this was a rental or fleet car.`),
    );
  } else if (FLEET_RE.test(usage)) {
    const fleetWord = usage.match(FLEET_RE)?.[0] ?? "rental or fleet";
    fields.push(
      field("usage", "issue_found", "listing_says", `${title}: Listing says rental or fleet use (${fleetWord}).`),
    );
    penalty += CONSISTENCY_FLEET_PENALTY;
    sellerQuestions.push(`Ask the seller about rental or fleet use on the ${title} — the listing says so.`);
  } else {
    fields.push(field("usage", "none_found", "listing_says", `${title}: Listing says use was “${usage}”.`));
  }

  const days = listingAgeDays(
    {
      vin: row.vin ?? "UNKNOWN",
      year: row.year,
      make: row.make,
      model: row.model,
      trim: row.trim ?? null,
      miles: row.miles ?? null,
      priceUsd: row.priceUsd ?? null,
      city: null,
      state: null,
      zip: null,
      dealer: null,
      vdp: null,
      primaryImage: null,
      carfaxUrl: null,
      used: true,
      cpo: row.cpo ?? null,
      accidentCount: row.accidentCount ?? null,
      oneOwner: row.oneOwner ?? null,
      ownerCount: row.ownerCount ?? null,
      usageType: row.usageType ?? null,
      fuel: row.fuel ?? null,
      engine: row.engine ?? null,
      drivetrain: row.drivetrain ?? null,
      bodyStyle: null,
      latitude: null,
      longitude: null,
      removedAt: null,
      createdAt: row.createdAt ?? null,
      source: "autodev",
    },
    now,
  );
  fields.push(
    field(
      "days_listed",
      days == null ? "could_not_check" : "none_found",
      "listing_says",
      days == null
        ? `${title}: Listing does not say how many days it has been listed.`
        : `${title}: Listing says about ${days} day${days === 1 ? "" : "s"} on the market (context only).`,
    ),
  );

  return {
    key,
    vin: typeof row.vin === "string" ? row.vin : null,
    year: row.year,
    make: row.make,
    model: row.model,
    fields,
    identityMismatch,
    excludedReason,
    conditionPenalty: penalty,
    sellerQuestions,
    daysListed: days,
    bodyClass: specs?.bodyClass?.trim() || null,
  };
}

export function vpicByVinFromReceipts(receipts: readonly FindFreeGovReceipt[]): Map<string, VpicSpecs> {
  const map = new Map<string, VpicSpecs>();
  for (const receipt of receipts) {
    if (receipt.checkId !== "free_gov_vpic" || !receipt.vin) continue;
    const specs = vpicSpecsFromReceipt(receipt);
    if (!specs) continue;
    map.set(receipt.vin.trim().toUpperCase(), specs);
  }
  return map;
}

/**
 * When the listing omitted drivetrain, copy it from a free-gov vPIC decode.
 * Does not overwrite a listing value. Cars without a decode stay as-is (not dropped).
 */
export function fillDrivetrainFromVpic<T extends { vin?: string | null; drivetrain?: string | null }>(
  listings: readonly T[],
  receipts: readonly FindFreeGovReceipt[],
): T[] {
  const vpic = vpicByVinFromReceipts(receipts);
  if (vpic.size === 0) return [...listings];
  return listings.map((row) => {
    if (typeof row.drivetrain === "string" && row.drivetrain.trim()) return row;
    const vin = typeof row.vin === "string" ? row.vin.trim().toUpperCase() : "";
    if (!vin) return row;
    const decoded = vpic.get(vin)?.drivetrain?.trim();
    if (!decoded) return row;
    return { ...row, drivetrain: decoded };
  });
}

/** True when the value is AWD / 4WD (or a known all-wheel brand alias). */
export function isAwdDrivetrain(value: string | null | undefined): boolean {
  return drivetrainBucket(value) === "awd";
}

/** Run the free consistency check on target cars only. No network. */
export function executeCarConsistency(input: {
  listings: readonly BestDealListing[];
  targetKeys: readonly string[];
  vpicReceipts?: readonly FindFreeGovReceipt[];
  now?: Date;
}): CarConsistencyReceipt[] {
  const wanted = new Set(input.targetKeys);
  const vpic = vpicByVinFromReceipts(input.vpicReceipts ?? []);
  const out: CarConsistencyReceipt[] = [];
  for (const row of input.listings) {
    const key = bestDealCarKey(row);
    if (!wanted.has(key)) continue;
    const vin = typeof row.vin === "string" ? row.vin.trim().toUpperCase() : "";
    out.push(buildCarConsistencyReceipt(row, vin ? vpic.get(vin) ?? null : null, input.now));
  }
  return out;
}

export function mergeCarConsistency(
  prior: readonly CarConsistencyReceipt[],
  next: readonly CarConsistencyReceipt[],
): CarConsistencyReceipt[] {
  const map = new Map<string, CarConsistencyReceipt>();
  for (const row of prior) map.set(row.key, row);
  for (const row of next) map.set(row.key, row);
  return [...map.values()];
}
