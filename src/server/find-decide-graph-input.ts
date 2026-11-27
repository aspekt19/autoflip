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
