/**
 * Safe SERV response-failure diagnostics (t317 / Gemini parent evidence).
 *
 * Parent Gemini 3.1 Pro Preview SAME-input: HTTP 200, content null, refusal field
 * ~19 chars, finish stop, schema false / parse failure — usage present in body
 * shape but tokens null in telemetry. Refusal *cause* is NOT known: never assert
 * format-failure or safety-cause RCA. Never persist raw refusal / content prose.
 */

export type CompareUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** From completion_tokens_details.reasoning_tokens. Counted inside completion_tokens. */
  reasoning_tokens?: number;
};

/**
 * All-zero usage is unknown — not proof of a free call.
 * Accepts already-coerced CompareUsage.
 */
export function normalizeCompareUsage(usage: CompareUsage | null | undefined): CompareUsage | null {
  if (!usage || typeof usage !== "object") return null;
  const prompt = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined;
  const completion = typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined;
  const total = typeof usage.total_tokens === "number" ? usage.total_tokens : undefined;
  const reasoning = typeof usage.reasoning_tokens === "number" ? usage.reasoning_tokens : undefined;
  if (
    (prompt === undefined || prompt === 0) &&
    (completion === undefined || completion === 0) &&
    (total === undefined || total === 0) &&
    (reasoning === undefined || reasoning === 0)
  ) {
    return null;
  }
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    reasoning_tokens: reasoning,
  };
}

/** Normalize raw usage objects that may use Gemini camelCase or nested shapes. */
export function normalizeCompareUsageLoose(usage: unknown): CompareUsage | null {
  if (!usage || typeof usage !== "object") return null;
  const r = usage as Record<string, unknown>;
  const coerced: CompareUsage = {
    prompt_tokens:
      typeof r.prompt_tokens === "number"
        ? r.prompt_tokens
        : typeof r.promptTokens === "number"
          ? r.promptTokens
          : typeof r.promptTokenCount === "number"
            ? r.promptTokenCount
            : typeof r.input_tokens === "number"
              ? r.input_tokens
              : undefined,
    completion_tokens:
      typeof r.completion_tokens === "number"
        ? r.completion_tokens
        : typeof r.completionTokens === "number"
          ? r.completionTokens
          : typeof r.candidatesTokenCount === "number"
            ? r.candidatesTokenCount
            : typeof r.output_tokens === "number"
              ? r.output_tokens
              : undefined,
    total_tokens:
      typeof r.total_tokens === "number"
        ? r.total_tokens
        : typeof r.totalTokens === "number"
          ? r.totalTokens
          : typeof r.totalTokenCount === "number"
            ? r.totalTokenCount
            : undefined,
  };
  return normalizeCompareUsage(coerced);
}

export type ServResponseFailureCategory =
  | "content_null_refusal_field"
  | "empty_content"
  | "output_budget_exhausted"
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
  const details = src.completion_tokens_details ?? src.completionTokensDetails;
  const detailRecord =
    details && typeof details === "object" && !Array.isArray(details)
      ? (details as Record<string, unknown>)
      : null;
  const reasoning = numToken(
    src.reasoning_tokens ??
      src.reasoningTokens ??
      detailRecord?.reasoning_tokens ??
      detailRecord?.reasoningTokens,
  );
  if (prompt === undefined && completion === undefined && total === undefined && reasoning === undefined) {
    return null;
  }
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    reasoning_tokens: reasoning,
  };
}

/** Reasoning tokens spent inside the completion budget. Null when the payload omits them. */
export function reasoningTokensFromPayload(payload: unknown): number | null {
  const usage = extractUsageFromPayload(payload);
  return typeof usage?.reasoning_tokens === "number" ? usage.reasoning_tokens : null;
}

export function servFinishReason(payload: unknown): string | null {
  return finishReasonOf(payload);
}

/**
 * Plain sentence for a buyer-visible failure. No model prose.
 * A length finish, or reasoning tokens with an empty answer, means the
 * completion budget was spent before the answer was written.
 */
