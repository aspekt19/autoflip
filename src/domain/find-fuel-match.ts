/**
 * FuelEconomy.gov matching + labeled annual fuel-cost math for Find.
 *
 * Rules:
 * - Match year/make/model; refine with trim/engine/drive when the listing provides them.
 * - Several surviving options → explicit min..max range + ambiguous (never silent pick).
 * - Assumptions are always labeled and user-visible (default 12k mi/yr; city-heavy when parsed).
 * - Prefer FuelEconomy.gov published fuelprices; otherwise labeled fallback $/gal.
 */
import {
  fetchFuelMenuOptions,
  fetchFuelModelNames,
  fetchFuelPrices,
  fetchFuelVehicle,
  fuelEconomyHumanPage,
  type FuelEconomyDeps,
} from "@/io/fuel-economy";
import {
  isElectricFuelType,
  usdPerUnitFromFuelPrices,
  type FuelPrices,
  type FuelVehicleDetail,
} from "@/io/parsers";
import type { FuelFact } from "./types";

export const FIND_FUEL_DEFAULT_MILES_PER_YEAR = 12_000;
/** Harmonic city/highway blend when the shopper did not say mostly city (EPA-style share). */
export const FIND_FUEL_DEFAULT_CITY_SHARE = 0.55;
/** When note says mostly city driving. */
export const FIND_FUEL_CITY_HEAVY_SHARE = 0.7;
/** Labeled fallback only when FuelEconomy fuelprices is unavailable for liquid fuels. */
export const FIND_FUEL_FALLBACK_USD_PER_GAL = 3.5;

export type FindFuelMatchKind = "exact" | "ambiguous" | "no_match" | "unavailable";

export type FindFuelAssumptions = {
  milesPerYear: number;
  cityShare: number;
  highwayShare: number;
  usdPerGallon: number;
  priceSource: "fueleconomy.gov/fuelprices" | "labeled_fallback";
  priceKey: string | null;
  cityHeavy: boolean;
  label: string;
  /**
   * Electricity: annual $ comes from FuelEconomy fuelCost08 (never MPGe × $/gal).
   * Liquid fuels: false — use harmonic city/hwy MPG × miles × $/gal.
   */
  useEpaPublishedAnnual: boolean;
  /** Price unit for the labeled feed (gallon fuels vs kWh electricity context). */
  priceUnit: "gallon" | "kwh" | "epa_annual";
};

export type FindFuelEvidence = {
  match: FindFuelMatchKind;
  ambiguous: boolean;
  combMpgLow: number | null;
  combMpgHigh: number | null;
  cityMpgLow: number | null;
  cityMpgHigh: number | null;
  highwayMpgLow: number | null;
  highwayMpgHigh: number | null;
  annualFuelUsdLow: number | null;
  annualFuelUsdHigh: number | null;
  /** EPA published annual (fuelCost08) range when present — separate from our labeled estimate. */
  epaAnnualUsdLow: number | null;
  epaAnnualUsdHigh: number | null;
  fuelType: string | null;
  configsConsidered: number;
  optionTexts: string[];
  epaVehicleIds: number[];
  modelNamesTried: string[];
  assumptions: FindFuelAssumptions;
  sourceUrl: string | null;
  humanPageUrl: string | null;
  reason: string | null;
  honesty: string;
};

export type ListingFuelHints = {
  year: number;
  make: string;
  model: string;
  trim?: string | null;
  engine?: string | null;
  drivetrain?: string | null;
};

function normalizeToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function finitePositive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** Detect city-heavy intent from shopper note (Find). */
export function parseCityHeavyFromNote(note: string | null | undefined): boolean {
  if (!note) return false;
  return /\bmostly\s+city\b|\bcity\s+driving\b|\bcity[\s-]?heavy\b|\bmainly\s+city\b/i.test(note);
}

