import type { FuelFact, Listing, ListingSource, RecallRecord, VinDecode } from "@/domain/types";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function bool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^(true|yes|1)$/i.test(value)) return true;
    if (/^(false|no|0)$/i.test(value)) return false;
  }
  return null;
}

function positivePrice(value: unknown): number | null {
  const parsed = num(value);
  if (parsed === null || parsed <= 0) return null;
  return parsed;
}

export function normalizeAutoDevListing(raw: unknown, source: ListingSource): Listing | null {
  const record = asRecord(raw);
  if (!record) return null;
  const vehicle = asRecord(record.vehicle) ?? {};
  const retail = asRecord(record.retailListing) ?? {};
  const history = asRecord(record.history);
  const vin = (str(record.vin) ?? str(vehicle.vin) ?? "").toUpperCase();
  const year = num(vehicle.year);
  const make = str(vehicle.make);
  const model = str(vehicle.model);
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin) || year === null || !make || !model) return null;

  let latitude: number | null = null;
  let longitude: number | null = null;
  if (Array.isArray(record.location) && record.location.length >= 2) {
    longitude = num(record.location[0]);
    latitude = num(record.location[1]);
  }

  // Pass-through of feed positives — never invent a purchase ask or rescale fees.
  // Kind stays unknown until a seller-page label is mapped; /find assesses usability separately.
  const priceUsd = positivePrice(retail.price) ?? positivePrice(record.price);
  const vdp = str(retail.vdp) ?? str(retail.vdpUrl) ?? str(retail.vdpURL) ?? str(record.vdp);

  return {
    vin,
    year,
    make,
    model,
    trim: str(vehicle.trim),
    miles: num(retail.miles) ?? num(retail.mileage) ?? num(record.miles) ?? num(record.mileage),
    priceUsd,
    city: str(retail.city),
    state: str(retail.state),
    zip: str(retail.zip),
    dealer: str(retail.dealer),
    vdp,
    primaryImage: str(retail.primaryImage),
    carfaxUrl: str(retail.carfaxUrl),
    used: bool(retail.used),
    cpo: bool(retail.cpo),
    accidentCount: history ? num(history.accidentCount) : null,
    oneOwner: history ? bool(history.oneOwner) : null,
    ownerCount: history ? num(history.ownerCount) : null,
    usageType: history ? str(history.usageType) : null,
    fuel: str(vehicle.fuel),
    engine: str(vehicle.engine),
    drivetrain: str(vehicle.drivetrain),
    bodyStyle: str(vehicle.bodyStyle),
    style: str(vehicle.style),
    distanceMiles: num(retail.distance) ?? num(record.distance),
    latitude,
    longitude,
    removedAt: str(record.removedAt),
    createdAt: str(record.createdAt),
    source,
    askingPriceKind: "unknown",
    askingPriceProvenance: priceUsd != null ? "feed_only" : "missing",
    askingPriceLabel: null,
    askingPriceSellerPageAccess: "not_attempted",
  };
}

export function parseAutoDevListings(payload: unknown, source: ListingSource): Listing[] {
  const record = asRecord(payload);
  const data = record?.data;
  if (Array.isArray(data)) {
    return data
      .map((item) => normalizeAutoDevListing(item, source))
      .filter((item): item is Listing => item !== null);
  }
  const one = normalizeAutoDevListing(data ?? payload, source);
  return one ? [one] : [];
}

function truthyFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return /^(true|y|yes|1)$/i.test(value.trim());
  return false;
}

export function parseRecalls(payload: unknown): RecallRecord[] {
  const record = asRecord(payload);
  const results = record?.results ?? record?.Results;
  if (!Array.isArray(results)) return [];
  return results.map((item) => {
    const row = asRecord(item) ?? {};
    return {
      campaignNumber: str(row.NHTSACampaignNumber) ?? str(row.nhtsaCampaignNumber) ?? "unknown",
      component: str(row.Component) ?? str(row.component) ?? "",
      summary: str(row.Summary) ?? str(row.summary) ?? "",
      consequence: str(row.Consequence) ?? str(row.Conequence) ?? str(row.consequence) ?? "",
      remedy: str(row.Remedy) ?? str(row.remedy) ?? "",
      parkIt: truthyFlag(row.parkIt),
      parkOutSide: truthyFlag(row.parkOutSide ?? row.parkOutside),
    };
  });
}

