import { FALLBACK_MODELS, autoDevMake, isPassengerModel, mainstreamMakes, parseVpicModels } from "@/domain/vehicle-names";
import { TtlCache } from "./cache";

const DAY = 24 * 60 * 60 * 1000;
const cache = new TtlCache<string[]>(DAY);

export type CatalogDeps = { fetch?: typeof fetch; now?: number };

/** Curated makes. vPIC is not asked; its car list includes kit cars, buses, and replica builders. */
export async function catalogMakes(_deps: CatalogDeps = {}): Promise<{ makes: string[]; source: "curated" }> {
  return { makes: mainstreamMakes(), source: "curated" };
}

export async function catalogModels(
  make: string,
  year: number | null,
  deps: CatalogDeps = {},
): Promise<{ models: string[]; source: "vpic" | "bundled" }> {
  const canonical = autoDevMake(make);
  if (!canonical) return { models: [], source: "bundled" };
  const cacheKey = year ? `models:${canonical.toLowerCase()}:${year}` : `models:${canonical.toLowerCase()}`;
  const hit = cache.get(cacheKey, deps.now);
  if (hit) return { models: hit, source: "vpic" };
  const path = year
    ? `GetModelsForMakeYear/make/${encodeURIComponent(canonical)}/modelyear/${year}`
    : `GetModelsForMake/${encodeURIComponent(canonical)}`;
  const url = `https://vpic.nhtsa.dot.gov/api/vehicles/${path}?format=json`;
  try {
    const response = await (deps.fetch ?? fetch)(url, { signal: AbortSignal.timeout(12_000) });
    if (response.ok) {
      const models = parseVpicModels(await response.json())
        .filter(isPassengerModel)
        .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
      if (models.length > 0) {
        cache.set(cacheKey, models, deps.now);
        return { models, source: "vpic" };
      }
    }
  } catch {
    /* bundled models below */
  }
  return { models: (FALLBACK_MODELS[canonical] ?? []).filter(isPassengerModel), source: "bundled" };
}
