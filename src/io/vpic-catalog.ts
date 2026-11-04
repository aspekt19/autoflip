import { FALLBACK_MAKES, FALLBACK_MODELS, autoDevMake, parseVpicMakes, parseVpicModels } from "@/domain/vehicle-names";
import { TtlCache } from "./cache";

const DAY = 24 * 60 * 60 * 1000;
const cache = new TtlCache<string[]>(DAY);

const MAKES_URLS = [
  "https://vpic.nhtsa.dot.gov/api/vehicles/GetMakesForVehicleType/car?format=json",
  "https://vpic.nhtsa.dot.gov/api/vehicles/GetMakesForVehicleType/mpv?format=json",
];

export type CatalogDeps = { fetch?: typeof fetch; now?: number };

export async function catalogMakes(deps: CatalogDeps = {}): Promise<{ makes: string[]; source: "vpic" | "bundled" }> {
  const hit = cache.get("makes", deps.now);
  if (hit) return { makes: hit, source: "vpic" };
  const fetchImpl = deps.fetch ?? fetch;
  const merged = new Set<string>();
  let any = false;
  for (const url of MAKES_URLS) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(12_000) });
      if (!response.ok) continue;
      const names = parseVpicMakes(await response.json());
      if (names.length === 0) continue;
      any = true;
      for (const name of names) merged.add(name);
    } catch {
      /* try the other vehicle type, then the bundled list */
    }
  }
  if (!any) return { makes: [...FALLBACK_MAKES], source: "bundled" };
  const makes = [...merged].sort((a, b) => a.localeCompare(b));
  cache.set("makes", makes, deps.now);
  return { makes, source: "vpic" };
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
      const models = parseVpicModels(await response.json()).sort((a, b) => a.localeCompare(b));
      if (models.length > 0) {
        cache.set(cacheKey, models, deps.now);
        return { models, source: "vpic" };
      }
    }
  } catch {
    /* bundled models below */
  }
  return { models: FALLBACK_MODELS[canonical] ?? [], source: "bundled" };
}
