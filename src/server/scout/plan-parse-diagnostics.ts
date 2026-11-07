/**
 * Sanitized planner-output diagnostics for compare/eval (owner t299/t300).
 *
 * Never copies string values (VIN, reason prose, step ids). Keys, JSON types,
 * and lengths only — enough to tell missing/null/empty/wrong-shape apart
 * without reconstructing model text.
 */

export type FieldPresence = "missing" | "null" | "empty_string" | "non_string" | "string";

export type SanitizedPlannerParseEcho = {
  textBytes: number;
  looksLikeJsonObject: boolean;
  topLevelKeys: string[];
  fieldPresence: {
    type: FieldPresence;
    reason: FieldPresence;
    servStepId: FieldPresence;
  };
  /** typeof for present non-null fields (never values). */
  fieldTypes: Record<string, string>;
  stringLengths: Partial<Record<"type" | "reason" | "servStepId" | "vin" | "toolId", number>>;
};

function fieldPresence(value: unknown): FieldPresence {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (typeof value !== "string") return "non_string";
  if (value.trim() === "") return "empty_string";
  return "string";
}

function jsonTypeLabel(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Build a redacted echo of planner text for failure rows.
 * Safe to persist in compare artifacts; does not embed model prose.
 */
export function sanitizePlannerParseEcho(text: string): SanitizedPlannerParseEcho {
  const trimmed = text.trim();
  const echo: SanitizedPlannerParseEcho = {
    textBytes: Buffer.byteLength(trimmed, "utf8"),
    looksLikeJsonObject: false,
    topLevelKeys: [],
    fieldPresence: {
      type: "missing",
      reason: "missing",
      servStepId: "missing",
    },
    fieldTypes: {},
    stringLengths: {},
  };
  if (!trimmed) return echo;

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return echo;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return echo;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return echo;

  echo.looksLikeJsonObject = true;
  echo.topLevelKeys = Object.keys(raw).slice(0, 24).sort();
  echo.fieldPresence = {
    type: fieldPresence(raw.type),
    reason: fieldPresence(raw.reason),
    servStepId: fieldPresence(raw.servStepId),
  };
  for (const key of echo.topLevelKeys) {
    echo.fieldTypes[key] = jsonTypeLabel(raw[key]);
  }
  for (const key of ["type", "reason", "servStepId", "vin", "toolId"] as const) {
    if (typeof raw[key] === "string") echo.stringLengths[key] = (raw[key] as string).length;
  }
  return echo;
}

/** Precise mismatch detail for reason/servStepId — avoids collapsing distinct shapes. */
export function reasonServStepIdMismatchMessage(raw: Record<string, unknown>): string {
  const reason = fieldPresence(raw.reason);
  const servStepId = fieldPresence(raw.servStepId);
  const type = fieldPresence(raw.type);
  const keys = Object.keys(raw).sort().join(",");
  return `Missing reason or servStepId (reason=${reason}, servStepId=${servStepId}, type=${type}, keys=${keys || "none"}).`;
}
