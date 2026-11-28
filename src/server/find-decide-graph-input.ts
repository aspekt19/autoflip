/**
 * Run input for the Find decide graph (gr_3d039bd8de63381a), built in code in the graph's own
 * input schema (src/server/serv/find-decide-graph-input.schema.json, copied from the console).
 *
 * The console: "Matching the shape below runs it as-is; anything else is mapped onto it before the
 * run starts." Sending our `{ facts }` object made the platform's input mapper rebuild
 * `evidence_records` with a model call, and it failed 7 of 8 times (missing records or non-string
 * content), before any graph step ran. This mapping is deterministic and validated locally first,
 * so no mapping call is made. Nothing is dropped: the guardrail rules and the code-ranked key go
 * into `shopper_requirements` as data; unknown values stay null.
 */
import type { StructuredNeed } from "@/domain/need";
import type { FindDecideFactSheet } from "@/server/find-decide-serv";
import schema from "@/server/serv/find-decide-graph-input.schema.json";
import schemaV3 from "@/server/serv/find-decide-graph-input-v3.schema.json";

export const FIND_DECIDE_GRAPH_INPUT_SCHEMA = schema;

export type FindDecideGraphCar = {
  key: string;
  asking_price: string | null;
  miles: string | null;
  drivetrain: string | null;
  reported_accidents: string | null;
  owners: string | null;
  fair_value: string | null;
  fair_range: string | null;
  similar_cars_compared: number | null;
  open_recalls: string | null;
  public_record_results: string | null;
  listing_text: string | null;
};

