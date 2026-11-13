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

/**
 * Powertrain identity used to match FuelEconomy.gov options.
 * Built from ALL merged evidence — never FuelTypePrimary alone (hybrids often say Gasoline).
 */
export type PowertrainKind = "gas" | "diesel" | "hev" | "phev" | "ev" | "hydrogen" | "unknown" | "conflict";

export type ListingFuelHints = {
  year: number;
  make: string;
  model: string;
  trim?: string | null;
  engine?: string | null;
  drivetrain?: string | null;
  /** FuelTypePrimary from vPIC / listing — insufficient alone for hybrids. */
  fuelType?: string | null;
  fuelTypeSecondary?: string | null;
  electrificationLevel?: string | null;
  /** Listing/page title when known (may contain "Hybrid"). */
  title?: string | null;
  /**
   * When true (vPIC / merged evidence published drive or powertrain), a filter miss is
   * unknown — never fall back to an incompatible sibling config.
   */
  strictVpicMatch?: boolean;
};

const HYBRID_TEXT_RE =
  /\b(hybrid|hev|strong\s*hybrid|mild\s*hybrid|full\s*hybrid)\b/i;
const PHEV_TEXT_RE = /\b(phev|plug[\s-]?in(\s*hybrid)?|prime)\b/i;
/** Pure BEV tokens — not "Hybrid Electric Vehicle" (that is HEV). */
const EV_TEXT_RE =
  /\b(b\.?e\.?v\.?|battery\s*electric|\bev\b|e-?tron)\b/i;
const DIESEL_TEXT_RE = /\bdiesel\b/i;
const HYDROGEN_TEXT_RE = /\b(hydrogen|fuel\s*cell)\b/i;

function blobHas(re: RegExp, ...parts: Array<string | null | undefined>): boolean {
  return re.test(parts.filter(Boolean).join(" "));
}

/**
 * Infer powertrain from merged vPIC + listing evidence.
 * FuelTypePrimary "Gasoline" alone is NOT enough to call a car gas when
 * ElectrificationLevel / FuelTypeSecondary / trim / title say hybrid.
 */
export function inferPowertrainKind(evidence: {
  fuelTypePrimary?: string | null;
  fuelTypeSecondary?: string | null;
  electrificationLevel?: string | null;
  model?: string | null;
  trim?: string | null;
  title?: string | null;
  engine?: string | null;
}): PowertrainKind {
  const primary = evidence.fuelTypePrimary ?? "";
  const secondary = evidence.fuelTypeSecondary ?? "";
  const elec = evidence.electrificationLevel ?? "";
  const textBits = [evidence.model, evidence.trim, evidence.title, evidence.engine, elec, primary, secondary];
  const joined = textBits.filter(Boolean).join(" ");

  // ElectrificationLevel is authoritative when published.
  if (/plug/i.test(elec) || /\bphev\b/i.test(elec)) return "phev";
  if (/\bhev\b|hybrid/i.test(elec)) return "hev";
  if (/\bbev\b|battery/i.test(elec)) return "ev";

  if (blobHas(PHEV_TEXT_RE, ...textBits)) return "phev";
  if (blobHas(HYBRID_TEXT_RE, ...textBits) || /electric/i.test(secondary)) return "hev";
  if (blobHas(HYDROGEN_TEXT_RE, ...textBits)) return "hydrogen";
  if (
    blobHas(EV_TEXT_RE, ...textBits) ||
    (/^electric/i.test(primary.trim()) && !secondary && !/hybrid/i.test(joined))
  ) {
    return "ev";
  }
  if (blobHas(DIESEL_TEXT_RE, primary, evidence.engine, evidence.model, evidence.trim)) {
    return "diesel";
  }
  // Model-name EV cues (Model 3 / Leaf / etc.) when no fuel primary was published.
  if (!primary && blobHas(/\b(model\s*[sxy3]|leaf|bolt\s*ev|ioniq\s*5|mach-?e)\b/i, evidence.model, evidence.title)) {
    return "ev";
  }
  if (/\bgas(oline)?\b/i.test(primary) || /regular/i.test(primary)) return "gas";
  // No primary fuel and no electrification cues → unknown (soft year/make/model path).
  return "unknown";
}