export function buildFindFuelAssumptions(input: {
  note?: string | null;
  milesPerYear?: number | null;
  usdPerGallon?: number | null;
  priceSource?: FindFuelAssumptions["priceSource"];
  priceKey?: string | null;
  /** Electricity path — annual $ from EPA fuelCost08, not gal math. */
  electric?: boolean;
  usdPerKwh?: number | null;
}): FindFuelAssumptions {
  const cityHeavy = parseCityHeavyFromNote(input.note);
  const cityShare = cityHeavy ? FIND_FUEL_CITY_HEAVY_SHARE : FIND_FUEL_DEFAULT_CITY_SHARE;
  const milesPerYear =
    finitePositive(input.milesPerYear) ? Math.round(input.milesPerYear) : FIND_FUEL_DEFAULT_MILES_PER_YEAR;
  if (input.electric) {
    const kwh =
      finitePositive(input.usdPerKwh) ? input.usdPerKwh : null;
    const priceSource = kwh != null ? "fueleconomy.gov/fuelprices" : "labeled_fallback";
    const kwhBit =
      kwh != null
        ? `FuelEconomy.gov published electricity ~$${kwh.toFixed(2)}/kWh (context only)`
        : "FuelEconomy.gov electricity price feed unavailable";
    return {
      milesPerYear,
      cityShare,
      highwayShare: 1 - cityShare,
      usdPerGallon: 0,
      priceSource,
      priceKey: "electric",
      cityHeavy,
      useEpaPublishedAnnual: true,
      priceUnit: "epa_annual",
      label: `Electricity — using FuelEconomy.gov published annual electricity cost (fuelCost08), not MPGe × $/gal. ${kwhBit}. City/highway mix does not apply to this electricity annual.`,
    };
  }
  const usdPerGallon = finitePositive(input.usdPerGallon)
    ? input.usdPerGallon
    : FIND_FUEL_FALLBACK_USD_PER_GAL;
  const priceSource = input.priceSource ?? "labeled_fallback";
  const priceKey = input.priceKey ?? (priceSource === "labeled_fallback" ? "regular_fallback" : null);
  const mixBit = `${milesPerYear.toLocaleString("en-US")} miles per year, ${Math.round(cityShare * 100)}% city / ${Math.round((1 - cityShare) * 100)}% highway, estimated from EPA fuel economy${cityHeavy ? " (mostly city from your note)" : ""}`;
  const label =
    priceSource === "fueleconomy.gov/fuelprices"
      ? `${mixBit}, fuel price from FuelEconomy.gov published ${priceKey ?? "regular"} ($${usdPerGallon.toFixed(2)}/gal)`
      : `${mixBit}, labeled fuel-price assumption $${usdPerGallon.toFixed(2)}/gal (FuelEconomy.gov price feed unavailable)`;
  return {
    milesPerYear,
    cityShare,
    highwayShare: 1 - cityShare,
    usdPerGallon,
    priceSource,
    priceKey,
    cityHeavy,
    useEpaPublishedAnnual: false,
    priceUnit: "gallon",
    label,
  };
}

/**
 * Effective MPG from city/highway with an explicit city share.
 * Falls back to combined MPG when city/hwy missing.
 */
export function effectiveMpgFromMix(input: {
  cityMpg: number | null;
  highwayMpg: number | null;
  combMpg: number | null;
  cityShare: number;
}): number | null {
  const city = finitePositive(input.cityMpg) ? input.cityMpg : null;
  const hwy = finitePositive(input.highwayMpg) ? input.highwayMpg : null;
  const share = Math.min(0.95, Math.max(0.05, input.cityShare));
  if (city != null && hwy != null) {
    return 1 / (share / city + (1 - share) / hwy);
  }
  return finitePositive(input.combMpg) ? input.combMpg : null;
}

export function estimateAnnualFuelUsd(input: {
  cityMpg: number | null;
  highwayMpg: number | null;
  combMpg: number | null;
  assumptions: Pick<FindFuelAssumptions, "milesPerYear" | "cityShare" | "usdPerGallon">;
}): number | null {
  const mpg = effectiveMpgFromMix({
    cityMpg: input.cityMpg,
    highwayMpg: input.highwayMpg,
    combMpg: input.combMpg,
    cityShare: input.assumptions.cityShare,
  });
  if (mpg == null) return null;
  return Math.round((input.assumptions.milesPerYear / mpg) * input.assumptions.usdPerGallon);
}

