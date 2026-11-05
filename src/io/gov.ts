import {
  fuelFactFromVehicles,
  parseCensusPoint,
  parseComplaintCount,
  parseFuelMenuIds,
  parseFuelVehicle,
  parseRecalls,
  parseVinDecode,
} from "./parsers";
import type { FuelFact, RecallRecord, VinDecode } from "@/domain/types";

export type GovDeps = { fetch: typeof fetch };

async function getJson(url: string, deps: GovDeps, headers?: Record<string, string>): Promise<unknown | null> {
  try {
    const response = await deps.fetch(url, {
      headers: { Accept: "application/json", ...headers },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export async function decodeVin(vin: string, deps: GovDeps): Promise<VinDecode | null> {
  const payload = await getJson(
    `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`,
    deps,
  );
  if (!payload) return null;
  return parseVinDecode(payload);
}

export type RecallsLookup = {
  records: RecallRecord[];
  /** True only when NHTSA returned a well-formed results array (including an empty one). */
  available: boolean;
};

export async function recallsFor(make: string, model: string, year: number, deps: GovDeps): Promise<RecallsLookup> {
  const params = new URLSearchParams({ make, model, modelYear: String(year) });
  const payload = await getJson(`https://api.nhtsa.gov/recalls/recallsByVehicle?${params.toString()}`, deps);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { records: [], available: false };
  }
  const record = payload as Record<string, unknown>;
  const results = record.results ?? record.Results;
  if (!Array.isArray(results)) return { records: [], available: false };
  return { records: parseRecalls(payload), available: true };
}

export async function complaintCountFor(
  make: string,
  model: string,
  year: number,
  deps: GovDeps,
): Promise<number | null> {
  const params = new URLSearchParams({ make, model, modelYear: String(year) });
  const payload = await getJson(`https://api.nhtsa.gov/complaints/complaintsByVehicle?${params.toString()}`, deps);
  if (!payload) return null;
  return parseComplaintCount(payload);
}

export async function fuelFor(
  year: number,
  make: string,
  model: string,
  engineHint: string | null,
  deps: GovDeps,
): Promise<FuelFact | null> {
  const params = new URLSearchParams({ year: String(year), make, model });
  const menu = await getJson(`https://www.fueleconomy.gov/ws/rest/vehicle/menu/options?${params.toString()}`, deps);
  if (!menu) return null;
  const ids = parseFuelMenuIds(menu).slice(0, 6);
  if (ids.length === 0) return null;
  const vehicles = [];
  for (const id of ids) {
    const payload = await getJson(`https://www.fueleconomy.gov/ws/rest/vehicle/${id}`, deps);
    const parsed = payload ? parseFuelVehicle(payload) : null;
    if (parsed) vehicles.push(parsed);
  }
  return fuelFactFromVehicles(vehicles, engineHint);
}

export async function geocodeZipCity(input: {
  zip?: string | null;
  city?: string | null;
  state?: string | null;
}, deps: GovDeps): Promise<{ latitude: number; longitude: number } | null> {
  const parts = [input.city, input.state, input.zip].filter(Boolean).join(" ");
  if (!parts.trim()) return null;
  const params = new URLSearchParams({
    address: parts,
    benchmark: "Public_AR_Current",
    format: "json",
  });
  const payload = await getJson(
    `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${params.toString()}`,
    deps,
  );
  if (!payload) return null;
  return parseCensusPoint(payload);
}
