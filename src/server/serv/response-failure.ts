/**
 * Safe SERV response-failure diagnostics (t317 / Gemini parent evidence).
 *
 * Parent Gemini 3.1 Pro Preview SAME-input: HTTP 200, content null, refusal field
 * ~19 chars, finish stop, schema false / parse failure — usage present in body
 * shape but tokens null in telemetry. Refusal *cause* is NOT known: never assert
 * format-failure or safety-cause RCA. Never persist raw refusal / content prose.
 */

import {
  normalizeCompareUsage,
  type CompareUsage,
} from "@/server/scout/plan-parse-diagnostics";

export type ServResponseFailureCategory =
  | "content_null_refusal_field"
  | "empty_content"
  | "refusal_prose"
  | "invalid_json"
  | "schema_mismatch"
  | "http_error"
  | "unknown";

export type ServMessageFieldInspect = {
  contentIsNull: boolean;
  contentEmpty: boolean;
  contentBytes: number;
  refusalFieldPresent: boolean;
  /** Byte length only — never the refusal string. */
  refusalFieldBytes: number | null;
  finishReason: string | null;
  hasUsageObject: boolean;
};

export type ServResponseFailureDiag = {
  category: ServResponseFailureCategory;
  /** Stable machine code — not free-form model text. */
  reasonCode: string;
  honesty: string;
  fields: ServMessageFieldInspect;
  usage: CompareUsage | null;
};

const REFUSAL_PROSE_MARKERS = [
  "i can't share that",
  "i cannot share that",
  "i'm not able to",
  "i am not able to",
  "cannot assist with that",
  "can't assist with that",
];

function numToken(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

/**
 * Coerce common OpenAI / Gemini / nested usage shapes into CompareUsage keys.
 * Does not invent numbers — only copies finite values under known aliases.
 */
export function coerceUsageRecord(usage: unknown): CompareUsage | null {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const r = usage as Record<string, unknown>;
  const nested =
    r.usage && typeof r.usage === "object" && !Array.isArray(r.usage)
      ? (r.usage as Record<string, unknown>)
      : null;
  const src = nested ?? r;
  const prompt = numToken(
    src.prompt_tokens ??
      src.promptTokens ??
      src.promptTokenCount ??
      src.input_tokens ??
      src.inputTokens,
  );
  const completion = numToken(
    src.completion_tokens ??
      src.completionTokens ??
      src.candidatesTokenCount ??
      src.output_tokens ??
      src.outputTokens,
  );
  const total = numToken(
    src.total_tokens ?? src.totalTokens ?? src.totalTokenCount ?? src.total,
  );
  if (prompt === undefined && completion === undefined && total === undefined) return null;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
  };
}

/** Extract + normalize usage from a chat/completions-style payload or proof.openserv. */
export function extractUsageFromPayload(payload: unknown): CompareUsage | null {
  if (!payload || typeof payload !== "object") return null;
  const body = payload as Record<string, unknown>;
  const candidates: unknown[] = [
    body.usage,
    body.usageMetadata,
    (body.openserv as { usage?: unknown } | undefined)?.usage,
  ];
  for (const c of candidates) {
    const coerced = coerceUsageRecord(c);
    const normalized = normalizeCompareUsage(coerced);
    if (normalized) return normalized;
  }
  return null;
}

function firstChoiceMessage(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return null;
  const message = (choices[0] as { message?: unknown }).message;
  if (!message || typeof message !== "object") return null;
  return message as Record<string, unknown>;
}

function finishReasonOf(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
    const fr = (choices[0] as { finish_reason?: unknown }).finish_reason;
    if (typeof fr === "string" && fr.trim()) return fr.trim().slice(0, 64);
  }
  const top = (payload as { finish_reason?: unknown }).finish_reason;
  return typeof top === "string" && top.trim() ? top.trim().slice(0, 64) : null;
}