/** Classify a FuelEconomy.gov option from its fuelType1 + model/option text. */
export function powertrainKindFromEpa(input: {
  fuelType?: string | null;
  modelName?: string | null;
  optionText?: string | null;
}): PowertrainKind {
  const fuel = input.fuelType ?? "";
  const bits = [input.modelName, input.optionText, fuel];
  if (blobHas(HYDROGEN_TEXT_RE, ...bits)) return "hydrogen";
  if (blobHas(PHEV_TEXT_RE, ...bits) || /plug/i.test(fuel)) return "phev";
  if (
    blobHas(HYBRID_TEXT_RE, ...bits) ||
    (/electric/i.test(fuel) && /gas/i.test(fuel)) ||
    (/electricity/i.test(fuel) && /gas/i.test(fuel))
  ) {
    return "hev";
  }
  if (isElectricFuelType(fuel) || blobHas(EV_TEXT_RE, ...bits)) return "ev";
  if (blobHas(DIESEL_TEXT_RE, fuel, input.optionText)) return "diesel";
  if (/\bgas(oline)?\b|regular/i.test(fuel) || fuel) return "gas";
  return "unknown";
}

export function powertrainKindsAgree(want: PowertrainKind, got: PowertrainKind): boolean {
  if (want === "unknown" || want === "conflict") return false;
  if (got === "unknown") return false;
  return want === got;
}

function normalizeToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function finitePositive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
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
  const cityHeavy = false;
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