function driveHintMatches(drive: string | null | undefined, hint: string | null | undefined): boolean {
  if (!hint || !drive) return true;
  const d = normalizeToken(drive);
  const h = normalizeToken(hint);
  if (!h) return true;
  if (h.includes("awd") || h.includes("4wd") || h.includes("allwheel") || h.includes("fourwheel")) {
    return d.includes("allwheel") || d.includes("4wd") || d.includes("fourwheel") || d.includes("awd");
  }
  if (h.includes("fwd") || h.includes("front")) return d.includes("front");
  if (h.includes("rwd") || h.includes("rear")) return d.includes("rear");
  return d.includes(h) || h.includes(d);
}

function engineHintMatches(
  detail: Pick<FuelVehicleDetail, "engine">,
  optionText: string,
  hint: string | null | undefined,
): boolean {
  if (!hint) return true;
  const h = hint.toLowerCase();
  const hay = `${detail.engine ?? ""} ${optionText}`.toLowerCase();
  const liters = h.match(/(\d(?:\.\d)?)\s*l/);
  if (liters && hay.includes(liters[1]!)) return true;
  const cyl = h.match(/(\d)\s*cyl/);
  if (cyl && hay.includes(`${cyl[1]} cyl`)) return true;
  const turbo = /\bturbo\b/.test(h);
  if (turbo && /turbo/.test(hay)) return true;
  // Soft: if hint has no parseable engine bits, do not filter out.
  if (!liters && !cyl && !turbo) return true;
  return false;
}

function trimHintMatches(optionText: string, modelName: string, trim: string | null | undefined): boolean {
  if (!trim) return true;
  const t = normalizeToken(trim);
  if (!t || t.length < 2) return true;
  const hay = normalizeToken(`${optionText} ${modelName}`);
  return hay.includes(t);
}

/**
 * Alt-powertrain tokens that must not bleed into a plain gas listing via prefix match
 * (e.g. "Tucson" must not resolve "Tucson Fuel Cell"; "Camry" must not resolve hybrids
 * when the exact "Camry" key is absent and we fall through to prefix/includes).
 */
const ALT_POWERTRAIN_RE =
  /\b(fuel\s*cells?|hybrid|plug[\s-]?in|phev|electric|ev(?=[^a-z]|$)|e-?tron|prime)\b/i;

export function listingModelRequestsAltPowertrain(listingModel: string): boolean {
  return ALT_POWERTRAIN_RE.test(listingModel);
}

/** True for hydrogen / electricity / plug-in fuelType1 values that are not ordinary liquid gas/diesel. */
export function isAltPowertrainFuelType(fuelType: string | null | undefined): boolean {
  if (!fuelType) return false;
  const t = fuelType.toLowerCase();
  if (t.includes("hydrogen")) return true;
  if (isElectricFuelType(fuelType)) return true;
  if (t.includes("plug-in") || t.includes("phev")) return true;
  return false;
}

/** Resolve EPA model menu names that correspond to a listing model (e.g. CR-V → CR-V AWD/FWD). */
export function resolveEpaModelNames(listingModel: string, menuNames: string[]): string[] {
  const want = normalizeToken(listingModel);
  if (!want) return [];
  const allowAlt = listingModelRequestsAltPowertrain(listingModel);
  const eligible = allowAlt
    ? menuNames
    : menuNames.filter((n) => !ALT_POWERTRAIN_RE.test(n));
  const exact = eligible.filter((n) => normalizeToken(n) === want);
  if (exact.length > 0) return exact;
  const prefixed = eligible.filter((n) => {
    const nrm = normalizeToken(n);
    return nrm === want || nrm.startsWith(want);
  });
  if (prefixed.length > 0) return prefixed;
  return eligible.filter((n) => normalizeToken(n).includes(want));
}

