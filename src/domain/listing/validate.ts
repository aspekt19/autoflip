/**
 * Deterministic validation for listing extraction.
 * VIN checksum + numeric ranges. Invalid values become unknown.
 */
import { isValidVin } from "@/domain/vin";
import { isPlausibleSellerName } from "./schema-org";
import type { ExtractedListingFields, ListingFieldSource, Provenanced } from "./types";
import { emptyExtractedFields } from "./types";

const CURRENT_YEAR = () => new Date().getUTCFullYear();

export function validateVinCandidate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, "");
  if (cleaned.length !== 17) return null;
  return isValidVin(cleaned) ? cleaned : null;
}

export function validateYear(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.replace(/[^\d]/g, "")) : NaN;
  if (!Number.isInteger(n)) return null;
  const max = CURRENT_YEAR() + 1;
  if (n < 1981 || n > max) return null;
  return n;
}

export function validatePriceUsd(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const n = Math.round(raw);
    return n >= 500 && n <= 500_000 ? n : null;
  }
  if (typeof raw === "string") {
    const cleaned = raw.replace(/[^0-9.]/g, "");
    if (!cleaned) return null;
    const n = Math.round(Number(cleaned));
    return Number.isFinite(n) && n >= 500 && n <= 500_000 ? n : null;
  }
  return null;
}

export function validateMiles(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const n = Math.round(raw);
    return n >= 0 && n <= 800_000 ? n : null;
  }
  if (typeof raw === "string") {
    const cleaned = raw.replace(/[^0-9]/g, "");
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) && n >= 0 && n <= 800_000 ? n : null;
  }
  return null;
}

export function validateZip(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length < 5) return null;
  return digits.slice(0, 5);
}

export function validatePhotoCount(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.replace(/\D/g, "")) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > 500) return null;
  return n;
}

export function validateShortText(raw: unknown, max = 120): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned.length > max) return cleaned ? cleaned.slice(0, max) : null;
  return cleaned;
}

export function validateDescription(raw: unknown, max = 4000): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, max);
}

export function validateFeatureList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) {
    if (typeof raw === "string" && raw.trim()) {
      const parts = raw
        .split(/[,;|]/)
        .map((part) => part.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .slice(0, 40);
      return parts.length ? parts : null;
    }
    return null;
  }
  const parts = raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 40);
  return parts.length ? parts : null;
}

function setIfEmpty<T>(
  field: Provenanced<T>,
  value: T | null,
  source: ListingFieldSource,
): Provenanced<T> {
  if (field.value != null) return field;
  if (value == null) return field;
  return { value, source };
}

/** Merge a partial layer onto an extracted bag. Earlier non-null values win. */
export function mergeLayer(
  base: ExtractedListingFields,
  partial: Partial<Record<keyof ExtractedListingFields, unknown>>,
  source: ListingFieldSource,
): ExtractedListingFields {
  const next: ExtractedListingFields = { ...base };
  next.priceUsd = setIfEmpty(next.priceUsd, validatePriceUsd(partial.priceUsd), source);
  next.year = setIfEmpty(next.year, validateYear(partial.year), source);
  next.make = setIfEmpty(next.make, validateShortText(partial.make, 40), source);
  next.model = setIfEmpty(next.model, validateShortText(partial.model, 60), source);
  next.trim = setIfEmpty(next.trim, validateShortText(partial.trim, 60), source);
  next.miles = setIfEmpty(next.miles, validateMiles(partial.miles), source);
  next.vin = setIfEmpty(next.vin, validateVinCandidate(partial.vin), source);
  next.transmission = setIfEmpty(next.transmission, validateShortText(partial.transmission, 40), source);
  next.drivetrain = setIfEmpty(next.drivetrain, validateShortText(partial.drivetrain, 40), source);
  next.fuel = setIfEmpty(next.fuel, validateShortText(partial.fuel, 40), source);
  next.color = setIfEmpty(next.color, validateShortText(partial.color, 40), source);
  next.location = setIfEmpty(next.location, validateShortText(partial.location, 80), source);
  next.zip = setIfEmpty(next.zip, validateZip(partial.zip), source);
  next.state = setIfEmpty(next.state, validateShortText(partial.state, 2)?.toUpperCase() ?? null, source);
  next.sellerName = setIfEmpty(
    next.sellerName,
    (() => {
      const candidate = validateShortText(partial.sellerName, 80);
      return candidate && isPlausibleSellerName(candidate) ? candidate : null;
    })(),
    source,
  );
  next.listingDate = setIfEmpty(next.listingDate, validateShortText(partial.listingDate, 40), source);
  next.description = setIfEmpty(next.description, validateDescription(partial.description), source);
  next.photoCount = setIfEmpty(next.photoCount, validatePhotoCount(partial.photoCount), source);
  next.accidentsStated = setIfEmpty(next.accidentsStated, validateShortText(partial.accidentsStated, 80), source);
  next.ownersStated = setIfEmpty(next.ownersStated, validateShortText(partial.ownersStated, 80), source);
  next.titleStatus = setIfEmpty(next.titleStatus, validateShortText(partial.titleStatus, 80), source);
  next.features = setIfEmpty(next.features, validateFeatureList(partial.features), source);
  return next;
}

/** Apply LLM JSON only into still-unknown fields; validate every value. */
export function mergeLlmExtraction(
  base: ExtractedListingFields,
  raw: Record<string, unknown> | null,
): ExtractedListingFields {
  if (!raw) return base;
  return mergeLayer(base, raw as Partial<Record<keyof ExtractedListingFields, unknown>>, "llm");
}

