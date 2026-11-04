import { isValidVin } from "./vin";

export function isListingUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

/** A VIN typed by itself has no asking price. A listing URL is a different path. */
export function isVinOnlyLookup(input: { url?: string; vin?: string }): boolean {
  const url = input.url?.trim() ?? "";
  if (url && isListingUrl(url)) return false;
  const candidate = (input.vin || url).trim();
  return isValidVin(candidate);
}

export function vinDetailGaps(input: { askingPriceUsd?: number; miles?: number; zip?: string }): string[] {
  const missing: string[] = [];
  if (typeof input.askingPriceUsd !== "number" || !Number.isFinite(input.askingPriceUsd) || input.askingPriceUsd <= 0) {
    missing.push("asking price");
  }
  if (typeof input.miles !== "number" || !Number.isFinite(input.miles) || input.miles < 0) missing.push("mileage");
  if (!input.zip || !/^\d{5}$/.test(input.zip.trim())) missing.push("ZIP");
  return missing;
}
