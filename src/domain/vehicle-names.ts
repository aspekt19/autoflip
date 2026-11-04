/** Spellings Auto.dev accepts on vehicle.make. vPIC often returns the uppercase form. */
const MAKE_ALIASES: Record<string, string> = {
  BMW: "BMW",
  GMC: "GMC",
  MINI: "MINI",
  FIAT: "FIAT",
  "MERCEDES-BENZ": "Mercedes-Benz",
  "MERCEDES BENZ": "Mercedes-Benz",
  "ALFA ROMEO": "Alfa Romeo",
  "LAND ROVER": "Land Rover",
  "ASTON MARTIN": "Aston Martin",
  RAM: "Ram",
};

/**
 * Makes a US used-car shopper actually searches.
 * vPIC's car/MPV lists also include kit builders, buses, and one-off replicas.
 * Spellings match Auto.dev's vehicle.make parameter.
 */
export const MAINSTREAM_MAKES = [
  "Acura",
  "Alfa Romeo",
  "Audi",
  "BMW",
  "Buick",
  "Cadillac",
  "Chevrolet",
  "Chrysler",
  "Dodge",
  "FIAT",
  "Ford",
  "Genesis",
  "GMC",
  "Honda",
  "Hummer",
  "Hyundai",
  "Infiniti",
  "Jaguar",
  "Jeep",
  "Kia",
  "Land Rover",
  "Lexus",
  "Lincoln",
  "Mazda",
  "Mercedes-Benz",
  "Mercury",
  "MINI",
  "Mitsubishi",
  "Nissan",
  "Polestar",
  "Pontiac",
  "Porsche",
  "Ram",
  "Rivian",
  "Saab",
  "Saturn",
  "Scion",
  "Subaru",
  "Tesla",
  "Toyota",
  "Volkswagen",
  "Volvo",
] as const;

/** Same list. Kept so a catalog miss still offers real makes, not the raw vPIC dump. */
export const FALLBACK_MAKES = MAINSTREAM_MAKES;

export function mainstreamMakes(): string[] {
  return [...MAINSTREAM_MAKES].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
}

/** Common models, same role: a fallback, not a live market feed. */
export const FALLBACK_MODELS: Record<string, string[]> = {
  Toyota: ["Camry", "Corolla", "RAV4", "Highlander", "Tacoma", "Prius", "4Runner"],
  Honda: ["Accord", "Civic", "CR-V", "Pilot", "Odyssey", "HR-V"],
  Ford: ["F-150", "Escape", "Explorer", "Mustang", "Edge", "Fusion"],
  Chevrolet: ["Silverado", "Equinox", "Malibu", "Tahoe", "Traverse", "Camaro"],
  Nissan: ["Altima", "Rogue", "Sentra", "Pathfinder", "Murano"],
  Hyundai: ["Elantra", "Sonata", "Tucson", "Santa Fe"],
  Kia: ["Forte", "Optima", "Sorento", "Sportage", "Soul"],
  Jeep: ["Wrangler", "Grand Cherokee", "Cherokee", "Compass"],
  Subaru: ["Outback", "Forester", "Crosstrek", "Impreza"],
  "Mercedes-Benz": ["C-Class", "E-Class", "GLC", "GLE"],
  BMW: ["3 Series", "5 Series", "X3", "X5"],
};

const MODEL_ALIASES: Record<string, string> = {
  rav4: "RAV4",
  "rav4 prime (phev)": "RAV4 Prime (PHEV)",
  "cr-v": "CR-V",
  "hr-v": "HR-V",
  "f-150": "F-150",
  "f-250": "F-250",
  "f-350": "F-350",
  "cx-5": "CX-5",
  "cx-30": "CX-30",
  "cx-9": "CX-9",
  "cx-50": "CX-50",
  "mx-5": "MX-5",
  "c-hr": "C-HR",
  "bz4x": "bZ4X",
};