export type FindDecideGraphInput = {
  shopper_requirements: string;
  permitted_car_keys: string[];
  cars: FindDecideGraphCar[];
  evidence_records: Array<{ id: string; content: string }>;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const usd = (v: unknown): string | null => {
  const n = num(v);
  return n == null ? null : `$${Math.round(n).toLocaleString("en-US")}`;
};
const count = (v: unknown): string | null => {
  const n = num(v);
  return n == null ? null : Math.round(n).toLocaleString("en-US");
};

type Row = FindDecideFactSheet[number];

function carLabel(row: Row): string {
  return [row.year, row.make, row.model].filter((v) => v != null && String(v).trim()).join(" ");
}

function recallsText(row: Row): string | null {
  if (row.recallsAvailable !== true) return null;
  if (row.openParkIt) return "Open recall says do not drive (park it).";
  if (row.openParkOutside) return "Open recall says park outside.";
  return "No open do-not-drive or park-outside recall found.";
}

function publicRecordsText(row: Row): string | null {
  const parts = row.freeGov
    .map((g) => `${g.checkId}: ${g.status}${g.summary ? ` — ${g.summary}` : ""}`.trim())
    .filter(Boolean);
  return parts.length ? parts.join(" | ").slice(0, 1500) : null;
}

function fairRange(row: Row): string | null {
  const low = usd(row.fairRangeLowUsd);
  const high = usd(row.fairRangeHighUsd);
  return low && high ? `${low} to ${high}` : null;
}

function listingText(row: Row): string | null {
  const bits: string[] = [];
  const label = carLabel(row);
  if (label) bits.push(label);
  if (row.fuel) bits.push(`fuel ${row.fuel}`);
  if (row.cpo === true) bits.push("certified pre-owned");
  if (row.drivetrainConfirmedAwd) bits.push("all-wheel drive confirmed");
  const factors = row.factors.map((f) => f.detail).filter((d): d is string => typeof d === "string" && d.trim() !== "");
  if (factors.length) bits.push(`our notes: ${factors.join("; ")}`);
  return bits.length ? bits.join("; ").slice(0, 1500) : null;
}

function evidenceContent(id: string, rows: Map<string, Row>): string {
  const [kind, ...rest] = id.split(":");
  const key = rest.join(":");
  const row = rows.get(key);
  if (row) {
    const label = carLabel(row) || key;
    switch (kind) {
      case "car": {
        const facts = [
          label,
          count(row.miles) ? `${count(row.miles)} miles` : "miles unknown",
          row.drivetrain ? `drivetrain ${row.drivetrain}` : "drivetrain unknown",
          row.accidentCountReported != null ? `${row.accidentCountReported} reported accidents` : "accident history unknown",
          row.ownerCount != null ? `${row.ownerCount} owners` : "owner count unknown",
        ];
        return `${facts.join("; ")}.`;
      }
      case "ask":
        return usd(row.askUsd) ? `${label} asks ${usd(row.askUsd)}.` : `${label}: asking price unknown.`;
      case "fair":
        return usd(row.fairValueUsd)
          ? `${label}: fair value ${usd(row.fairValueUsd)}${fairRange(row) ? `, fair range ${fairRange(row)}` : ""}.`
          : `${label}: no fair value; the price could not be compared with enough similar cars.`;
      case "comps":
        return num(row.compCount) != null
          ? `${label}: ${row.compCount} similar cars compared for the fair value.`
          : `${label}: number of similar cars compared unknown.`;
    }
  }
  for (const r of rows.values()) {
    const g = r.freeGov.find((x) => x.evidenceId === id);
    if (g) return `${carLabel(r)} public record ${g.checkId}: ${g.status}${g.summary ? ` — ${g.summary}` : ""}`.slice(0, 1500);
  }
  return `Evidence ${id}.`;
}

function shopperText(input: {
  need: StructuredNeed;
  codeRankedKey: string | null;
  guardrailRules: readonly string[];
}): string {
  const n = input.need;
  const lines: string[] = [];
  lines.push(`Shopper request: ${n.note?.trim() || "not given"}.`);
  lines.push(`Budget: ${n.budgetUsd != null ? usd(n.budgetUsd) : "not given"}.`);
  if (n.yearMin != null || n.yearMax != null) lines.push(`Model years: ${n.yearMin ?? "any"} to ${n.yearMax ?? "any"}.`);
  if (n.milesMax != null) lines.push(`Most miles: ${count(n.milesMax)}.`);
  if (n.mustHaves?.length) lines.push(`Must-haves: ${n.mustHaves.join(", ")}.`);
  if (n.priorities?.length) lines.push(`Priorities: ${n.priorities.join(", ")}.`);
  lines.push(`Needs all-wheel drive: ${n.awdPreference === true ? "yes" : "not stated"}.`);
  if (input.codeRankedKey) lines.push(`Our software ranked ${input.codeRankedKey} first; that is a hint, not an answer.`);
  if (input.guardrailRules.length) {
    lines.push(`Rules our software applies after your answer: ${input.guardrailRules.join(" ")}`);
  }
  return lines.join("\n");
}

export function buildFindDecideGraphInput(input: {
  need: StructuredNeed;
  factSheet: FindDecideFactSheet;
  shortlistKeys: readonly string[];
  allowedEvidenceIds: ReadonlySet<string> | readonly string[];
  codeRankedKey: string | null;
  guardrailRules: readonly string[];
}): FindDecideGraphInput {
  const rows = new Map(input.factSheet.map((row) => [row.key, row]));
  const cars: FindDecideGraphCar[] = input.factSheet.map((row) => ({
    key: row.key,
    asking_price: usd(row.askUsd),
    miles: count(row.miles),
    drivetrain: row.drivetrain ?? null,
    reported_accidents: row.accidentCountReported != null ? String(row.accidentCountReported) : null,
    owners: row.ownerCount != null ? String(row.ownerCount) : null,
    fair_value: usd(row.fairValueUsd),
    fair_range: fairRange(row),
    similar_cars_compared: num(row.compCount) != null ? Math.max(0, Math.round(row.compCount as number)) : null,
    open_recalls: recallsText(row),
    public_record_results: publicRecordsText(row),
    listing_text: listingText(row),
  }));
  const evidence_records = [...input.allowedEvidenceIds].map((id) => ({ id, content: evidenceContent(id, rows) }));
  return {
    shopper_requirements: shopperText(input),
    permitted_car_keys: [...input.shortlistKeys],
    cars,
    evidence_records,
  };
}

type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
};

function typeOk(value: unknown, type: string): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    default:
      return false;
  }
}

function check(value: unknown, s: Schema, path: string, errors: string[]) {
  if (s.type) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => typeOk(value, t))) {
      errors.push(`${path || "input"}: must be ${types.join(" or ")}`);
      return;
    }
  }
  if (Array.isArray(value) && s.items) value.forEach((v, i) => check(v, s.items!, `${path}.${i}`, errors));
  if (typeOk(value, "object") && s.properties) {
    const obj = value as Record<string, unknown>;
    for (const key of s.required ?? []) if (!(key in obj)) errors.push(`${path ? `${path}.` : ""}${key}: missing`);
    for (const [key, v] of Object.entries(obj)) {
      const sub = s.properties[key];
      if (!sub) {
        if (s.additionalProperties === false) errors.push(`${path ? `${path}.` : ""}${key}: not allowed`);
        continue;
      }
      check(v, sub, path ? `${path}.${key}` : key, errors);
    }
  }
}

/** Local check against the graph's input schema; empty list = valid. */
export function validateFindDecideGraphInput(value: unknown): string[] {
  const errors: string[] = [];
  check(value, FIND_DECIDE_GRAPH_INPUT_SCHEMA as Schema, "", errors);
  return errors;
}

