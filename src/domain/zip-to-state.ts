/**
 * ZIP → state from the checked-in three-digit prefix table.
 * Unassigned, military, and territory prefixes stay unknown. No network lookup.
 */
import { ZIP_PREFIX_TO_STATE } from "./data/zip-prefix-state";

export const ZIP_PREFIX_SOURCE_URL = "https://en.wikipedia.org/wiki/List_of_ZIP_Code_prefixes";
export const ZIP_PREFIX_AS_OF = "2026-11-09";
export const ZIP_PREFIX_SOURCE_LABEL = "ZIP prefix to state";

/** Five-digit ZIP, or null when the text is not a ZIP. */
export function normalizeZip(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = raw.trim().match(/^(\d{5})(?:-?\d{4})?$/);
  return match?.[1] ?? null;
}

/**
 * State postal code, or null when the ZIP is missing, not a single state, or unassigned.
 * 96799 is American Samoa on the source list, not Hawaii.
 */
export function stateFromZip(raw: string | null | undefined): string | null {
  const zip = normalizeZip(raw);
  if (!zip) return null;
  if (zip === "96799") return null;
  return ZIP_PREFIX_TO_STATE[zip.slice(0, 3)] ?? null;
}
