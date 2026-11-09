const INJECTION = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /system\s+prompt/i,
  /reveal\s+your\s+(instructions|prompt|rules)/i,
  /you\s+are\s+now\b/i,
  /\bdo\s+not\s+follow\b/i,
  /<\s*\/?\s*(system|prompt|instructions)\s*>/i,
];

/**
 * Listing and shopper text that is quoted into a model prompt.
 * Redacts instruction-shaped phrases. Does not reject the surrounding check.
 */
export function redactUntrustedPromptText(text: string, max = 240): string {
  const cleaned = text
    .replace(/\u0000/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  let out = cleaned;
  for (const pattern of INJECTION) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    out = out.replace(new RegExp(pattern.source, flags), "[removed]");
  }
  out = out.replace(/<\/?(?:system|assistant|user|prompt|instructions)\b[^>]*>/gi, " ");
  out = out.replace(/\s+/g, " ").trim();
  return out.slice(0, max);
}

/** Walk planner facts so listing prose cannot arrive as instructions. Check ids stay verbatim. */
export function redactUntrustedPromptValue<T>(value: T, depth = 0): T {
  if (depth > 8) return value;
  if (typeof value === "string") return redactUntrustedPromptText(value) as T;
  if (Array.isArray(value)) {
    return value.map((item) => redactUntrustedPromptValue(item, depth + 1)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] =
        key === "allowedChecks" || key === "checkId"
          ? inner
          : redactUntrustedPromptValue(inner, depth + 1);
    }
    return out as T;
  }
  return value;
}

export function screenUserInput(text: string): { ok: true; text: string } | { ok: false; reason: string } {
  const cleaned = text.replace(/\u0000/g, "").trim();
  if (!cleaned) return { ok: false, reason: "Enter a VIN, a listing URL, or a make and model." };
  if (cleaned.length > 2000) return { ok: false, reason: "That input is too long. Paste a single listing URL, VIN, or search." };
  for (const pattern of INJECTION) {
    if (pattern.test(cleaned)) {
      return { ok: false, reason: "That input was rejected by the local input screen." };
    }
  }
  return { ok: true, text: cleaned };
}