function emptyEvidence(
  match: FindFuelMatchKind,
  assumptions: FindFuelAssumptions,
  over: Partial<FindFuelEvidence> = {},
): FindFuelEvidence {
  return {
    match,
    ambiguous: match === "ambiguous",
    combMpgLow: null,
    combMpgHigh: null,
    cityMpgLow: null,
    cityMpgHigh: null,
    highwayMpgLow: null,
    highwayMpgHigh: null,
    annualFuelUsdLow: null,
    annualFuelUsdHigh: null,
    epaAnnualUsdLow: null,
    epaAnnualUsdHigh: null,
    fuelType: null,
    configsConsidered: 0,
    optionTexts: [],
    epaVehicleIds: [],
    modelNamesTried: [],
    assumptions,
    sourceUrl: null,
    humanPageUrl: null,
    reason: null,
    honesty:
      "Estimated fuel cost from FuelEconomy.gov when matched — not insurance, maintenance, or a full ownership cost.",
    ...over,
  };
}

function summarizeVehicles(
  vehicles: Array<{ detail: FuelVehicleDetail; optionText: string }>,
  assumptions: FindFuelAssumptions,
  modelNamesTried: string[],
  sourceUrl: string | null,
): FindFuelEvidence {
  const comb = vehicles.map((v) => v.detail.combMpg).filter(finitePositive);
  const city = vehicles.map((v) => v.detail.cityMpg).filter(finitePositive);
  const hwy = vehicles.map((v) => v.detail.highwayMpg).filter(finitePositive);
  const epa = vehicles.map((v) => v.detail.annualFuelCostUsd).filter(finitePositive);
  const electric = vehicles.some((v) => isElectricFuelType(v.detail.fuelType));
  // Electricity: never MPGe × $/gal — use EPA published annual (fuelCost08) only.
  const annuals = electric
    ? epa
    : vehicles
        .map((v) =>
          estimateAnnualFuelUsd({
            cityMpg: v.detail.cityMpg,
            highwayMpg: v.detail.highwayMpg,
            combMpg: v.detail.combMpg,
            assumptions,
          }),
        )
        .filter((n): n is number => n != null);
  const ids = vehicles.map((v) => v.detail.id).filter((id): id is number => id != null);
  const ambiguous = vehicles.length > 1;
  const match: FindFuelMatchKind = vehicles.length === 0 ? "no_match" : ambiguous ? "ambiguous" : "exact";
  const fuelType = vehicles[0]?.detail.fuelType ?? null;
  const annualLow = annuals.length ? Math.min(...annuals) : null;
  const annualHigh = annuals.length ? Math.max(...annuals) : null;
  return {
    match,
    ambiguous,
    combMpgLow: comb.length ? Math.min(...comb) : null,
    combMpgHigh: comb.length ? Math.max(...comb) : null,
    cityMpgLow: city.length ? Math.min(...city) : null,
    cityMpgHigh: city.length ? Math.max(...city) : null,
    highwayMpgLow: hwy.length ? Math.min(...hwy) : null,
    highwayMpgHigh: hwy.length ? Math.max(...hwy) : null,
    annualFuelUsdLow: annualLow,
    annualFuelUsdHigh: annualHigh,
    epaAnnualUsdLow: epa.length ? Math.min(...epa) : null,
    epaAnnualUsdHigh: epa.length ? Math.max(...epa) : null,
    fuelType,
    configsConsidered: vehicles.length,
    optionTexts: vehicles.map((v) => v.optionText).slice(0, 8),
    epaVehicleIds: ids.slice(0, 8),
    modelNamesTried,
    assumptions,
    sourceUrl,
    humanPageUrl: fuelEconomyHumanPage(ids[0] ?? null),
    reason: ambiguous
      ? "Several FuelEconomy.gov configurations match this year/make/model — showing a range, not a silent single pick."
      : electric && annualLow == null
        ? "Electricity match found but FuelEconomy.gov did not publish an annual electricity cost — dollars not invented from MPGe."
        : null,
    honesty: ambiguous
      ? `Several versions of this model match on FuelEconomy.gov (${vehicles.length}). Annual fuel is a range, estimated from EPA fuel economy. Not a full ownership cost, and not specific to this VIN.`
      : electric && annualLow == null
        ? `FuelEconomy.gov electricity match found, but the published annual electricity cost is missing — Lemonless will not invent a dollar figure from MPGe. (${assumptions.label})`
        : `Fuel cost estimated from EPA fuel economy. Not a full ownership cost, and not specific to this VIN.`,
  };
}