export function autoDevMake(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  const key = trimmed.toUpperCase();
  if (MAKE_ALIASES[key]) return MAKE_ALIASES[key];
  return trimmed
    .split(/([\s-])/)
    .map((part) => {
      if (part === " " || part === "-") return part;
      if (MAKE_ALIASES[part.toUpperCase()]) return MAKE_ALIASES[part.toUpperCase()]!;
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join("");
}

export function autoDevModel(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  const alias = MODEL_ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;
  return trimmed
    .split(" ")
    .map((word) => formatModelWord(word))
    .join(" ");
}

function formatModelWord(word: string): string {
  if (word.includes("-")) return word.split("-").map((part) => formatModelWord(part)).join("-");
  if (/\d/.test(word)) return word.toUpperCase();
  if (word.length <= 3 && word === word.toUpperCase()) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

export function matchKnown(value: string, options: readonly string[]): string {
  const wanted = value.trim().toLowerCase();
  return options.find((option) => option.toLowerCase() === wanted) ?? "";
}

export function parseVpicMakes(payload: unknown): string[] {
  return uniqueNames(payload, ["MakeName", "Make_Name"]).map(autoDevMake).filter(Boolean);
}

export function parseVpicModels(payload: unknown): string[] {
  return uniqueNames(payload, ["Model_Name", "ModelName"]).map(autoDevModel).filter(Boolean);
}

function uniqueNames(payload: unknown, keys: string[]): string[] {
  if (!payload || typeof payload !== "object") return [];
  const results = (payload as { Results?: unknown }).Results;
  if (!Array.isArray(results)) return [];
  const names: string[] = [];
  for (const row of results) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === "string" && record[key].trim()) {
        names.push(record[key].trim());
        break;
      }
    }
  }
  return [...new Set(names.map((name) => name.toLowerCase()))].map(
    (lower) => names.find((name) => name.toLowerCase() === lower) ?? lower,
  );
}

/** Newest year a shopper can pick. Current calendar year + 1, never further, even if vPIC answers for later years. */
export function maxModelYear(now = new Date()): number {
  return now.getUTCFullYear() + 1;
}

export function yearChoices(now = new Date()): number[] {
  const end = maxModelYear(now);
  const years: number[] = [];
  for (let year = end; year >= 1995; year -= 1) years.push(year);
  return years;
}

const NON_PASSENGER =
  /\b(chassis|cutaway|incomplete|motorhome|motor home|trailers?|hearse|buses?|motorcycles?|scooters?|chopper|glider|stripped|recreational vehicle|military|foldaway|street bikes?|dual sport|bomber|warhawk|fortress|king cobra|fabrication|manufacturing|welding|enterprises|industries|radiator|mfg|l\.?l\.?c\.?|inc|low cab|forward control|heavy conventional|hi-?cube|truck forward|supply|steel|overland|built|frames|cycles|africa twin|gold ?wing|grom|rebel|cbr\d*|crf\d*|trx\d*|atv|utv|rancher|foreman|rubicon|pioneer|talon|rincon|fourtrax|nighthawk|valkyrie|interceptor|monkey|super cub|pcx|side[- ]by[- ]side)\b/i;

/** Drop chassis codes, trailer shops, and buses that vPIC files under a real make. */
export function isPassengerModel(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed || /^[^a-z0-9]/i.test(trimmed)) return false;
  if (trimmed.split(/\s+/).length > 3) return false;
  if (NON_PASSENGER.test(trimmed)) return false;
  if (isCommercialCode(trimmed)) return false;
  return true;
}

function isCommercialCode(name: string): boolean {
  if (/^(F)-(100|150|250|350|450)$/i.test(name)) return false;
  if (/^(E)-(100|150|250|350)$/i.test(name)) return false;
  if (/^(1500|2500|3500)$/.test(name)) return false;
  if (/^\d{1,3}$/.test(name)) return false;
  const compact = name.replace(/[\s-]/g, "");
  if (/^[A-Z]{1,4}\d{3,}[A-Z]{0,3}$/i.test(compact)) return true;
  if (/^\d{4,}[A-Z]{0,3}$/i.test(compact)) return true;
  if (/^\d{4,}$/.test(name)) return true;
  return false;
}
