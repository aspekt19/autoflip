import type { Listing } from "@/domain/types";
import type { Kv } from "./kv";

const TTL_MS = 6 * 60 * 60 * 1000;

export function compCacheKey(input: { make: string; model: string; year: number; zip?: string | null }): string {
  const region = (input.zip ?? "").replace(/\D/g, "").slice(0, 3) || "any";
  return `comps:${input.make.trim().toLowerCase()}:${input.model.trim().toLowerCase()}:${input.year}:${region}`;
}

export async function readComps(
  kv: Kv,
  input: { make: string; model: string; year: number; zip?: string | null },
): Promise<Listing[] | null> {
  const raw = await kv.get(compCacheKey(input));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { expiresAt?: number; listings?: Listing[] };
    if (!parsed.expiresAt || parsed.expiresAt < Date.now() || !Array.isArray(parsed.listings)) return null;
    return parsed.listings;
  } catch {
    return null;
  }
}

/** Store the listings already fetched for this make, model, and region. One key per year in the set. */
export async function rememberComps(
  kv: Kv,
  input: { make: string; model: string; zip?: string | null },
  listings: Listing[],
): Promise<void> {
  if (listings.length === 0 || !input.make || !input.model) return;
  const body = JSON.stringify({ expiresAt: Date.now() + TTL_MS, listings });
  const years = [...new Set(listings.map((item) => item.year))].slice(0, 8);
  await Promise.all(years.map((year) => kv.set(compCacheKey({ ...input, year }), body)));
}