/**
 * Pure matcher over already-fetched EPA vehicles (fixture-friendly).
 * When listing provides trim/engine/drive, filter; if multiple remain → ambiguous.
 */
export function matchFuelVehicles(input: {
  listing: ListingFuelHints;
  vehicles: Array<{ detail: FuelVehicleDetail; optionText: string; modelName: string }>;
  assumptions: FindFuelAssumptions;
  modelNamesTried: string[];
  sourceUrl: string | null;
}): FindFuelEvidence {
  if (input.vehicles.length === 0) {
    return emptyEvidence("no_match", input.assumptions, {
      modelNamesTried: input.modelNamesTried,
      sourceUrl: input.sourceUrl,
      reason: "No FuelEconomy.gov configurations for this year/make/model.",
      honesty:
        "Fuel cost unavailable — no FuelEconomy.gov match for this year/make/model. Lemonless does not invent MPG.",
    });
  }

  const allowAlt = listingModelRequestsAltPowertrain(input.listing.model);
  const isAltVehicle = (v: { detail: { fuelType: string | null }; modelName: string }) =>
    isAltPowertrainFuelType(v.detail.fuelType) || ALT_POWERTRAIN_RE.test(v.modelName);
  // Drop Fuel Cell / Hybrid / EV siblings when ordinary gas/diesel configs exist for the
  // same listing model. Pure-EV listings (Model 3, Leaf, …) keep their electric configs.
  const hasOrdinarySibling = input.vehicles.some((v) => !isAltVehicle(v));
  const compatible = input.vehicles.filter((v) => {
    if (!allowAlt && hasOrdinarySibling && isAltVehicle(v)) return false;
    return true;
  });
  const basePool = compatible.length > 0 ? compatible : input.vehicles;

  const filtered = basePool.filter((v) => {
    if (!driveHintMatches(v.detail.drive, input.listing.drivetrain)) return false;
    if (!engineHintMatches(v.detail, v.optionText, input.listing.engine)) return false;
    if (!trimHintMatches(v.optionText, v.modelName, input.listing.trim)) return false;
    return true;
  });

  // If hints eliminated everything, fall back to compatible configs as ambiguous (honest).
  const pool = filtered.length > 0 ? filtered : basePool;
  const usedFallback = filtered.length === 0 && basePool.length > 0;
  const evidence = summarizeVehicles(pool, input.assumptions, input.modelNamesTried, input.sourceUrl);
  if (usedFallback) {
    return {
      ...evidence,
      match: pool.length > 1 ? "ambiguous" : evidence.match,
      ambiguous: pool.length > 1,
      reason:
        "Listing trim/engine/drive hints did not uniquely match — using all year/make/model configurations as a range.",
      honesty: `${evidence.honesty} Trim/engine/drive hints were inconclusive.`,
    };
  }
  return evidence;
}

function priceAssumptionsFromFeed(
  fuelType: string | null,
  prices: FuelPrices | null,
  note: string | null | undefined,
): FindFuelAssumptions {
  if (isElectricFuelType(fuelType)) {
    const mapped = usdPerUnitFromFuelPrices(fuelType, prices);
    return buildFindFuelAssumptions({
      note,
      electric: true,
      usdPerKwh: mapped.usdPerUnit,
    });
  }
  const mapped = usdPerUnitFromFuelPrices(fuelType, prices);
  if (mapped.usdPerUnit != null && mapped.unit === "gallon") {
    return buildFindFuelAssumptions({
      note,
      usdPerGallon: mapped.usdPerUnit,
      priceSource: "fueleconomy.gov/fuelprices",
      priceKey: mapped.priceKey,
    });
  }
  return buildFindFuelAssumptions({
    note,
    priceSource: "labeled_fallback",
    priceKey: "regular_fallback",
  });
}

/**
 * Live (or injected-fetch) FuelEconomy match for one listing MMY.
 * Caps detail fetches; never invents a silent single pick when several options remain.
 */
