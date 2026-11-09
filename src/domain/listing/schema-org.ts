/**
 * Map schema.org URLs / @type tokens to plain English for listing extraction.
 */

const DRIVETRAIN: Record<string, string> = {
  frontwheeldriveconfiguration: "FWD",
  frontwheeldriveconfig: "FWD",
  rearwheeldriveconfiguration: "RWD",
  rearwheeldriveconfig: "RWD",
  fourwheeldriveconfiguration: "4WD",
  fourwheeldriveconfig: "4WD",
  allwheeldriveconfiguration: "AWD",
  allwheeldriveconfig: "AWD",
};

const AVAILABILITY: Record<string, string> = {
  soldout: "SOLD",
  outofstock: "SOLD",
  discontinued: "SOLD",
  instock: "In stock",
  limitedavailability: "Limited availability",
  onlineonly: "Online only",
  instoreonly: "In store only",
  presale: "Pre-sale",
};

const FUEL: Record<string, string> = {
  gasoline: "Gasoline",
  petrol: "Gasoline",
  diesel: "Diesel",
  hybrid: "Hybrid",
  electric: "Electric",
  pluginexlectric: "Plug-in hybrid",
  pluginhybrid: "Plug-in hybrid",
  hydrogen: "Hydrogen",
  e85: "E85",
};

function schemaToken(raw: string): string {
  return raw
    .replace(/^https?:\/\/schema\.org\//i, "")
    .replace(/^schema:/i, "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toLowerCase();
}

/** Resolve a schema.org string, URL, or {@id/@type} object to a plain token. */
export function schemaOrgPlainValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    const trimmed = value.trim();
    const token = schemaToken(trimmed);
    if (DRIVETRAIN[token]) return DRIVETRAIN[token]!;
    if (AVAILABILITY[token]) return AVAILABILITY[token]!;
    if (FUEL[token]) return FUEL[token]!;
    // Bare already-plain words
    if (/^(FWD|RWD|AWD|4WD|SOLD)$/i.test(trimmed)) return trimmed.toUpperCase() === "SOLD" ? "SOLD" : trimmed.toUpperCase();
    if (/^https?:\/\//i.test(trimmed)) {
      // Unknown schema URL — drop rather than show the URL to buyers
      return null;
    }
    return trimmed;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return (
      schemaOrgPlainValue(record["@id"]) ??
      schemaOrgPlainValue(record.name) ??
      schemaOrgPlainValue(record["@type"]) ??
      schemaOrgPlainValue(record["@value"])
    );
  }
  return null;
}

export function normalizeDrivetrain(value: unknown): string | null {
  const plain = schemaOrgPlainValue(value);
  if (!plain) return null;
  const token = schemaToken(plain);
  return DRIVETRAIN[token] ?? (/^(FWD|RWD|AWD|4WD)$/i.test(plain) ? plain.toUpperCase() : plain);
}

export function normalizeAvailability(value: unknown): string | null {
  const plain = schemaOrgPlainValue(value);
  if (!plain) return null;
  const token = schemaToken(plain);
  return AVAILABILITY[token] ?? plain;
}

export function normalizeFuelLabel(value: unknown): string | null {
  const plain = schemaOrgPlainValue(value);
  if (!plain) return null;
  const token = schemaToken(plain);
  return FUEL[token] ?? plain;
}

export function isSoldAvailability(value: string | null | undefined): boolean {
  if (!value) return false;
  const token = schemaToken(value);
  if (token === "sold" || token === "soldout" || token === "outofstock" || token === "discontinued") return true;
  return /\bSOLD\b/i.test(value) && !/not sold|unsold/i.test(value);
}

/**
 * Reject page-chrome fragments that look like dealer names but aren't.
 */
export function isPlausibleSellerName(name: string | null | undefined): boolean {
  if (!name) return false;
  const t = name.replace(/\s+/g, " ").trim();
  if (t.length < 3 || t.length > 80) return false;
  if (/^https?:\/\//i.test(t)) return false;
  if (/\b(why trust|ship why|click here|add to cart|financing available|get pre-?qualified|apply now|menu|search|sign in|log in)\b/i.test(t)) {
    return false;
  }
  // Leading junk from broken HTML concatenation
  if (/^(ship|buy|shop|see|view|learn|read)\b/i.test(t) && /\bwhy\b/i.test(t)) return false;
  if (/^[0-9$]+$/.test(t)) return false;
  return true;
}

/** Prefer government/decode fuel over page claim when they conflict. */
export function fuelConflictNote(listingFuel: string | null, decodeFuel: string | null): string | null {
  if (!listingFuel || !decodeFuel) return null;
  const a = listingFuel.toLowerCase();
  const b = decodeFuel.toLowerCase();
  const listingHybrid = /\bhybrid|electric|plug-?in|phev|ev\b/.test(a);
  const decodeHybrid = /\bhybrid|electric|plug-?in|phev|ev|electricity\b/.test(b);
  const listingGas = /\bgas|gasoline|petrol|diesel\b/.test(a);
  const decodeGas = /\bgas|gasoline|petrol|diesel|regular|premium\b/.test(b);
  if ((listingHybrid && decodeGas && !decodeHybrid) || (listingGas && decodeHybrid && !listingHybrid)) {
    return `Listing fuel “${listingFuel}” conflicts with the VIN decoder fuel “${decodeFuel}”. Using the VIN decoder value.`;
  }
  if (a !== b && !b.includes(a) && !a.includes(b.split(/\s+/)[0] ?? a)) {
    // Soft conflict for other mismatches
    if (listingHybrid !== decodeHybrid) {
      return `Listing fuel “${listingFuel}” conflicts with the VIN decoder fuel “${decodeFuel}”. Using the VIN decoder value.`;
    }
  }
  return null;
}