// ---------------------------------------------------------------------------
// v3 graph (gr_28beee6b8bffe5a9, prompt v3). Its generated input schema differs from v2:
// numbers are numbers, open_recalls is a list, fair_range is only its upper bound, and every car
// carries a slot car_1..car_5 that the graph's selection steps return instead of a key.
// ---------------------------------------------------------------------------

export const FIND_DECIDE_GRAPH_INPUT_SCHEMA_V3 = schemaV3;

export type FindDecideGraphInputVersion = "v2" | "v3";

/** Graph ids we generated, with the input schema each one was generated with. */
export const FIND_DECIDE_GRAPH_INPUT_VERSIONS: Readonly<Record<string, FindDecideGraphInputVersion>> = {
  gr_3d039bd8de63381a: "v2",
  gr_28beee6b8bffe5a9: "v3",
};

/**
 * Input schema for a configured graph id. `SERV_GRAPH_FIND_DECIDE_INPUT=v2|v3` overrides it for a
 * newly generated graph; an unknown id gets the latest schema (v3).
 */
export function findDecideGraphInputVersion(
  graphId: string,
  env: Record<string, string | undefined> = process.env,
): FindDecideGraphInputVersion {
  const forced = env.SERV_GRAPH_FIND_DECIDE_INPUT?.trim();
  if (forced === "v2" || forced === "v3") return forced;
  return FIND_DECIDE_GRAPH_INPUT_VERSIONS[graphId] ?? "v3";
}

/** Most cars one run may receive: v3 has five slots; v2 stays inside its 50-visit budget at six. */
export function findDecideGraphMaxCars(version: FindDecideGraphInputVersion): number {
  return version === "v3" ? 5 : 6;
}

const V3_SLOTS = ["car_1", "car_2", "car_3", "car_4", "car_5"] as const;

function openRecallsList(row: Row): string[] {
  if (row.recallsAvailable !== true) return ["Recall data was not available for this car."];
  const out: string[] = [];
  if (row.openParkIt) out.push("Open recall: do not drive the car (park it).");
  if (row.openParkOutside) out.push("Open recall: park the car outside.");
  return out;
}

export type FindDecideGraphCarV3 = {
  slot: (typeof V3_SLOTS)[number];
  key: string;
  asking_price: number | null;
  miles: number | null;
  drivetrain: string | null;
  reported_accidents: string | null;
  owners: number | null;
  fair_value: number | null;
  fair_range_upper_bound: number | null;
  similar_cars_compared: number | null;
  open_recalls: string[];
  public_record_results: string | null;
  listing_text: string | null;
};

export type FindDecideGraphInputV3 = Omit<FindDecideGraphInput, "cars"> & { cars: FindDecideGraphCarV3[] };

export function buildFindDecideGraphInputV3(input: Parameters<typeof buildFindDecideGraphInput>[0]): {
  input: FindDecideGraphInputV3;
  slotToKey: Map<string, string>;
} {
  const v2 = buildFindDecideGraphInput(input);
  const rows = input.factSheet.slice(0, V3_SLOTS.length);
  const slotToKey = new Map<string, string>();
  const cars: FindDecideGraphCarV3[] = rows.map((row, index) => {
    const slot = V3_SLOTS[index]!;
    slotToKey.set(slot, row.key);
    const round = (v: unknown) => {
      const n = num(v);
      return n == null ? null : Math.round(n);
    };
    return {
      slot,
      key: row.key,
      asking_price: round(row.askUsd),
      miles: round(row.miles),
      drivetrain: row.drivetrain ?? null,
      reported_accidents: row.accidentCountReported != null ? `${row.accidentCountReported} reported` : null,
      owners: round(row.ownerCount),
      fair_value: round(row.fairValueUsd),
      fair_range_upper_bound: round(row.fairRangeHighUsd),
      similar_cars_compared: round(row.compCount),
      open_recalls: openRecallsList(row),
      public_record_results: publicRecordsText(row),
      listing_text: listingText(row),
    };
  });
  const keys = new Set(rows.map((r) => r.key));
  return {
    input: {
      ...v2,
      permitted_car_keys: v2.permitted_car_keys.filter((k) => keys.has(k)),
      cars,
      shopper_requirements: `${v2.shopper_requirements}\nEach car also has a slot (car_1 to car_5); a slot names exactly one car.`,
    },
    slotToKey,
  };
}