export async function lookupFindFuelEvidence(
  listing: ListingFuelHints,
  opts: {
    deps: FuelEconomyDeps;
    note?: string | null;
    /** Cap EPA vehicle detail fetches per MMY. */
    maxConfigs?: number;
  },
): Promise<FindFuelEvidence> {
  const maxConfigs = opts.maxConfigs ?? 8;
  const deps = opts.deps;
  let sourceUrl: string | null = null;
  const modelNamesTried: string[] = [];

  try {
    // 1) Exact model menu
    let menu = await fetchFuelMenuOptions(listing.year, listing.make, listing.model, deps);
    sourceUrl = menu.url;
    let modelNames = [listing.model];

    if (!menu.available) {
      const baseline = buildFindFuelAssumptions({ note: opts.note, priceSource: "labeled_fallback" });
      return emptyEvidence("unavailable", baseline, {
        sourceUrl,
        reason: "FuelEconomy.gov menu request failed or timed out.",
        honesty: "Fuel cost unavailable — FuelEconomy.gov did not respond. Not invented.",
        modelNamesTried: modelNames,
      });
    }

    // 2) If empty, resolve model aliases (CR-V → CR-V AWD / CR-V FWD)
    if (menu.items.length === 0) {
      const models = await fetchFuelModelNames(listing.year, listing.make, deps);
      if (!models.available) {
        const baseline = buildFindFuelAssumptions({ note: opts.note, priceSource: "labeled_fallback" });
        return emptyEvidence("unavailable", baseline, {
          sourceUrl: models.url,
          reason: "FuelEconomy.gov model menu unavailable.",
          honesty: "Fuel cost unavailable — FuelEconomy.gov model list failed. Not invented.",
          modelNamesTried: modelNames,
        });
      }
      modelNames = resolveEpaModelNames(listing.model, models.names);
      modelNamesTried.push(...modelNames);
      if (modelNames.length === 0) {
        const baseline = buildFindFuelAssumptions({ note: opts.note, priceSource: "labeled_fallback" });
        return emptyEvidence("no_match", baseline, {
          sourceUrl: models.url,
          reason: "No FuelEconomy.gov model name matched this listing model.",
          honesty: "Fuel cost unavailable — no FuelEconomy.gov match for this year/make/model.",
          modelNamesTried,
        });
      }
      const collected: Array<{ detail: FuelVehicleDetail; optionText: string; modelName: string }> = [];
      for (const name of modelNames) {
        const sub = await fetchFuelMenuOptions(listing.year, listing.make, name, deps);
        sourceUrl = sub.url;
        for (const item of sub.items) {
          if (item.id <= 0) continue;
          collected.push({
            detail: {
              id: item.id,
              combMpg: null,
              cityMpg: null,
              highwayMpg: null,
              annualFuelCostUsd: null,
              vehicleClass: null,
              engine: null,
              transmission: null,
              drive: null,
              fuelType: null,
              make: listing.make,
              model: name,
              year: listing.year,
            },
            optionText: item.text || item.value,
            modelName: name,
          });
        }
      }
      // Fetch details
      const withDetails: Array<{ detail: FuelVehicleDetail; optionText: string; modelName: string }> = [];
      for (const row of collected.slice(0, maxConfigs)) {
        if (row.detail.id == null) continue;
        const { detail, url } = await fetchFuelVehicle(row.detail.id, deps);
        sourceUrl = url;
        if (detail) withDetails.push({ detail, optionText: row.optionText, modelName: row.modelName });
      }
      const prices = await fetchFuelPrices(deps);
      const fuelType = withDetails[0]?.detail.fuelType ?? null;
      const assumptions = priceAssumptionsFromFeed(fuelType, prices.prices, opts.note);
      return matchFuelVehicles({
        listing,
        vehicles: withDetails,
        assumptions,
        modelNamesTried,
        sourceUrl,
      });
    }

    modelNamesTried.push(listing.model);
    const withDetails: Array<{ detail: FuelVehicleDetail; optionText: string; modelName: string }> = [];
    for (const item of menu.items.slice(0, maxConfigs)) {
      if (item.id <= 0) continue;
      const { detail, url } = await fetchFuelVehicle(item.id, deps);
      sourceUrl = url;
      if (detail) {
        withDetails.push({
          detail,
          optionText: item.text || item.value,
          modelName: listing.model,
        });
      }
    }
    const prices = await fetchFuelPrices(deps);
    const fuelType = withDetails[0]?.detail.fuelType ?? null;
    const assumptions = priceAssumptionsFromFeed(fuelType, prices.prices, opts.note);
    return matchFuelVehicles({
      listing,
      vehicles: withDetails,
      assumptions,
      modelNamesTried,
      sourceUrl,
    });
  } catch {
    const baseline = buildFindFuelAssumptions({ note: opts.note, priceSource: "labeled_fallback" });
    return emptyEvidence("unavailable", baseline, {
      sourceUrl,
      reason: "FuelEconomy.gov lookup threw or timed out.",
      honesty: "Fuel cost unavailable — FuelEconomy.gov error. Not invented.",
      modelNamesTried,
    });
  }
}