/** Inspect message fields without copying refusal/content prose. */
export function inspectServMessageFields(payload: unknown): ServMessageFieldInspect {
  const message = firstChoiceMessage(payload);
  const content = message ? message.content : undefined;
  const contentIsNull = message != null && content === null;
  let contentBytes = 0;
  let contentEmpty = true;
  if (typeof content === "string") {
    contentBytes = Buffer.byteLength(content, "utf8");
    contentEmpty = content.trim().length === 0;
  } else if (Array.isArray(content)) {
    const joined = content
      .map((p) => (typeof p === "string" ? p : typeof (p as { text?: unknown })?.text === "string" ? (p as { text: string }).text : ""))
      .join("");
    contentBytes = Buffer.byteLength(joined, "utf8");
    contentEmpty = joined.trim().length === 0;
  } else if (content != null && typeof content === "object") {
    const s = JSON.stringify(content);
    contentBytes = Buffer.byteLength(s, "utf8");
    contentEmpty = false;
  }

  const refusal = message && typeof message.refusal === "string" ? message.refusal : null;
  const refusalFieldPresent = Boolean(refusal && refusal.trim());
  const refusalFieldBytes = refusalFieldPresent
    ? Buffer.byteLength(refusal!.trim(), "utf8")
    : null;

  const usageCandidate =
    payload && typeof payload === "object"
      ? (payload as { usage?: unknown }).usage ??
        (payload as { usageMetadata?: unknown }).usageMetadata
      : null;

  return {
    contentIsNull,
    contentEmpty: contentIsNull || contentEmpty,
    contentBytes,
    refusalFieldPresent,
    refusalFieldBytes,
    finishReason: finishReasonOf(payload),
    hasUsageObject: usageCandidate != null && typeof usageCandidate === "object",
  };
}

const UNKNOWN_CAUSE_HONESTY =
  "Refusal/failure cause is not known from transport fields alone — do not assert format-failure or safety-cause RCA.";

/**
 * Classify planner transport/parse outcome for safe operator telemetry.
 * Never embeds model refusal or content text.
 */
export function classifyServPlannerFailure(input: {
  payload?: unknown | null;
  httpOk?: boolean;
  status?: number;
  /** Extracted planner text (may be refusal field echo). */
  text?: string;
  /** parseScoutPlanText kind when parse already ran. */
  parseKind?: "refusal" | "invalid_json" | "schema_mismatch" | "ok" | null;
}): ServResponseFailureDiag {
  const fields = inspectServMessageFields(input.payload ?? null);
  const usage = extractUsageFromPayload(input.payload ?? null);
  const text = (input.text ?? "").trim();
  const lower = text.toLowerCase();
  const looksLikeRefusalProse =
    Boolean(text) &&
    !text.includes("{") &&
    REFUSAL_PROSE_MARKERS.some((m) => lower.includes(m));

  if (input.httpOk === false || (typeof input.status === "number" && input.status >= 400)) {
    return {
      category: "http_error",
      reasonCode: `http_${input.status ?? 0}`,
      honesty: UNKNOWN_CAUSE_HONESTY,
      fields,
      usage,
    };
  }

  // Parent Gemini class: content null + refusal field present (cause unknown).
  if (fields.contentIsNull && fields.refusalFieldPresent) {
    return {
      category: "content_null_refusal_field",
      reasonCode: "message_content_null_refusal_field",
      honesty: UNKNOWN_CAUSE_HONESTY,
      fields,
      usage,
    };
  }

  if (fields.refusalFieldPresent && fields.contentEmpty) {
    return {
      category: "content_null_refusal_field",
      reasonCode: "message_refusal_field_empty_content",
      honesty: UNKNOWN_CAUSE_HONESTY,
      fields,
      usage,
    };
  }

  if (input.parseKind === "refusal" || looksLikeRefusalProse) {
    return {
      category: "refusal_prose",
      reasonCode: "planner_text_refusal_markers",
      honesty: UNKNOWN_CAUSE_HONESTY,
      fields,
      usage,
    };
  }

  if (input.parseKind === "schema_mismatch") {
    return {
      category: "schema_mismatch",
      reasonCode: "schema_mismatch",
      honesty: UNKNOWN_CAUSE_HONESTY,
      fields,
      usage,
    };
  }

  if (fields.contentEmpty && !text) {
    return {
      category: "empty_content",
      reasonCode: "empty_planner_content",
      honesty: UNKNOWN_CAUSE_HONESTY,
      fields,
      usage,
    };
  }

  if (input.parseKind === "invalid_json") {
    // Short non-JSON with refusal field already handled above. Remaining invalid_json
    // is shape/parse — still not asserted as format-vs-safety RCA when refusal present.
    return {
      category: "invalid_json",
      reasonCode: fields.refusalFieldPresent
        ? "invalid_json_with_refusal_field_present"
        : "invalid_json",
      honesty: UNKNOWN_CAUSE_HONESTY,
      fields,
      usage,
    };
  }

  return {
    category: "unknown",
    reasonCode: "unclassified_planner_failure",
    honesty: UNKNOWN_CAUSE_HONESTY,
    fields,
    usage,
  };
}