export function validateFindDecideGraphInputFor(value: unknown, version: FindDecideGraphInputVersion): string[] {
  const errors: string[] = [];
  check(value, (version === "v3" ? FIND_DECIDE_GRAPH_INPUT_SCHEMA_V3 : FIND_DECIDE_GRAPH_INPUT_SCHEMA) as Schema, "", errors);
  if (version === "v3" && errors.length === 0) {
    const slots = (value as FindDecideGraphInputV3).cars.map((c) => c.slot);
    if (new Set(slots).size !== slots.length) errors.push("cars: slots must be unique");
  }
  return errors;
}

/** Build and check the run input for the configured graph. Errors → do not call the graph. */
export function prepareFindDecideGraphRun(
  graphId: string,
  input: Parameters<typeof buildFindDecideGraphInput>[0],
  env: Record<string, string | undefined> = process.env,
): {
  version: FindDecideGraphInputVersion;
  input: FindDecideGraphInput | FindDecideGraphInputV3;
  slotToKey: Map<string, string>;
  errors: string[];
} {
  const version = findDecideGraphInputVersion(graphId, env);
  if (version === "v3") {
    const built = buildFindDecideGraphInputV3(input);
    return { version, ...built, errors: validateFindDecideGraphInputFor(built.input, "v3") };
  }
  const built = buildFindDecideGraphInput(input);
  return { version, input: built, slotToKey: new Map(), errors: validateFindDecideGraphInputFor(built, "v2") };
}

const SLOT_TOKEN = /\bcar_[1-9]\b/g;
const VIN_TOKEN = /\b[A-HJ-NPR-Z0-9]{17}\b/g;

/** "2017 Toyota Camry ($10,449, 83,000 mi)" — how shopper-facing text names a car instead of a slot or a bare VIN. */
export function graphCarLabel(row: {
  year: number;
  make: string;
  model: string;
  priceUsd?: number | null;
  miles?: number | null;
}): string {
  const base = `${row.year} ${row.make} ${row.model}`.replace(/\s+/g, " ").trim();
  const facts = [
    row.priceUsd != null && Number.isFinite(row.priceUsd) ? `$${Math.round(row.priceUsd).toLocaleString("en-US")}` : null,
    row.miles != null && Number.isFinite(row.miles) ? `${Math.round(row.miles).toLocaleString("en-US")} mi` : null,
  ].filter(Boolean);
  return facts.length ? `${base} (${facts.join(", ")})` : base;
}

/**
 * Map a graph answer that names a slot (car_1..car_5) back to the permitted key, from our own map.
 * A key is kept as is. An unknown slot returns null (the answer is invalid; nothing is guessed).
 * Slot mentions (and bare VINs) in the shopper-facing text are replaced with the car they stand for,
 * named by year, make, model and price, so a reason never points at a VIN the card does not show.
 * Without a label the slot falls back to its key.
 */
export function resolveFindDecideGraphSlots<T extends { decide: unknown; challenge: unknown }>(
  payload: T | null,
  slotToKey: ReadonlyMap<string, string>,
  labelByKey: ReadonlyMap<string, string> = new Map(),
): T | null {
  if (!payload || (slotToKey.size === 0 && labelByKey.size === 0)) return payload;
  const decide = payload.decide as Record<string, unknown>;
  const pick = typeof decide?.pickKey === "string" ? decide.pickKey.trim() : "";
  let pickKey = pick;
  if (/^car_[0-9]+$/i.test(pick)) {
    const mapped = slotToKey.get(pick.toLowerCase());
    if (!mapped) return null;
    pickKey = mapped;
  }
  const nameOf = (key: string) => labelByKey.get(key) ?? labelByKey.get(key.toUpperCase()) ?? key;
  const swap = (text: unknown) =>
    typeof text === "string"
      ? text
          .replace(SLOT_TOKEN, (slot) => {
            const key = slotToKey.get(slot);
            return key ? nameOf(key) : slot;
          })
          .replace(VIN_TOKEN, (vin) => labelByKey.get(vin.toUpperCase()) ?? vin)
      : text;
  const swapLines = (lines: unknown) =>
    Array.isArray(lines)
      ? lines.map((line) =>
          line && typeof line === "object" ? { ...(line as object), text: swap((line as { text?: unknown }).text) } : line,
        )
      : lines;
  const challenge = payload.challenge as Record<string, unknown>;
  return {
    ...payload,
    decide: {
      ...decide,
      pickKey,
      confidenceWhy: swap(decide.confidenceWhy),
      reasons: swapLines(decide.reasons),
      watchOuts: swapLines(decide.watchOuts),
    },
    challenge: challenge && typeof challenge === "object" ? { ...challenge, issues: swapLines(challenge.issues) } : challenge,
  };
}