function normalizeHaystack(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whole digit tokens from page text after collapsing thousand separators
 * ($23,990 → 23990). Used so price/mileage never match on a digit substring
 * (990 inside 23,990).
 */
export function wholeNumberTokensInPage(pageText: string): Set<string> {
  let collapsed = normalizeHaystack(pageText).replace(/\$/g, " ");
  // Collapse US-style thousand groups repeatedly: 1,234,567 → 1234567
  for (let i = 0; i < 4; i += 1) {
    const next = collapsed.replace(/(\d),(\d{3})(?!\d)/g, "$1$2");
    if (next === collapsed) break;
    collapsed = next;
  }
  return new Set(collapsed.match(/\d+/g) ?? []);
}

/** True when a candidate appears as a whole token in the page/URL text (never a substring). */
export function valueAppearsInPage(value: string | number, pageText: string): boolean {
  const hay = normalizeHaystack(pageText);
  if (!hay.trim()) return false;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return false;
    const raw = String(Math.round(value));
    return wholeNumberTokensInPage(hay).has(raw);
  }
  const needle = value.toLowerCase().trim();
  if (!needle) return false;
  // Word-boundary match — "in" / "red" must not match inside "indiana" / "preferred".
  const bounded = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(needle)}(?:[^a-z0-9]|$)`, "i");
  if (bounded.test(hay)) return true;
  // Compact form for multi-character tokens like AWD (not for short words).
  const compactNeedle = needle.replace(/[^a-z0-9]/g, "");
  if (compactNeedle.length >= 3 && compactNeedle !== needle.replace(/\s+/g, "")) {
    const compactHay = hay.replace(/[^a-z0-9]/g, "");
    // Compact hay has no separators — require the compact needle as a whole run
    // by checking adjacent non-matches via length scan on tokenized alnum runs.
    const runs = compactHay.match(/[a-z0-9]+/g) ?? [compactHay];
    if (runs.some((run) => run === compactNeedle)) return true;
  } else if (compactNeedle.length >= 3) {
    // Needle was already alnum (e.g. "awd") — still require a whole compact run.
    const compactHay = hay.replace(/[^a-z0-9]+/g, " ");
    if (new RegExp(`(?:^|\\s)${escapeRegExp(compactNeedle)}(?:\\s|$)`).test(compactHay)) return true;
  }
  return false;
}

/**
 * Drop LLM-sourced fields that are not grounded in the page or URL text.
 * Deterministic sources are left alone. Unknown stays unknown — never invent.
 */
export function groundLlmFieldsInPage(
  fields: ExtractedListingFields,
  pageText: string,
): ExtractedListingFields {
  const hay = `${pageText}`;

  const keepScalar = <T extends string | number>(
    field: Provenanced<T>,
  ): Provenanced<T> => {
    if (field.source !== "llm" || field.value == null) return field;
    return valueAppearsInPage(field.value, hay) ? field : { value: null, source: null };
  };

  const features =
    fields.features.source === "llm" && fields.features.value
      ? (() => {
          const kept = fields.features.value.filter((item) => valueAppearsInPage(item, hay));
          return kept.length
            ? ({ value: kept, source: "llm" } as Provenanced<string[]>)
            : ({ value: null, source: null } as Provenanced<string[]>);
        })()
      : fields.features;

  return {
    priceUsd: keepScalar(fields.priceUsd),
    year: keepScalar(fields.year),
    make: keepScalar(fields.make),
    model: keepScalar(fields.model),
    trim: keepScalar(fields.trim),
    miles: keepScalar(fields.miles),
    vin: keepScalar(fields.vin),
    transmission: keepScalar(fields.transmission),
    drivetrain: keepScalar(fields.drivetrain),
    fuel: keepScalar(fields.fuel),
    color: keepScalar(fields.color),
    location: keepScalar(fields.location),
    zip: keepScalar(fields.zip),
    state: keepScalar(fields.state),
    sellerName: keepScalar(fields.sellerName),
    listingDate: keepScalar(fields.listingDate),
    description: keepScalar(fields.description),
    photoCount: keepScalar(fields.photoCount),
    accidentsStated: keepScalar(fields.accidentsStated),
    ownersStated: keepScalar(fields.ownersStated),
    titleStatus: keepScalar(fields.titleStatus),
    features,
  };
}

export function cloneExtracted(fields: ExtractedListingFields): ExtractedListingFields {
  return mergeLayer(emptyExtractedFields(), {
    priceUsd: fields.priceUsd.value,
    year: fields.year.value,
    make: fields.make.value,
    model: fields.model.value,
    trim: fields.trim.value,
    miles: fields.miles.value,
    vin: fields.vin.value,
    transmission: fields.transmission.value,
    drivetrain: fields.drivetrain.value,
    fuel: fields.fuel.value,
    color: fields.color.value,
    location: fields.location.value,
    zip: fields.zip.value,
    state: fields.state.value,
    sellerName: fields.sellerName.value,
    listingDate: fields.listingDate.value,
    description: fields.description.value,
    photoCount: fields.photoCount.value,
    accidentsStated: fields.accidentsStated.value,
    ownersStated: fields.ownersStated.value,
    titleStatus: fields.titleStatus.value,
    features: fields.features.value,
  }, fields.priceUsd.source ?? "visible_text");
}