/** Convert Find fuel evidence → FuelFact for compareObservedModels / ownership-cost. */
export function fuelFactFromFindEvidence(evidence: FindFuelEvidence | null | undefined): FuelFact | null {
  if (!evidence) return null;
  if (evidence.match === "no_match" || evidence.match === "unavailable") return null;
  if (evidence.annualFuelUsdLow == null && evidence.epaAnnualUsdLow == null && evidence.combMpgLow == null) {
    return null;
  }
  // Prefer Find labeled annuals (mix×price or EPA electricity annual). Mark costBasis so
  // ownership-cost does not rebrand them as raw EPA sticker dollars when they are labeled.
  const labeledLow = evidence.annualFuelUsdLow ?? evidence.epaAnnualUsdLow;
  const labeledHigh = evidence.annualFuelUsdHigh ?? evidence.epaAnnualUsdHigh;
  const costBasis: FuelFact["costBasis"] = evidence.assumptions.useEpaPublishedAnnual
    ? "epa_published"
    : "labeled_estimate";
  if (evidence.ambiguous || evidence.match === "ambiguous") {
    return {
      source: "fueleconomy.gov",
      match: "range",
      combMpg: evidence.combMpgLow === evidence.combMpgHigh ? evidence.combMpgLow : null,
      annualFuelCostUsd: null,
      annualFuelCostLowUsd: labeledLow,
      annualFuelCostHighUsd: labeledHigh,
      vehicleClass: null,
      configsConsidered: evidence.configsConsidered,
      costBasis,
    };
  }
  return {
    source: "fueleconomy.gov",
    match: "closest_config",
    combMpg: evidence.combMpgLow,
    annualFuelCostUsd: labeledLow,
    annualFuelCostLowUsd: labeledLow,
    annualFuelCostHighUsd: labeledHigh,
    vehicleClass: null,
    configsConsidered: evidence.configsConsidered,
    costBasis,
  };
}

export function formatFindFuelEvidenceShort(evidence: FindFuelEvidence): string {
  if (evidence.match === "unavailable") {
    return evidence.reason
      ? `Fuel cost unavailable — ${evidence.reason}`
      : "Fuel cost unavailable — FuelEconomy.gov did not respond";
  }
  if (evidence.match === "no_match") {
    return evidence.reason
      ? `Fuel cost unavailable — ${evidence.reason}`
      : "Fuel cost unavailable — no FuelEconomy.gov match for this year/make/model";
  }
  const assumptionsBit = ` Assumptions: ${evidence.assumptions.label}.`;
  if (
    evidence.ambiguous &&
    evidence.annualFuelUsdLow != null &&
    evidence.annualFuelUsdHigh != null &&
    evidence.annualFuelUsdLow !== evidence.annualFuelUsdHigh
  ) {
    return `Est. fuel ~$${evidence.annualFuelUsdLow.toLocaleString("en-US")}–$${evidence.annualFuelUsdHigh.toLocaleString("en-US")}/yr (range — several configs match).${assumptionsBit}`;
  }
  if (evidence.annualFuelUsdLow != null) {
    return `Est. fuel ~$${evidence.annualFuelUsdLow.toLocaleString("en-US")}/yr.${assumptionsBit}`;
  }
  if (isElectricFuelType(evidence.fuelType)) {
    return `Fuel cost unavailable — electricity annual not published.${assumptionsBit}`;
  }
  return "Fuel cost unavailable";
}