export function plainOutputFailure(payload: unknown, text: string): string | null {
  const reason = finishReasonOf(payload);
  const reasoning = reasoningTokensFromPayload(payload);
  const empty = text.trim().length === 0;
  if (reason === "length" || (empty && reasoning != null && reasoning > 0)) {
    const spent = reasoning != null ? ` Reasoning tokens: ${reasoning}.` : "";
    return `The model spent the answer budget on reasoning and returned no answer.${spent}`;
  }
  if (empty && reason) return `The model returned an empty answer (finish reason ${reason}).`;
  if (empty) return "The model returned an empty answer.";
  return null;
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

/** Per-call usage fields for the agent journal (tokens + any cost/cache the API returns). */
export type AgentServCallUsage = {
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  reasoning_tokens: number | null;
  /** Responses: usage.input_tokens_details.cached_tokens; Chat: prompt_tokens_details.cached_tokens. */
  cached_tokens: number | null;
  /** Present only when the API returns a numeric cost field — never invented. */
  cost: number | null;
};

function numOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function cachedTokensFromUsage(usage: Record<string, unknown>): number | null {
  const inputDetails = usage.input_tokens_details;
  if (inputDetails && typeof inputDetails === "object" && !Array.isArray(inputDetails)) {
    const cached = numOrNull((inputDetails as { cached_tokens?: unknown }).cached_tokens);
    if (cached != null) return cached;
  }
  const promptDetails = usage.prompt_tokens_details;
  if (promptDetails && typeof promptDetails === "object" && !Array.isArray(promptDetails)) {
    const cached = numOrNull((promptDetails as { cached_tokens?: unknown }).cached_tokens);
    if (cached != null) return cached;
  }
  return numOrNull(usage.cached_tokens);
}

function costFromPayload(body: Record<string, unknown>, usage: Record<string, unknown> | null): number | null {
  const candidates = [
    body.cost,
    body.cost_usd,
    body.total_cost,
    usage?.cost,
    usage?.cost_usd,
    usage?.total_cost,
    (body.openserv as { cost?: unknown } | undefined)?.cost,
  ];
  for (const c of candidates) {
    const n = numOrNull(c);
    if (n != null) return n;
  }
  return null;
}

/**
 * Journal-ready usage from a Responses or Chat payload.
 * Copies only fields the API returns (docs: input/output/total tokens;
 * cache metrics via *_tokens_details.cached_tokens). Cost is optional.
 */
export function extractAgentServCallUsage(payload: unknown): AgentServCallUsage | null {
  if (!payload || typeof payload !== "object") return null;
  const body = payload as Record<string, unknown>;
  const rawUsage =
    (body.usage && typeof body.usage === "object" && !Array.isArray(body.usage)
      ? (body.usage as Record<string, unknown>)
      : null) ??
    (body.usageMetadata && typeof body.usageMetadata === "object" && !Array.isArray(body.usageMetadata)
      ? (body.usageMetadata as Record<string, unknown>)
      : null);
  const base = extractUsageFromPayload(payload);
  const cached = rawUsage ? cachedTokensFromUsage(rawUsage) : null;
  const cost = costFromPayload(body, rawUsage);
  if (!base && cached == null && cost == null) return null;
  return {
    input_tokens: base?.prompt_tokens ?? numOrNull(rawUsage?.input_tokens) ?? null,
    output_tokens: base?.completion_tokens ?? numOrNull(rawUsage?.output_tokens) ?? null,
    total_tokens: base?.total_tokens ?? numOrNull(rawUsage?.total_tokens) ?? null,
    reasoning_tokens: base?.reasoning_tokens ?? null,
    cached_tokens: cached,
    cost,
  };
}

export type AgentServUsageTotals = {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  /** Sum of per-call cost when every call that reported usage also reported cost; else null. */
  cost: number | null;
};

export function sumAgentServUsage(
  rows: ReadonlyArray<AgentServCallUsage | null | undefined>,
): AgentServUsageTotals {
  let calls = 0;
  let input_tokens = 0;
  let output_tokens = 0;
  let total_tokens = 0;
  let reasoning_tokens = 0;
  let cached_tokens = 0;
  let costSum = 0;
  let costKnown = 0;
  for (const row of rows) {
    if (!row) continue;
    calls += 1;
    if (row.input_tokens != null) input_tokens += row.input_tokens;
    if (row.output_tokens != null) output_tokens += row.output_tokens;
    if (row.total_tokens != null) total_tokens += row.total_tokens;
    if (row.reasoning_tokens != null) reasoning_tokens += row.reasoning_tokens;
    if (row.cached_tokens != null) cached_tokens += row.cached_tokens;
    if (row.cost != null) {
      costSum += row.cost;
      costKnown += 1;
    }
  }
  return {
    calls,
    input_tokens,
    output_tokens,
    total_tokens,
    reasoning_tokens,
    cached_tokens,
    cost: costKnown > 0 && costKnown === calls ? costSum : costKnown > 0 ? costSum : null,
  };
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
    const spentOnReasoning = fields.finishReason === "length" || (usage?.reasoning_tokens ?? 0) > 0;
    return {
      category: spentOnReasoning ? "output_budget_exhausted" : "empty_content",
      reasonCode: spentOnReasoning ? "output_budget_exhausted" : "empty_planner_content",
      honesty: spentOnReasoning
        ? "The completion budget was spent on reasoning tokens, so the answer text was empty."
        : UNKNOWN_CAUSE_HONESTY,
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
