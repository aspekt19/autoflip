/**
 * Free public FuelEconomy.gov client (no API key).
 * Used by Find free_gov_fuel receipts — timeouts, graceful unavailable, process cache upstream.
 */
import {
  parseFuelMenuItems,
  parseFuelPrices,
  parseFuelVehicleDetail,
  type FuelMenuItem,
  type FuelPrices,
  type FuelVehicleDetail,
} from "./parsers";

export type FuelEconomyDeps = { fetch: typeof fetch };

const TIMEOUT_MS = 12_000;
const BASE = "https://www.fueleconomy.gov/ws/rest";

async function getJson(url: string, deps: FuelEconomyDeps): Promise<unknown | null> {
  try {
    const response = await deps.fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const text = await response.text();
    if (!text || text === "null") return null;
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function fuelMenuOptionsUrl(year: number, make: string, model: string): string {
  const params = new URLSearchParams({ year: String(year), make, model });
  return `${BASE}/vehicle/menu/options?${params.toString()}`;
}

export function fuelVehicleUrl(id: number): string {
  return `${BASE}/vehicle/${id}`;
}

export function fuelPricesUrl(): string {
  return `${BASE}/fuelprices`;
}

export function fuelModelMenuUrl(year: number, make: string): string {
  const params = new URLSearchParams({ year: String(year), make });
  return `${BASE}/vehicle/menu/model?${params.toString()}`;
}

/** Public human page for a FuelEconomy vehicle id (not the REST endpoint). */
export function fuelEconomyHumanPage(vehicleId: number | null): string | null {
  if (vehicleId == null || !Number.isFinite(vehicleId)) return null;
  return `https://www.fueleconomy.gov/feg/Find.do?action=sbs&id=${Math.trunc(vehicleId)}`;
}

export async function fetchFuelMenuOptions(
  year: number,
  make: string,
  model: string,
  deps: FuelEconomyDeps,
): Promise<{ items: FuelMenuItem[]; url: string; available: boolean }> {
  const url = fuelMenuOptionsUrl(year, make, model);
  const payload = await getJson(url, deps);
  if (payload == null) return { items: [], url, available: false };
  const items = parseFuelMenuItems(payload);
  return { items, url, available: true };
}

export async function fetchFuelModelNames(
  year: number,
  make: string,
  deps: FuelEconomyDeps,
): Promise<{ names: string[]; url: string; available: boolean }> {
  const url = fuelModelMenuUrl(year, make);
  const payload = await getJson(url, deps);
  if (payload == null) return { names: [], url, available: false };
  const items = parseFuelMenuItems(payload);
  return { names: items.map((i) => i.text || i.value).filter(Boolean), url, available: true };
}

export async function fetchFuelVehicle(
  id: number,
  deps: FuelEconomyDeps,
): Promise<{ detail: FuelVehicleDetail | null; url: string }> {
  const url = fuelVehicleUrl(id);
  const payload = await getJson(url, deps);
  return { detail: payload ? parseFuelVehicleDetail(payload) : null, url };
}

export async function fetchFuelPrices(
  deps: FuelEconomyDeps,
): Promise<{ prices: FuelPrices | null; url: string; available: boolean }> {
  const url = fuelPricesUrl();
  const payload = await getJson(url, deps);
  if (payload == null) return { prices: null, url, available: false };
  const prices = parseFuelPrices(payload);
  return { prices, url, available: prices != null };
}

/** Convenience: menu option vehicle ids for year/make/model. */
export async function fetchFuelMenuIds(
  year: number,
  make: string,
  model: string,
  deps: FuelEconomyDeps,
): Promise<number[]> {
  const { items, available } = await fetchFuelMenuOptions(year, make, model, deps);
  if (!available) return [];
  return items.map((i) => i.id).filter((id) => id > 0);
}
