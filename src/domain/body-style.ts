import type { Listing } from "./types";

/** SUV matches "SUV", "Sport Utility", and "4D Sport Utility". An unknown body is not a reject. */
export function bodyStyleMatches(wanted: string | undefined, listing: Pick<Listing, "bodyStyle"> & { style?: string | null }): boolean {
  if (!wanted?.trim()) return true;
  const family = bodyFamily(wanted);
  const observed = [listing.bodyStyle, listing.style]
    .map(bodyFamily)
    .filter((item): item is "suv" | "truck" | "van" | "car" => item != null);
  if (!family) {
    const needle = wanted.trim().toLowerCase();
    return [listing.bodyStyle, listing.style].some((item) => item?.trim().toLowerCase() === needle);
  }
  if (observed.length === 0) return true;
  return observed.includes(family);
}

export function bodyFamily(value: string | null | undefined): "suv" | "truck" | "van" | "car" | null {
  if (!value) return null;
  const text = value.toLowerCase();
  if (/suv|sport utility|crossover|\bcuv\b/.test(text)) return "suv";
  if (/pickup|\btruck\b/.test(text)) return "truck";
  if (/\bvan\b|minivan/.test(text)) return "van";
  if (/sedan|coupe|hatchback|convertible|wagon|\bcar\b/.test(text)) return "car";
  return null;
}

/**
 * Auto.dev `vehicle.bodyStyle` value for a listings query.
 *
 * The feed often tags sedans/coupes/hatchbacks as `Car` while `style`/`type` say
 * Sedan. Sending `vehicle.bodyStyle=Sedan` therefore returns nothing for those
 * rows. Omit car-family styles so the provider keeps them; local
 * `bodyStyleMatches` still enforces sedan/car intent after fetch.
 * Comma lists and open/"any" searches send no body filter (motorcycles are
 * dropped after the response).
 */
export function providerBodyStyleParam(explicit?: string | null): string | undefined {
  const named = explicit?.trim();
  if (!named || /^any$/i.test(named) || named.includes(",")) return undefined;
  if (bodyFamily(named) === "car") return undefined;
  return named;
}

const SUV_MODELS = new Set([
  "cr-v", "crv", "hr-v", "hrv", "pilot", "passport", "rav4", "rav-4", "highlander", "4runner",
  "tucson", "santa fe", "santafe", "sportage", "sorento", "soul", "cx-5", "cx5", "cx-30", "cx-9",
  "cx-50", "forester", "outback", "crosstrek", "equinox", "escape", "explorer", "edge", "rogue",
  "pathfinder", "murano", "cherokee", "compass", "wrangler", "glc", "gle", "x3", "x5", "tahoe",
  "traverse",
]);
const CAR_MODELS = new Set([
  "camry", "corolla", "accord", "civic", "elantra", "sonata", "optima", "k5", "forte", "altima",
  "sentra", "malibu", "fusion", "prius", "impreza", "mustang", "camaro", "3 series", "5 series",
  "c-class", "e-class",
]);
const TRUCK_MODELS = new Set(["tacoma", "tundra", "f-150", "f150", "silverado", "ram", "ranger"]);

/** Body family for a known model name. Unknown models stay unknown. */
export function modelBodyFamily(model: string | null | undefined): "suv" | "truck" | "car" | null {
  const key = (model ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!key) return null;
  const compact = key.replace(/[\s-]/g, "");
  if (SUV_MODELS.has(key) || SUV_MODELS.has(compact)) return "suv";
  if (TRUCK_MODELS.has(key) || TRUCK_MODELS.has(compact)) return "truck";
  if (CAR_MODELS.has(key) || CAR_MODELS.has(compact)) return "car";
  return null;
}