export function parseComplaintCount(payload: unknown): number | null {
  const record = asRecord(payload);
  if (!record) return null;
  const count = num(record.count ?? record.Count);
  if (count !== null) return count;
  const results = record.results ?? record.Results;
  if (Array.isArray(results)) return results.length;
  return null;
}

export function parseVinDecode(payload: unknown): VinDecode | null {
  const record = asRecord(payload);
  const results = record?.Results ?? record?.results;
  if (!Array.isArray(results) || results.length === 0) return null;
  const row = asRecord(results[0]);
  if (!row) return null;
  return {
    year: num(row.ModelYear),
    make: str(row.Make),
    model: str(row.Model),
    errorCode: str(row.ErrorCode),
    errorText: str(row.ErrorText) ?? str(row.AdditionalErrorText),
  };
}

export type FuelMenuItem = {
  id: number;
  text: string;
  value: string;
};

export function parseFuelMenuItems(payload: unknown): FuelMenuItem[] {
  const record = asRecord(payload);
  if (!record) {
    // Some callers pass already-normalized item arrays.
    if (Array.isArray(payload)) {
      return payload
        .map((item) => {
          const row = asRecord(item);
          if (!row) return null;
          const value = str(row.value) ?? "";
          const text = str(row.text) ?? value;
          const id = num(row.value) ?? num(row.id) ?? 0;
          return { id, text, value };
        })
        .filter((item): item is FuelMenuItem => item != null);
    }
    return [];
  }
  const menu = record.menuItem ?? record.menuItems;
  const items = Array.isArray(menu) ? menu : menu ? [menu] : [];
  const out: FuelMenuItem[] = [];
  for (const item of items) {
    const row = asRecord(item);
    if (!row) continue;
    const value = str(row.value) ?? "";
    const text = str(row.text) ?? value;
    const id = num(row.value) ?? num(row.id) ?? 0;
    out.push({ id, text, value });
  }
  return out;
}

export function parseFuelMenuIds(payload: unknown): number[] {
  return parseFuelMenuItems(payload)
    .map((item) => item.id)
    .filter((id) => id > 0);
}

export type FuelVehicleDetail = {
  id: number | null;
  combMpg: number | null;
  cityMpg: number | null;
  highwayMpg: number | null;
  annualFuelCostUsd: number | null;
  vehicleClass: string | null;
  engine: string | null;
  transmission: string | null;
  drive: string | null;
  fuelType: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
};

export function parseFuelVehicle(payload: unknown): {
  combMpg: number | null;
  annualFuelCostUsd: number | null;
  vehicleClass: string | null;
  engine: string | null;
  transmission: string | null;
} | null {
  const detail = parseFuelVehicleDetail(payload);
  if (!detail) return null;
  return {
    combMpg: detail.combMpg,
    annualFuelCostUsd: detail.annualFuelCostUsd,
    vehicleClass: detail.vehicleClass,
    engine: detail.engine,
    transmission: detail.transmission,
  };
}

export function parseFuelVehicleDetail(payload: unknown): FuelVehicleDetail | null {
  const row = asRecord(payload);
  if (!row) return null;
  return {
    id: num(row.id),
    combMpg: num(row.comb08),
    cityMpg: num(row.city08),
    highwayMpg: num(row.highway08),
    annualFuelCostUsd: num(row.fuelCost08),
    vehicleClass: str(row.VClass),
    engine: str(row.eng_dscr) ?? str(row.engine),
    transmission: str(row.trany),
    drive: str(row.drive),
    fuelType: str(row.fuelType1) ?? str(row.fuelType),
    make: str(row.make),
    model: str(row.model),
    year: num(row.year),
  };
}

export type FuelPrices = {
  regular: number | null;
  midgrade: number | null;
  premium: number | null;
  diesel: number | null;
  e85: number | null;
  electric: number | null;
  cng: number | null;
  lpg: number | null;
};

