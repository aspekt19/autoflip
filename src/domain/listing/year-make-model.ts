/**
 * Shared year/make/model extraction from free-form titles, headings, and URL slugs.
 */

export type YearMakeModelHit = {
  year: number;
  make: string;
  model: string;
  trim: string | null;
};

const YMM_RE =
  /\b((?:19|20)\d{2})\s+([A-Za-z][A-Za-z0-9\-]+)\s+([A-Za-z0-9][A-Za-z0-9\-]+(?:\s+[A-Za-z0-9][A-Za-z0-9\-]*){0,3})/;

const SLUG_RE =
  /(?:^|\/|[-_])((?:19|20)\d{2})[-_]([A-Za-z][A-Za-z0-9]*)[-_]([A-Za-z0-9]+(?:[-_][A-Za-z0-9]+){0,4})(?:[-_][A-HJ-NPR-Z0-9]{11,17})?(?:\/|$|\?|#)/i;

export function yearMakeModelFromText(text: string | null | undefined): YearMakeModelHit | null {
  if (!text) return null;
  const cleaned = text.replace(/\s+/g, " ").trim();
  const match = cleaned.match(YMM_RE);
  if (!match) return null;
  const year = Number(match[1]);
  if (!Number.isFinite(year) || year < 1981) return null;
  const make = match[2]!;
  const bits = match[3]!.trim().split(/\s+/);
  const model = bits[0]!;
  const trim = bits.length > 1 ? bits.slice(1).join(" ") : null;
  // Skip page chrome like "2024 Auto Dealer Group"
  if (/^(auto|cars?|dealer|motors?|sales|inventory)$/i.test(model)) return null;
  return { year, make, model, trim };
}

export function yearMakeModelFromSlug(url: string | null | undefined): YearMakeModelHit | null {
  if (!url) return null;
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    /* use raw */
  }
  const match = path.match(SLUG_RE) ?? path.match(/((?:19|20)\d{2})[-_/]([A-Za-z]+)[-_/]([A-Za-z0-9]+)/);
  if (!match) return null;
  const year = Number(match[1]);
  if (!Number.isFinite(year) || year < 1981) return null;
  const make = match[2]!;
  if (/^(used|new|certified|vehicle|details?)$/i.test(make)) return null;
  // Keep hyphenated models (CR-V, CX-5, F-150). Do not glue trims like Camry-SE.
  const rawRest = match[3]!.replace(/_/g, "-");
  const segments = rawRest.split("-").filter(Boolean);
  let model: string;
  let trimParts: string[];
  const head = segments[0] ?? rawRest;
  const next = segments[1];
  const hyphenModel =
    Boolean(next) &&
    (/^[0-9]+$/.test(next!) || // CX-5, F-150
      (next!.length === 1 && /[A-Za-z]/.test(next!)) || // CR-V
      (head.length <= 3 && next!.length <= 3 && !/^(se|le|ex|lx|lt|sv|sl|s|base|awd|fwd|rwd|4wd)$/i.test(next!)));
  if (hyphenModel && next) {
    model = `${head}-${next}`;
    trimParts = segments.slice(2);
  } else {
    model = head;
    trimParts = segments.slice(1);
  }
  const trim = trimParts.length > 0 ? trimParts.join(" ") : null;
  return { year, make, model, trim };
}

export function joinSummarySentences(parts: readonly string[]): string {
  const cleaned = parts
    .map((part) => part.replace(/\s+/g, " ").trim().replace(/\.+$/, ""))
    .filter(Boolean);
  if (cleaned.length === 0) return "";
  return `${cleaned.join(". ")}.`;
}
