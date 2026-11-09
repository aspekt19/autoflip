/**
 * Buyer labels for cars that share a year, make, and model.
 * One short distinguisher: trim, then price, then city, then dealer, then miles.
 */

export type CarLabelInput = {
  key: string;
  year: number;
  make: string;
  model: string;
  trim?: string | null;
  priceUsd?: number | null;
  city?: string | null;
  state?: string | null;
  dealer?: string | null;
  miles?: number | null;
};

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text : null;
}

function identity(car: CarLabelInput): string {
  return `${car.year}|${car.make}|${car.model}`.toLowerCase().replace(/\s+/g, " ").trim();
}

function same(siblings: readonly CarLabelInput[], valueOf: (car: CarLabelInput) => string): boolean {
  const first = valueOf(siblings[0]!);
  return siblings.every((car) => valueOf(car) === first);
}

function placeOf(car: CarLabelInput): string {
  return [clean(car.city), clean(car.state)].filter(Boolean).join(", ");
}

/** Short parenthetical so two identical model-year names are not the same car. */
function distinguisher(car: CarLabelInput, siblings: readonly CarLabelInput[]): string | null {
  const trim = clean(car.trim);
  if (trim && !same(siblings, (row) => clean(row.trim)?.toLowerCase() ?? "")) return trim;
  if (
    typeof car.priceUsd === "number" &&
    Number.isFinite(car.priceUsd) &&
    !same(siblings, (row) => (typeof row.priceUsd === "number" ? String(row.priceUsd) : ""))
  ) {
    return `$${car.priceUsd.toLocaleString("en-US")}`;
  }
  const place = placeOf(car);
  if (place && !same(siblings, placeOf)) return place;
  const dealer = clean(car.dealer);
  if (dealer && !same(siblings, (row) => clean(row.dealer)?.toLowerCase() ?? "")) {
    return dealer.length > 28 ? `${dealer.slice(0, 25).trimEnd()}…` : dealer;
  }
  if (
    typeof car.miles === "number" &&
    Number.isFinite(car.miles) &&
    !same(siblings, (row) => (typeof row.miles === "number" ? String(row.miles) : ""))
  ) {
    return `${car.miles.toLocaleString("en-US")} mi`;
  }
  return null;
}

/** Map of car key → buyer label. Unique model-years stay "year make model". */
export function buyerCarLabels(cars: readonly CarLabelInput[]): Map<string, string> {
  const groups = new Map<string, CarLabelInput[]>();
  for (const car of cars) {
    const id = identity(car);
    const list = groups.get(id) ?? [];
    list.push(car);
    groups.set(id, list);
  }
  const out = new Map<string, string>();
  for (const car of cars) {
    const base = `${car.year} ${car.make} ${car.model}`;
    const siblings = groups.get(identity(car)) ?? [car];
    if (siblings.length < 2) {
      out.set(car.key, base);
      continue;
    }
    const detail = distinguisher(car, siblings);
    out.set(car.key, detail ? `${base} (${detail})` : base);
  }
  for (const siblings of groups.values()) {
    if (siblings.length < 2) continue;
    const counts = new Map<string, number>();
    for (const car of siblings) {
      const text = out.get(car.key) ?? "";
      counts.set(text, (counts.get(text) ?? 0) + 1);
    }
    const seen = new Map<string, number>();
    for (const car of siblings) {
      const text = out.get(car.key) ?? "";
      if ((counts.get(text) ?? 0) < 2) continue;
      const n = (seen.get(text) ?? 0) + 1;
      seen.set(text, n);
      out.set(car.key, `${text} (listing ${n})`);
    }
  }
  return out;
}
