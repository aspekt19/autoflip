import type { Listing } from "./types";

/** SUV matches "SUV", "Sport Utility", and "4D Sport Utility". An unknown body is not a reject. */
export function bodyStyleMatches(wanted: string | undefined, listing: Pick<Listing, "bodyStyle"> & { style?: string | null }): boolean {
  if (!wanted?.trim()) return true;
  const family = bodyFamily(wanted);
  const observed = [listing.bodyStyle, listing.style].map(bodyFamily).filter((item): item is string => Boolean(item));
  if (!family) {
    const needle = wanted.trim().toLowerCase();
    return [listing.bodyStyle, listing.style].some((item) => item?.trim().toLowerCase() === needle);
  }
  if (observed.length === 0) return true;
  return observed.includes(family);
}

function bodyFamily(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = value.toLowerCase();
  if (/suv|sport utility|crossover|\bcuv\b/.test(text)) return "suv";
  if (/pickup|\btruck\b/.test(text)) return "truck";
  if (/\bvan\b|minivan/.test(text)) return "van";
  if (/sedan|coupe|hatchback|convertible|\bcar\b/.test(text)) return "car";
  return null;
}
