import type { Listing } from "@/domain/types";
import type { Kv } from "./kv";

const TTL_MS = 6 * 60 * 60 * 1000;

/** Schema v2 — old unversioned / miskeyed rows must not be treated as verified local comps. */
export const COMP_CACHE_SCHEMA = 2;

/**
 * Actual geographic scope of the Autodev search that produced the rows —
 * not the buyer's desired need.zip when the search was nationwide.
 */
export type CompGeoScope =
  | { kind: "nationwide" }
  | { kind: "zip"; zip: string; distanceMiles: number | null };

export type CompCacheRecord = {
  schemaVersion: number;
  geo: CompGeoScope;
  expiresAt: number;
  listings: Listing[];
  /** Human label for reports — asking comps only, not sold. */
  provenanceNote: string;
};

export function geoScopeLabel(geo: CompGeoScope): string {
  if (geo.kind === "nationwide") return "nationwide (U.S.) asking comps";
  const dist = geo.distanceMiles != null ? `${geo.distanceMiles} mi` : "open radius";
  return `ZIP ${geo.zip} (${dist}) asking comps`;
}

export function geoConfidence(geo: CompGeoScope): "nationwide" | "local_zip" {
  return geo.kind === "nationwide" ? "nationwide" : "local_zip";
}

/** Build scope from the search that actually ran (searchZip + radius), not desired need.zip alone. */
export function geoScopeFromSearch(input: {
  searchZip?: string | null;
  distanceMiles?: number | null;
}): CompGeoScope {
  const zip = input.searchZip?.replace(/\D/g, "").slice(0, 5) || "";
  if (!zip || input.distanceMiles == null) {
    // No ZIP filter or no radius → nationwide pull (optional ZIP context must not key as local).
    return { kind: "nationwide" };
  }
  return { kind: "zip", zip, distanceMiles: input.distanceMiles };
}

export function compCacheKey(input: {
  make: string;
  model: string;
  year: number;
  geo: CompGeoScope;
}): string {
  const make = input.make.trim().toLowerCase();
  const model = input.model.trim().toLowerCase();
  if (input.geo.kind === "nationwide") {
    return `comps:v${COMP_CACHE_SCHEMA}:${make}:${model}:${input.year}:nationwide`;
  }
  const zip3 = input.geo.zip.replace(/\D/g, "").slice(0, 3) || "xxx";
  const dist = input.geo.distanceMiles ?? "open";
  return `comps:v${COMP_CACHE_SCHEMA}:${make}:${model}:${input.year}:zip:${zip3}:d${dist}`;
}

export type ReadCompsResult = {
  listings: Listing[];
  geo: CompGeoScope;
  geographicConfidence: "nationwide" | "local_zip";
  provenanceNote: string;
  sourceLabel: string;
};

export async function readComps(
  kv: Kv,
  input: { make: string; model: string; year: number; geo: CompGeoScope },
): Promise<ReadCompsResult | null> {
  const raw = await kv.get(compCacheKey(input));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CompCacheRecord> & { listings?: Listing[] };
    // Reject legacy unversioned payloads (pre-v2 keyed by desired zip / "any").
    if (parsed.schemaVersion !== COMP_CACHE_SCHEMA) return null;
    if (!parsed.expiresAt || parsed.expiresAt < Date.now() || !Array.isArray(parsed.listings)) return null;
    if (!parsed.geo || !geoMatches(parsed.geo, input.geo)) return null;
    return {
      listings: parsed.listings,
      geo: parsed.geo,
      geographicConfidence: geoConfidence(parsed.geo),
      provenanceNote: parsed.provenanceNote ?? geoScopeLabel(parsed.geo),
      sourceLabel: "cached_asking_comps",
    };
  } catch {
    return null;
  }
}

function geoMatches(stored: CompGeoScope, wanted: CompGeoScope): boolean {
  if (stored.kind !== wanted.kind) return false;
  if (stored.kind === "nationwide" && wanted.kind === "nationwide") return true;
  if (stored.kind === "zip" && wanted.kind === "zip") {
    return (
      stored.zip.replace(/\D/g, "").slice(0, 3) === wanted.zip.replace(/\D/g, "").slice(0, 3) &&
      stored.distanceMiles === wanted.distanceMiles
    );
  }
  return false;
}

/** Store listings under the ACTUAL search geography. Asking prices only — not sold comps. */
export async function rememberComps(
  kv: Kv,
  input: { make: string; model: string; geo: CompGeoScope },
  listings: Listing[],
): Promise<void> {
  if (listings.length === 0 || !input.make || !input.model) return;
  const record: CompCacheRecord = {
    schemaVersion: COMP_CACHE_SCHEMA,
    geo: input.geo,
    expiresAt: Date.now() + TTL_MS,
    listings,
    provenanceNote: `${geoScopeLabel(input.geo)} — asking prices only, not closed sales.`,
  };
  const body = JSON.stringify(record);
  const years = [...new Set(listings.map((item) => item.year))].slice(0, 8);
  await Promise.all(years.map((year) => kv.set(compCacheKey({ ...input, year }), body)));
}