export function parseFuelPrices(payload: unknown): FuelPrices | null {
  const row = asRecord(payload);
  if (!row) return null;
  return {
    regular: num(row.regular),
    midgrade: num(row.midgrade),
    premium: num(row.premium),
    diesel: num(row.diesel),
    e85: num(row.e85),
    electric: num(row.electric),
    cng: num(row.cng),
    lpg: num(row.lpg),
  };
}

/** Map FuelEconomy fuelType string → published $/gal (or kWh) when available. */
export function usdPerUnitFromFuelPrices(
  fuelType: string | null,
  prices: FuelPrices | null,
): { usdPerUnit: number | null; priceKey: string | null; unit: "gallon" | "kwh" | null } {
  if (!prices || !fuelType) return { usdPerUnit: null, priceKey: null, unit: null };
  const t = fuelType.toLowerCase();
  if (t.includes("diesel")) return { usdPerUnit: prices.diesel, priceKey: "diesel", unit: "gallon" };
  if (t.includes("premium")) return { usdPerUnit: prices.premium, priceKey: "premium", unit: "gallon" };
  if (t.includes("midgrade")) return { usdPerUnit: prices.midgrade, priceKey: "midgrade", unit: "gallon" };
  if (t.includes("e85")) return { usdPerUnit: prices.e85, priceKey: "e85", unit: "gallon" };
  if (t.includes("electric") || t.includes("electricity")) {
    return { usdPerUnit: prices.electric, priceKey: "electric", unit: "kwh" };
  }
  if (t.includes("cng") || t.includes("natural")) return { usdPerUnit: prices.cng, priceKey: "cng", unit: "gallon" };
  if (t.includes("propane") || t.includes("lpg")) return { usdPerUnit: prices.lpg, priceKey: "lpg", unit: "gallon" };
  if (t.includes("regular") || t.includes("gasoline") || t.includes("gas")) {
    return { usdPerUnit: prices.regular, priceKey: "regular", unit: "gallon" };
  }
  return { usdPerUnit: prices.regular, priceKey: "regular", unit: "gallon" };
}

export function fuelFactFromVehicles(
  vehicles: Array<{ combMpg: number | null; annualFuelCostUsd: number | null; vehicleClass: string | null; engine: string | null }>,
  engineHint: string | null,
): FuelFact | null {
  const usable = vehicles.filter((item) => item.annualFuelCostUsd !== null || item.combMpg !== null);
  if (usable.length === 0) return null;
  const hint = (engineHint ?? "").toLowerCase();
  const hinted = hint
    ? usable.find((item) => {
        const engine = (item.engine ?? "").toLowerCase();
        if (!engine) return false;
        const liters = hint.match(/(\d(?:\.\d)?)\s*l/);
        if (liters && engine.includes(liters[1]!)) return true;
        return false;
      })
    : undefined;
  const costs = usable
    .map((item) => item.annualFuelCostUsd)
    .filter((item): item is number => item !== null);
  const only = usable.length === 1 ? usable[0] : hinted;
  if (only) {
    return {
      source: "fueleconomy.gov",
      match: "closest_config",
      combMpg: only.combMpg,
      annualFuelCostUsd: only.annualFuelCostUsd,
      annualFuelCostLowUsd: costs.length ? Math.min(...costs) : null,
      annualFuelCostHighUsd: costs.length ? Math.max(...costs) : null,
      vehicleClass: only.vehicleClass,
      configsConsidered: usable.length,
    };
  }
  return {
    source: "fueleconomy.gov",
    match: "range",
    combMpg: null,
    annualFuelCostUsd: null,
    annualFuelCostLowUsd: costs.length ? Math.min(...costs) : null,
    annualFuelCostHighUsd: costs.length ? Math.max(...costs) : null,
    vehicleClass: usable[0]?.vehicleClass ?? null,
    configsConsidered: usable.length,
  };
}

export function parseCensusPoint(payload: unknown): { latitude: number; longitude: number } | null {
  const record = asRecord(payload);
  const result = asRecord(record?.result);
  const matches = result?.addressMatches;
  if (!Array.isArray(matches) || matches.length === 0) return null;
  const first = asRecord(matches[0]);
  const coords = asRecord(first?.coordinates);
  const latitude = num(coords?.y);
  const longitude = num(coords?.x);
  if (latitude === null || longitude === null) return null;
  return { latitude, longitude };
}
