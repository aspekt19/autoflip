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

export type GovDeps = { fetch: typeof fetch; signal?: AbortSignal | null };

function govSignal(deps: GovDeps, timeoutMs = 12_000): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!deps.signal) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([deps.signal, timeout]);
  return deps.signal.aborted ? deps.signal : timeout;
}

async function getJson(url: string, deps: GovDeps, headers?: Record<string, string>): Promise<unknown | null> {
  try {
    const response = await deps.fetch(url, {
      headers: { Accept: "application/json", ...headers },
      signal: govSignal(deps),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

const RECALL_TRANSIENT_HTTP = new Set([408, 429, 500, 502, 503, 504]);

function failureIsTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String((error as { name: unknown }).name) : "";
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * One recallsByVehicle read, with a single retry when the gateway answers quickly
 * with a transient HTTP status (the observed 504) or a fast network error.
 * A timeout already used the 12s budget, so it is not tried again — three
 * sequential model years plus a second full wait can exceed the route limit.
 * There is no second NHTSA path: a different payload could be read as a
 * confirmed empty list.
 */
async function fetchRecallPayload(url: string, deps: GovDeps): Promise<unknown | null> {
  const once = async (): Promise<{ payload: unknown | null; retry: boolean }> => {
    try {
      const response = await deps.fetch(url, {
        headers: { Accept: "application/json" },
        signal: govSignal(deps),
      });
      if (!response.ok) return { payload: null, retry: RECALL_TRANSIENT_HTTP.has(response.status) };
      try {
        return { payload: await response.json(), retry: false };
      } catch {
        return { payload: null, retry: false };
      }
    } catch (error) {
      return { payload: null, retry: !failureIsTimeout(error) };
    }
  };
  const first = await once();
  if (first.payload != null) return first.payload;
  if (!first.retry) return null;
  const second = await once();
  return second.payload;
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
  const payload = await fetchRecallPayload(
    `https://api.nhtsa.gov/recalls/recallsByVehicle?${params.toString()}`,
    deps,
  );
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { records: [], available: false };
  }
  const record = payload as Record<string, unknown>;
  const results = record.results ?? record.Results;
  if (!Array.isArray(results)) return { records: [], available: false };
  return { records: parseRecalls(payload), available: true };
}

export type ComplaintsLookup = {
  count: number | null;
  /** True only when NHTSA returned a well-formed payload (count may be 0). */
  available: boolean;
  url: string;
};

export async function complaintCountFor(
  make: string,
  model: string,
  year: number,
  deps: GovDeps,
): Promise<number | null> {
  const lookup = await complaintsFor(make, model, year, deps);
  return lookup.available ? lookup.count : null;
}

export async function complaintsFor(
  make: string,
  model: string,
  year: number,
  deps: GovDeps,
): Promise<ComplaintsLookup> {
  const params = new URLSearchParams({ make, model, modelYear: String(year) });
  const url = `https://api.nhtsa.gov/complaints/complaintsByVehicle?${params.toString()}`;
  const payload = await getJson(url, deps);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { count: null, available: false, url };
  }
  const count = parseComplaintCount(payload);
  // Well-formed object with parseable count (including 0) ⇒ available.
  if (count === null) {
    const record = payload as Record<string, unknown>;
    const results = record.results ?? record.Results;
    if (!Array.isArray(results) && record.count == null && record.Count == null) {
      return { count: null, available: false, url };
    }
    return { count: Array.isArray(results) ? results.length : 0, available: true, url };
  }
  return { count, available: true, url };
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