/** Match FuelEconomy fuelType1 against vPIC/listing fuel (hybrid vs gas vs electric). */
export function fuelTypeHintMatches(
  vehicleFuelType: string | null | undefined,
  hint: string | null | undefined,
): boolean {
  if (!hint || !vehicleFuelType) return true;
  const h = hint.toLowerCase();
  const v = vehicleFuelType.toLowerCase();
  const hintHybrid = /\bhybrid|phev|plug[\s-]?in|electric.*gas|gas.*electric\b/i.test(h);
  const hintElectric = isElectricFuelType(hint) && !hintHybrid;
  const hintDiesel = /\bdiesel\b/i.test(h);
  const vehHybrid = /\bhybrid|phev|plug[\s-]?in\b/i.test(v) || (v.includes("electric") && v.includes("gas"));
  const vehElectric = isElectricFuelType(vehicleFuelType) && !vehHybrid;
  const vehDiesel = /\bdiesel\b/i.test(v);
  if (hintHybrid) return vehHybrid;
  if (hintElectric) return vehElectric;
  if (hintDiesel) return vehDiesel;
  // Ordinary gas: reject hybrid/EV/diesel siblings when the hint is plain gasoline.
  if (/\bgas(oline)?\b/i.test(h) || h === "gas") {
    return !vehHybrid && !vehElectric && !vehDiesel;
  }
  return true;
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
 * Powertrain identity comes from ALL merged evidence (vPIC electrification + listing
 * title/trim), never FuelTypePrimary alone. Options must agree on powertrain AND
 * drivetrain; conflict or several survivors → unknown (never guess).
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

  const want = inferPowertrainKind({
    fuelTypePrimary: input.listing.fuelType,
    fuelTypeSecondary: input.listing.fuelTypeSecondary,
    electrificationLevel: input.listing.electrificationLevel,
    model: input.listing.model,
    trim: input.listing.trim,
    title: input.listing.title,
    engine: input.listing.engine,
  });

  // Conflicting evidence → never guess a figure.
  if (want === "conflict") {
    return emptyEvidence("no_match", input.assumptions, {
      modelNamesTried: input.modelNamesTried,
      sourceUrl: input.sourceUrl,
      reason: "Merged powertrain evidence conflicts — fuel economy left unknown.",
      honesty:
        "Fuel cost unavailable — vPIC/listing powertrain signals conflict. Lemonless does not guess MPG.",
    });
  }

  const electrifiedWant = want === "hev" || want === "phev" || want === "ev" || want === "hydrogen";
  const hasPowertrainEvidence = want !== "unknown";
  const strict =
    Boolean(input.listing.strictVpicMatch) ||
    electrifiedWant ||
    Boolean(input.listing.drivetrain?.trim()) ||
    Boolean(input.listing.electrificationLevel?.trim()) ||
    Boolean(input.listing.fuelTypeSecondary?.trim());

  // Soft legacy path: no powertrain/drive evidence → year/make/model + optional engine/trim.
  if (!hasPowertrainEvidence && !input.listing.drivetrain?.trim() && !strict) {
    const allowAlt = listingModelRequestsAltPowertrain(input.listing.model);
    const isAltVehicle = (v: { detail: { fuelType: string | null }; modelName: string }) =>
      isAltPowertrainFuelType(v.detail.fuelType) || ALT_POWERTRAIN_RE.test(v.modelName);
    const hasOrdinarySibling = input.vehicles.some((v) => !isAltVehicle(v));
    let pool = input.vehicles.filter((v) => {
      if (!allowAlt && hasOrdinarySibling && isAltVehicle(v)) return false;
      return true;
    });
    if (pool.length === 0) pool = input.vehicles;
    const engineNarrowed = pool.filter((v) =>
      engineHintMatches(v.detail, v.optionText, input.listing.engine),
    );
    if (engineNarrowed.length > 0) pool = engineNarrowed;
    const trimNarrowed = pool.filter((v) =>
      trimHintMatches(v.optionText, v.modelName, input.listing.trim),
    );
    if (trimNarrowed.length > 0) pool = trimNarrowed;
    return summarizeVehicles(pool, input.assumptions, input.modelNamesTried, input.sourceUrl);
  }

  const filtered = input.vehicles.filter((v) => {
    const got = powertrainKindFromEpa({
      fuelType: v.detail.fuelType,
      modelName: v.modelName,
      optionText: v.optionText,
    });
    // Any electrified evidence rejects plain gas/diesel siblings.
    if (electrifiedWant && (got === "gas" || got === "diesel")) return false;
    if (hasPowertrainEvidence && !powertrainKindsAgree(want, got)) return false;
    if (!driveHintMatches(v.detail.drive, input.listing.drivetrain)) return false;
    if (!engineHintMatches(v.detail, v.optionText, input.listing.engine)) return false;
    return true;
  });
  // Trim is package-level (e.g. Limited) and often absent from EPA option text —
  // only refine when at least one survivor mentions the trim.
  const trimFiltered = filtered.filter((v) =>
    trimHintMatches(v.optionText, v.modelName, input.listing.trim),
  );
  const survivors = trimFiltered.length > 0 ? trimFiltered : filtered;

  if (survivors.length === 0) {
    return emptyEvidence("no_match", input.assumptions, {
      modelNamesTried: input.modelNamesTried,
      sourceUrl: input.sourceUrl,
      reason:
        "FuelEconomy.gov had no configuration matching the merged powertrain type and drivetrain — MPG left unknown.",
      honesty:
        "Fuel cost unavailable — FuelEconomy.gov configs did not match vPIC/listing powertrain + drivetrain. Lemonless does not guess MPG.",
    });
  }

  // Several survivors with distinct powertrains or MPG → unknown (never silent pick).
  const evidence = summarizeVehicles(survivors, input.assumptions, input.modelNamesTried, input.sourceUrl);
  if (survivors.length > 1 && evidence.match === "ambiguous") {
    return {
      ...evidence,
      reason:
        evidence.reason ??
        "Several FuelEconomy.gov configurations remain after powertrain/drivetrain filter — showing a range, not a guessed single figure.",
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

/** When powertrain is electrified, also try "Model Hybrid" / "Model PHEV" EPA menu keys. */
export function electrifiedEpaModelCandidates(listing: ListingFuelHints, want: PowertrainKind): string[] {
  const base = listing.model.trim();
  if (!base) return [];
  if (want === "hev" || want === "phev") {
    const out = [base];
    if (!/\bhybrid\b/i.test(base)) out.push(`${base} Hybrid`);
    if (want === "phev" && !/\b(phev|plug|prime)\b/i.test(base)) {
      out.push(`${base} Plug-in Hybrid`, `${base} Prime`);
    }
    return out;
  }
  if (want === "ev" && !/\bev\b|electric/i.test(base)) {
    return [base, `${base} Electric`, `${base} EV`];
  }
  return [base];
}

/**
 * Live (or injected-fetch) FuelEconomy match for one listing MMY.
 * Caps detail fetches; never invents a silent single pick when several options remain.
 * Electrified powertrains also query Hybrid/PHEV/EV menu names — base "RAV4" alone
 * would only return gas options.
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
  const want = inferPowertrainKind({
    fuelTypePrimary: listing.fuelType,
    fuelTypeSecondary: listing.fuelTypeSecondary,
    electrificationLevel: listing.electrificationLevel,
    model: listing.model,
    trim: listing.trim,
    title: listing.title,
    engine: listing.engine,
  });

  try {
    const candidateNames = electrifiedEpaModelCandidates(listing, want);
    // 1) Exact model menu (+ hybrid/PHEV/EV siblings when powertrain evidence says so)
    const collected: Array<{ detail: FuelVehicleDetail; optionText: string; modelName: string }> = [];
    let anyMenuAvailable = false;

    for (const name of candidateNames) {
      const menu = await fetchFuelMenuOptions(listing.year, listing.make, name, deps);
      sourceUrl = menu.url;
      modelNamesTried.push(name);
      if (!menu.available) continue;
      anyMenuAvailable = true;
      for (const item of menu.items) {
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

    if (!anyMenuAvailable) {
      const baseline = buildFindFuelAssumptions({ note: opts.note, priceSource: "labeled_fallback" });
      return emptyEvidence("unavailable", baseline, {
        sourceUrl,
        reason: "FuelEconomy.gov menu request failed or timed out.",
        honesty: "Fuel cost unavailable — FuelEconomy.gov did not respond. Not invented.",
        modelNamesTried,
      });
    }

    // 2) If still empty, resolve model aliases from the make menu (CR-V → CR-V AWD / Hybrid)
    if (collected.length === 0) {
      const models = await fetchFuelModelNames(listing.year, listing.make, deps);
      if (!models.available) {
        const baseline = buildFindFuelAssumptions({ note: opts.note, priceSource: "labeled_fallback" });
        return emptyEvidence("unavailable", baseline, {
          sourceUrl: models.url,
          reason: "FuelEconomy.gov model menu unavailable.",
          honesty: "Fuel cost unavailable — FuelEconomy.gov model list failed. Not invented.",
          modelNamesTried,
        });
      }
      // Prefer electrified aliases when powertrain evidence says hybrid/EV.
      const resolved = resolveEpaModelNames(
        want === "hev" || want === "phev"
          ? listingModelRequestsAltPowertrain(listing.model)
            ? listing.model
            : `${listing.model} Hybrid`
          : listing.model,
        models.names,
      );
      // Also include plain resolve of the base model so AWD gas siblings stay visible for filtering.
      const baseResolved = resolveEpaModelNames(listing.model, models.names);
      const modelNames = [...new Set([...resolved, ...baseResolved])];
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
    }

    const withDetails: Array<{ detail: FuelVehicleDetail; optionText: string; modelName: string }> = [];
    // Prefer hybrid/PHEV menu rows first when that is the wanted powertrain so maxConfigs
    // does not fill only with gas siblings.
    const ordered = [...collected].sort((a, b) => {
      const score = (name: string) => {
        if (want === "hev" || want === "phev") return /\bhybrid|phev|prime|plug/i.test(name) ? 0 : 1;
        if (want === "ev") return /\belectric|\bev\b/i.test(name) ? 0 : 1;
        return 0;
      };
      return score(a.modelName) - score(b.modelName);
    });
    for (const row of ordered.slice(0, maxConfigs)) {
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
