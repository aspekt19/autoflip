/**
 * Shared SERV answer parsing: fence/prose extraction and soft coercions.
 * Every SERV step that reads model text should go through extractServJson.
 */

export function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Accept finite numbers and numeric strings ("18500", "18,500"). */
export function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/,/g, "");
  if (!cleaned || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Case-insensitive membership in an allowed list.
 * Returns the canonical allowed spelling, or null.
 */
export function normalizeEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null {
  const raw = asTrimmedString(value);
  if (!raw) return null;
  const lower = raw.toLowerCase();
  for (const item of allowed) {
    if (item.toLowerCase() === lower) return item;
  }
  return null;
}

function stripMarkdownFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced?.[1] ?? text).trim();
}

/** First balanced `{…}` or `[…]` slice, respecting strings. */
function firstJsonSlice(text: string): string | null {
  const startObj = text.indexOf("{");
  const startArr = text.indexOf("[");
  let start = -1;
  let open = "";
  let close = "";
  if (startObj >= 0 && (startArr < 0 || startObj < startArr)) {
    start = startObj;
    open = "{";
    close = "}";
  } else if (startArr >= 0) {
    start = startArr;
    open = "[";
    close = "]";
  }
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  // Fallback for truncated-but-usable object/array prose (matches parseNeedJson).
  const end = text.lastIndexOf(close);
  if (end > start) return text.slice(start, end + 1);
  return null;
}

/**
 * Extract the first JSON value from a SERV answer.
 * Handles markdown fences and leading/trailing prose.
 * Throws when no JSON object or array can be recovered.
 */
export function extractServJson(text: string): unknown {
  const body = stripMarkdownFences(text);
  if (!body) throw new Error("SERV answer had no JSON");
  try {
    return JSON.parse(body);
  } catch {
    // continue to slice extraction
  }
  const slice = firstJsonSlice(body);
  if (!slice) throw new Error("SERV answer had no JSON object or array");
  try {
    return JSON.parse(slice);
  } catch {
    throw new Error("SERV answer JSON could not be parsed");
  }
}

/** Soft parse: null when extractServJson would throw. */
export function tryExtractServJson(text: string | null | undefined): unknown | null {
  if (!text?.trim()) return null;
  try {
    return extractServJson(text);
  } catch {
    return null;
  }
}
