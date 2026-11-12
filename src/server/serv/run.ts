import {
  BASE_MODEL,
  endpointForProfile,
  modelFor,
  profile,
  streamForProfile,
  type ProfileId,
  type ServProfile,
} from "./profiles";
import { resolveProfileBaseModel } from "./profile-models";
import { buildServProof, recordServProof, type ServProof } from "./proof";
import {
  completionRetryBudget,
  resolveServOutputTokenBound,
  withServOutputTokenBound,
} from "./output-tokens";
import {
  classifyServPlannerFailure,
  inspectServMessageFields,
  plainOutputFailure,
  reasoningTokensFromPayload,
  servFinishReason,
  type ServResponseFailureDiag,
} from "./response-failure";
import { normalizeServAgentReasoningEffort } from "./agent-chat-turn";
import {
  appendResponsesToolRound,
  responsesUserMessage,
  type ResponsesInputItem,
} from "./agent-tool-loop-protocol";

/**
 * Vercel function maxDuration. A SERV call waits this long and is not cut
 * short by a profile timeout. The platform ends the function at this cap.
 */
export const SERV_HTTP_DEADLINE_MS = 300_000;
import {
  classifyServTransportError,
  type ServTransportErrorClass,
} from "./transport-error";

/** Never emit reasoning_effort "none" on any SERV request body. */
export function servReasoningEffort(effort: string | null | undefined): "low" | "medium" | "high" | "xhigh" {
  return normalizeServAgentReasoningEffort(effort === "none" ? "low" : effort);
}

/** JSON-shaped, read-only facts computed by the application before any model call. */
export type ServFacts = Readonly<Record<string, unknown>>;

/**
 * Transport retry policy.
 * - `production` (default): empty-text re-POST + personal_alert_review timeout retry stay as designed.
 * - `experiment_single_attempt`: eval/compare only — no silent empty/timeout re-POSTs.
 *   Every upstream HTTP is counted once; errors/empty/refusals are recorded and returned.
 *   Intentional applicationTool chat finalize (tool → prose) is still one protocol phase pair,
 *   not a silent retry; scout_plan has no applicationTool so compare steps are one HTTP each.
 */
export type ServTransportPolicy = "production" | "experiment_single_attempt";

export type ServDeps = {
  fetch?: typeof fetch;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  /**
   * When true, send deps.model (stripped of prior suffixes) without appending the
   * profile feature suffix — used for an honest one-shot retry after kronos-multipath fails.
   */
  disableFeatureSuffix?: boolean;
  /**
   * Refusal retry: bare gpt-6.1-sol, no kronos/multipath suffix and no prompt-guard tool.
   */
  bareRetry?: boolean;
  /**
   * Default `production`. Model-compare / offline eval must pass `experiment_single_attempt`
   * so production recovery retries are not weakened globally.
   */
  transportPolicy?: ServTransportPolicy;
  /**
   * Called immediately before each outbound SERV HTTP (including retries/finalize rounds).
   * Use for atomic grant reservation. Fail closed without dispatching when not ok.
   * Ambiguous failures after dispatch must NOT refund in the caller.
   */
  beforeHttp?: () => Promise<{ ok: true } | { ok: false; message: string }>;
  /**
   * Optional per-call JSON schema override (e.g. find_next_check enum = live allowlist).
   * When set, replaces profile.jsonSchema for response_format only — profile name may differ.
   */
  jsonSchemaOverride?: { name: string; schema: Record<string, unknown> } | null;
};

export type ServResult =
  | {
      ok: true;
      text: string;
      model: string;
      shadowOutcome: string;
      rawStatus: number;
      proof: ServProof;
      /** Count of upstream SERV HTTP dispatches performed for this runServ call. */
      httpAttempts: number;
      transportPolicy: ServTransportPolicy;
      /** Present when structured content was empty/refusal-shaped despite HTTP 200. */
      failureDiag?: ServResponseFailureDiag | null;
      /** Keys/lengths only — never string values (safe for compare artifacts). */
      responseShape: string | null;
      /** True when the first reply was empty or finish_reason length and a larger budget was sent. */
      outputBudgetRetried?: boolean;
    }
  | {
      ok: false;
      error: string;
      status: number;
      proof: ServProof;
      fallback: string;
      upstream?: string | null;
      httpAttempts: number;
      transportPolicy: ServTransportPolicy;
      responseShape: string | null;
      /** True when the first reply was empty or finish_reason length and a larger budget was sent. */
      outputBudgetRetried?: boolean;
      /** Safe refusal/usage category — never raw model text. */
      failureDiag?: ServResponseFailureDiag | null;
      /** Redacted transport failure class (timeout/abort/network). */
      transportErrorClass?: ServTransportErrorClass | null;
    };

/** Eval/compare helper — never use from production planner paths. */
export function experimentServDeps(deps: ServDeps = {}): ServDeps {
  return { ...deps, transportPolicy: "experiment_single_attempt" };
}

type Tool = {
  type: "function";
  function?: { name: string; description?: string; parameters?: Record<string, unknown> };
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
};

/**
 * Strict-compatible empty object params.
 * Combining tools with response_format.strict requires every tool parameters
 * object to satisfy the OpenAI/OpenServ strict JSON Schema subset (no bare
 * tools without parameters; no `default`; additionalProperties:false; required).
 */
const STRICT_EMPTY_OBJECT_PARAMS = {
  type: "object",
  properties: {},
  required: [] as string[],
  additionalProperties: false,
} as const;

function promptGuardTool(endpoint: ServProfile["endpoint"]): Tool {
  const parameters = { ...STRICT_EMPTY_OBJECT_PARAMS, required: [...STRICT_EMPTY_OBJECT_PARAMS.required] };
  if (endpoint === "responses") {
    return { type: "function", name: "serv_prompt_guard", parameters };
  }
  return { type: "function", function: { name: "serv_prompt_guard", parameters } };
}

function shadowTool(entry: ServProfile): Tool {
  // OpenServ docs use JSON Schema `default` on hint / max_iterations (not single-value enums).
  // This is a SERV Tools marker — not response_format.json_schema — so `default` is valid.
  // https://docs.openserv.ai/serv-reasoning/tutorials/shadow-agent
  const hint = entry.shadowHint ?? "";
  const maxIterations = entry.shadowMaxIterations ?? 2;
  const parameters = {
    type: "object",
    properties: {
      hint: { type: "string", default: hint },
      max_iterations: { type: "integer", default: maxIterations },
    },
  };
  const description = "Enable SERV shadow-agent validation.";
  if (entry.endpoint === "responses") {
    return { type: "function", name: "serv_shadow_agent", description, parameters };
  }
  return {
    type: "function",
    function: {
      name: "serv_shadow_agent",
      description,
      parameters,
    },
  };
}

function factsTool(endpoint: ServProfile["endpoint"]): Tool {
  // Chat completions reject a forced tool whose schema has no properties.
  // https://docs.openserv.ai/serv-reasoning/tutorials/tools
  const parameters = {
    type: "object",
    properties: {
      seen: { type: "boolean", description: "True after reading the calculated facts already in the message." },
    },
    required: ["seen"],
    additionalProperties: false,
  };
  const description = "Read the figures already calculated for this car. Do not calculate them yourself.";
  if (endpoint === "responses") return { type: "function", name: "read_computed_facts", description, parameters };
  return { type: "function", function: { name: "read_computed_facts", description, parameters } };
}

function toolsFor(
  entry: ServProfile,
  includeShadow: boolean,
  endpoint: ServProfile["endpoint"] = entry.endpoint,
  bare = false,
): Tool[] {
  const tools: Tool[] = [];
  if (bare) {
    if (entry.applicationTool) tools.push(factsTool(endpoint));
    return tools;
  }
  if (entry.tools.includes("prompt_guard")) tools.push(promptGuardTool(endpoint));
  if (includeShadow && entry.tools.includes("shadow")) {
    tools.push(endpoint === "responses" ? shadowTool({ ...entry, endpoint }) : shadowTool({ ...entry, endpoint: "chat" }));
  }
  if (entry.applicationTool) tools.push(factsTool(endpoint));
  return tools;
}

export function requestFor(
  id: ProfileId,
  user: string,
  model = BASE_MODEL,
  env: Record<string, string | undefined> = process.env,
  opts?: { disableFeatureSuffix?: boolean },
) {
  const entry = profile(id);
  const chosen = opts?.disableFeatureSuffix
    ? model.replace(/-serv-(kronos-multipath|multipath-kronos|multipath|kronos)$/i, "")
    : modelFor(id, model);
  const endpoint = endpointForProfile(entry, model);
  const stream = streamForProfile(entry);
  const tools = toolsFor(entry, true, endpoint);
  const bound = resolveServOutputTokenBound(env);
  if (!bound.ok) {
    throw new Error(bound.message);
  }
  const effort = servReasoningEffort(entry.reasoningEffort);
  if (endpoint === "responses") {
    return withServOutputTokenBound(
      "responses",
      {
        endpoint: "responses" as const,
        model: chosen,
        stream,
        reasoning_effort: effort,
        reasoning: { effort, summary: "auto" as const },
        instructions: entry.system,
        input: user,
        tools,
        ...(entry.applicationTool
          ? { tool_choice: { type: "function" as const, name: entry.applicationTool } }
          : {}),
      },
      bound.tokens,
    );
  }
  return withServOutputTokenBound(
    "chat",
    {
      endpoint: "chat" as const,
      model: chosen,
      stream,
      reasoning_effort: effort,
      messages: [
        { role: "system" as const, content: entry.system },
        { role: "user" as const, content: user },
      ],
      tools,
      ...(entry.jsonSchema
        ? {
            response_format: {
              type: "json_schema" as const,
              json_schema: { name: entry.jsonSchema.name, strict: true, schema: entry.jsonSchema.schema },
            },
          }
        : {}),
    },
    bound.tokens,
  );
}

function visibleText(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  const chunks: string[] = [];
  for (const part of value) {
    if (typeof part === "string") {
      chunks.push(part);
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const record = part as { type?: unknown; text?: unknown };
    if (record.type === "reasoning" || record.type === "reasoning_text") continue;
    if (typeof record.text === "string") chunks.push(record.text);
  }
  return chunks;
}

/** Keys and lengths only. String values are never copied into the log. */
export function responseShape(value: unknown, depth = 0): string {
  if (value === null) return "null";
  if (value === undefined) return "missing";
  if (typeof value === "string") return `string(${value.length})`;
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value !== "object") return typeof value;
  if (depth >= 4) return Array.isArray(value) ? `array(${value.length})` : "object";
  if (Array.isArray(value)) {
    const preview = value.slice(0, 3).map((item) => responseShape(item, depth + 1)).join(",");
    return `array(${value.length})[${preview}]`;
  }
  const parts = Object.keys(value as object)
    .slice(0, 16)
    .map((key) => `${key}:${responseShape((value as Record<string, unknown>)[key], depth + 1)}`);
  return `{${parts.join(" ")}}`;
}

function jsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return "";
  return text.slice(start, end + 1).trim();
}

function toolArgumentText(calls: unknown): string {
  if (!Array.isArray(calls)) return "";
  for (const item of calls) {
    if (!item || typeof item !== "object") continue;
    const call = item as { name?: unknown; arguments?: unknown; function?: { name?: unknown; arguments?: unknown } };
    const name = typeof call.function?.name === "string" ? call.function.name : typeof call.name === "string" ? call.name : "";
    if (!name || name.startsWith("serv_")) continue;
    const args = call.function?.arguments ?? call.arguments;
    if (typeof args === "string" && args.trim()) return args.trim();
    if (args && typeof args === "object") return JSON.stringify(args);
  }
  return "";
}

/**
 * How to extract shopper/planner text from an upstream payload.
 * - `legacy`: content → parsed → tool_call args → refusal → reasoning JSON (historical).
 * - `structured`: OpenAI/SERV json_schema contract only — content / parsed / refusal.
 *   Never promote tool_call arguments or reasoning-trace drafts into planner text.
 *   Offline fixtures show a synthetic draft-as-JSON hazard: non-empty wrong text makes
 *   runServ report success, skips production empty-text recovery, and parseScoutPlanText
 *   fails with "Missing reason or servStepId". Raw live Luna bodies were not retained —
 *   this is not a proven live Luna RCA.
 */
export type MessageTextMode = "legacy" | "structured";

function fromMessage(message: unknown, mode: MessageTextMode = "legacy"): string {
  if (!message || typeof message !== "object") return "";
  const record = message as {
    content?: unknown;
    parsed?: unknown;
    refusal?: unknown;
    reasoning?: unknown;
    reasoning_content?: unknown;
    tool_calls?: unknown;
  };
  const text = visibleText(record.content).join("").trim();
  if (text) return text;
  if (record.content && typeof record.content === "object" && !Array.isArray(record.content)) return JSON.stringify(record.content);
  if (typeof record.parsed === "string" && record.parsed.trim()) return record.parsed.trim();
  if (record.parsed && typeof record.parsed === "object") return JSON.stringify(record.parsed);
  if (mode === "structured") {
    if (typeof record.refusal === "string" && record.refusal.trim()) return record.refusal.trim();
    return "";
  }
  const args = toolArgumentText(record.tool_calls);
  if (args) return args;
  if (typeof record.refusal === "string" && record.refusal.trim()) return record.refusal.trim();
  const reasoningParts: string[] = [];
  if (Array.isArray(record.content)) {
    for (const part of record.content) {
      if (!part || typeof part !== "object") continue;
      const row = part as { type?: unknown; text?: unknown; reasoning?: unknown };
      if (row.type !== "reasoning" && row.type !== "reasoning_text") continue;
      if (typeof row.text === "string") reasoningParts.push(row.text);
      if (typeof row.reasoning === "string") reasoningParts.push(row.reasoning);
    }
  }
  if (typeof record.reasoning === "string") reasoningParts.push(record.reasoning);
  if (typeof record.reasoning_content === "string") reasoningParts.push(record.reasoning_content);
  return jsonObject(reasoningParts.join("\n"));
}

/**
 * Extract visible response text.
 * Default `legacy` keeps historical flip/report scraping.
 * Pass `structured` for json_schema profiles (scout_plan / flip_judge / verdict).
 */
export function messageText(payload: unknown, mode: MessageTextMode = "legacy"): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as { output_text?: unknown; output?: unknown; choices?: unknown };
  if (typeof record.output_text === "string" && record.output_text.trim()) return record.output_text.trim();
  if (Array.isArray(record.output)) {
    const chunks: string[] = [];
    for (const item of record.output) {
      if (!item || typeof item !== "object") continue;
      const row = item as { type?: unknown; text?: unknown; content?: unknown; name?: unknown; arguments?: unknown };
      if (mode === "legacy") {
        if (row.type === "function_call" && typeof row.name === "string" && !row.name.startsWith("serv_")) {
          const args = typeof row.arguments === "string" ? row.arguments : row.arguments && typeof row.arguments === "object" ? JSON.stringify(row.arguments) : "";
          if (args.trim()) chunks.push(args);
        }
        if (row.type === "reasoning") {
          const buried = typeof row.text === "string" ? jsonObject(row.text) : "";
          if (buried) chunks.push(buried);
          continue;
        }
      } else if (row.type === "reasoning" || row.type === "function_call") {
        continue;
      }
      if ((row.type === "output_text" || row.type === "text") && typeof row.text === "string") chunks.push(row.text);
      chunks.push(...visibleText(row.content));
    }
    const joined = chunks.join("").trim();
    if (joined) return joined;
  }
  if (!Array.isArray(record.choices)) return "";
  for (const choice of record.choices) {
    if (!choice || typeof choice !== "object") continue;
    const row = choice as { text?: unknown; message?: unknown };
    if (typeof row.text === "string" && row.text.trim()) return row.text.trim();
    const text = fromMessage(row.message, mode);
    if (text) return text;
  }
  return "";
}

/** Upstream error fields only. Request bodies and credentials are not included. */
export function servErrorSummary(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const error = (payload as { error?: unknown }).error;
  const parts =
    typeof error === "string"
      ? [error]
      : error && typeof error === "object"
        ? [error as { type?: unknown; code?: unknown; param?: unknown; message?: unknown }].flatMap((record) =>
            [record.type, record.code, record.param, record.message].filter((part): part is string => typeof part === "string"),
          )
        : [];
  return parts
    .join(": ")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function logServError(id: string, status: number, payload: unknown) {
  const summary = servErrorSummary(payload);
  const reason = servFinishReason(payload);
  const usage = payload && typeof payload === "object" ? (payload as { usage?: unknown }).usage : null;
  const reasoning = reasoningTokensFromPayload(payload);
  const empty = inspectServMessageFields(payload).contentEmpty ? " empty" : "";
  console.error(
    `[serv] ${id} HTTP ${status} failed finish_reason=${reason ?? "none"} reasoning_tokens=${reasoning ?? "none"} usage=${usage ? JSON.stringify(usage) : "none"}${empty}${summary ? ` ${summary}` : ""}`,
  );
}

function argumentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return JSON.stringify(value);
  return "{}";
}

/** Chat completions nest the name under function. Responses uses a flat function_call item. Neither is required to send an id. */
export function toolCall(payload: unknown): { id: string; name: string; arguments: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as { choices?: unknown; output?: unknown };
  const lists: unknown[] = [];
  if (Array.isArray(record.choices) && record.choices[0] && typeof record.choices[0] === "object") {
    lists.push((record.choices[0] as { message?: { tool_calls?: unknown } }).message?.tool_calls);
  }
  if (Array.isArray(record.output)) {
    lists.push(record.output.filter((item) => item && typeof item === "object" && (item as { type?: string }).type === "function_call"));
  }
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const call = item as { id?: unknown; call_id?: unknown; name?: unknown; arguments?: unknown; function?: { name?: unknown; arguments?: unknown } };
      const name = typeof call.function?.name === "string" ? call.function.name : typeof call.name === "string" ? call.name : "";
      if (!name || name.startsWith("serv_")) continue;
      const id = typeof call.id === "string" ? call.id : typeof call.call_id === "string" ? call.call_id : `call_${name}`;
      return { id, name, arguments: argumentText(call.function?.arguments ?? call.arguments) };
    }
  }
  return null;
}

async function readChatStream(response: Response): Promise<{ text: string; payload: unknown }> {
  if (!response.body) return { text: "", payload: null };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let payload: unknown = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const json = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
        payload = json;
        const delta = json.choices?.[0]?.delta?.content;
        if (typeof delta === "string") text += delta;
      } catch {
        /* keepalive or a partial line */
      }
    }
  }
  return { text: text.trim(), payload };
}

export function servApiBase(baseUrl?: string): string {
  return (baseUrl || process.env.SERV_BASE_URL || "https://inference-api.openserv.ai/v1").replace(/\/$/, "");
}

/** True when a URL targets the configured SERV inference host. */
export function isServEndpointUrl(url: string, baseUrl?: string): boolean {
  try {
    return new URL(url).host === new URL(servApiBase(baseUrl)).host;
  } catch {
    return false;
  }
}

export async function runServ(
  id: ProfileId,
  input: { user: string; facts?: ServFacts },
  deps: ServDeps & { env?: Record<string, string | undefined> } = {},
): Promise<ServResult> {
  const entry = profile(id);
  const timeoutMs = deps.timeoutMs ?? entry.timeoutMs;
  const transportPolicy: ServTransportPolicy = deps.transportPolicy ?? "production";
  const experiment = transportPolicy === "experiment_single_attempt";
  const started = Date.now();
  let httpAttempts = 0;
  const base = servApiBase(deps.baseUrl);
  const env = deps.env ?? process.env;
  const resolvedModel = resolveProfileBaseModel(id, {
    requested: deps.model ?? null,
    env,
    // Compare/eval injects mock model ids; production stays allowlisted fail-closed.
    allowUnlisted: transportPolicy === "experiment_single_attempt",
  });
  if (!resolvedModel.ok) {
    const proof = recordServProof(
      buildServProof({
        purpose: id,
        body: { error: "serv_profile_model_invalid" },
        payload: null,
        headers: new Headers(),
        status: 0,
        ok: false,
        text: "",
        latencyMs: 0,
        fallbackUsed: true,
        streamed: streamForProfile(entry),
        endpoint: endpointForProfile(entry),
        reasoningEffort: servReasoningEffort(entry.reasoningEffort),
        applicationTool: entry.applicationTool ?? null,
        jsonSchema: entry.jsonSchema?.name ?? null,
        codeComputed: [...entry.codeComputed],
        contentFilter: entry.contentFilter,
        promptCache: entry.promptCache,
      }),
    );
    return {
      ok: false,
      error: resolvedModel.message,
      status: 0,
      proof,
      fallback: entry.fallback,
      upstream: "profile_model_invalid",
      httpAttempts: 0,
      transportPolicy,
      responseShape: null,
      failureDiag: null,
    };
  }
  // requestFor applies modelFor feature suffixes; pass base id only.
  const model = resolvedModel.baseId;
  const endpoint = endpointForProfile(entry, model);
  const stream = streamForProfile(entry);
  const tokenBound = resolveServOutputTokenBound(env);
  if (!tokenBound.ok) {
    const proof = recordServProof(
      buildServProof({
        purpose: id,
        body: { error: "serv_output_token_bound_invalid" },
        payload: null,
        headers: new Headers(),
        status: 0,
        ok: false,
        text: "",
        latencyMs: 0,
        fallbackUsed: true,
        streamed: stream,
        endpoint,
        reasoningEffort: servReasoningEffort(entry.reasoningEffort),
        applicationTool: entry.applicationTool ?? null,
        jsonSchema: entry.jsonSchema?.name ?? null,
        codeComputed: [...entry.codeComputed],
        contentFilter: entry.contentFilter,
        promptCache: entry.promptCache,
      }),
    );
    return {
      ok: false,
      error: tokenBound.message,
      status: 0,
      proof,
      fallback: entry.fallback,
      upstream: "output_token_bound_invalid",
      httpAttempts: 0,
      transportPolicy,
      responseShape: null,
    };
  }
  const applyTokenBound = <T extends Record<string, unknown>>(body: T) =>
    withServOutputTokenBound(endpoint, body, tokenBound.tokens);
  let inspected: ReturnType<typeof requestFor>;
  try {
    inspected = requestFor(id, input.user, model, env, {
      disableFeatureSuffix: Boolean(deps.disableFeatureSuffix),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "SERV output token bound invalid.";
    const proof = recordServProof(
      buildServProof({
        purpose: id,
        body: { error: "serv_output_token_bound_invalid" },
        payload: null,
        headers: new Headers(),
        status: 0,
        ok: false,
        text: "",
        latencyMs: 0,
        fallbackUsed: true,
        streamed: stream,
        endpoint,
        reasoningEffort: servReasoningEffort(entry.reasoningEffort),
        applicationTool: entry.applicationTool ?? null,
        jsonSchema: entry.jsonSchema?.name ?? null,
        codeComputed: [...entry.codeComputed],
        contentFilter: entry.contentFilter,
        promptCache: entry.promptCache,
      }),
    );
    return {
      ok: false,
      error: message,
      status: 0,
      proof,
      fallback: entry.fallback,
      upstream: "output_token_bound_invalid",
      httpAttempts: 0,
      transportPolicy,
      responseShape: null,
    };
  }
  const effectiveJsonSchema = deps.jsonSchemaOverride ?? entry.jsonSchema ?? null;
  const proofMeta = {
    streamed: stream,
    endpoint,
    reasoningEffort: servReasoningEffort(entry.reasoningEffort),
    applicationTool: entry.applicationTool ?? null,
    jsonSchema: effectiveJsonSchema?.name ?? null,
    codeComputed: [...entry.codeComputed],
    contentFilter: entry.contentFilter,
    promptCache: entry.promptCache,
  };

  if (!deps.apiKey) {
    const proof = recordServProof(
      buildServProof({
        purpose: id,
        body: inspected,
        payload: null,
        headers: new Headers(),
        status: 0,
        ok: false,
        text: "",
        latencyMs: 0,
        fallbackUsed: true,
        ...proofMeta,
      }),
    );
    proof.promptGuard = entry.tools.includes("prompt_guard") ? "not_configured" : proof.promptGuard;
    return {
      ok: false,
      error: "SERV is not configured.",
      status: 0,
      proof,
      fallback: entry.fallback,
      httpAttempts: 0,
      transportPolicy,
      responseShape: null,
    };
  }

  // Profile timeoutMs and caller clocks are not applied to the HTTP abort.
  // A slow reasoning call runs until the platform function limit.
  void timeoutMs;
  const firstTokens = tokenBound.tokens;
  const retryTokens = completionRetryBudget(firstTokens);
  const postOnce = async (body: unknown, useStream: boolean) => {
    if (deps.beforeHttp) {
      const gate = await deps.beforeHttp();
      if (!gate.ok) {
        const err = new Error(gate.message);
        err.name = "ServBudgetError";
        throw err;
      }
    }
    httpAttempts += 1;
    const path = endpoint === "responses" ? "/responses" : "/chat/completions";
    const response = await (deps.fetch ?? fetch)(`${base}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SERV_HTTP_DEADLINE_MS),
    });
    if (useStream && response.ok) {
      const streamed = await readChatStream(response);
      return { response, payload: streamed.payload, text: streamed.text, shape: responseShape(streamed.payload) };
    }
    const payload: unknown = await response.json().catch(() => null);
    // json_schema profiles: only content/parsed/refusal — never tool args / reasoning drafts.
    const text = messageText(payload, effectiveJsonSchema ? "structured" : "legacy");
    const shape = responseShape(payload);
    return { response, payload, text, shape };
  };

  const outputExhausted = (payload: unknown, text: string) => {
    if (servFinishReason(payload) === "length") return true;
    return text.trim().length === 0;
  };

  const post = async (body: object, useStream: boolean) => {
    const record = body as Record<string, unknown>;
    let turn = await postOnce(withServOutputTokenBound(endpoint, record, firstTokens), useStream);
    let outputBudgetRetried = false;
    // One larger-budget retry. Empty text or finish_reason length is a real failure.
    if (!experiment && turn.response.ok && outputExhausted(turn.payload, turn.text)) {
      logServError(id, turn.response.status, turn.payload);
      outputBudgetRetried = true;
      turn = await postOnce(withServOutputTokenBound(endpoint, record, retryTokens), useStream);
    }
    if (!turn.response.ok || outputExhausted(turn.payload, turn.text)) {
      logServError(id, turn.response.status, turn.payload);
    }
    return { ...turn, outputBudgetRetried };
  };

  try {
    const factsText = JSON.stringify(input.facts ?? {});
    const userText = entry.applicationTool ? `${input.user}\n\nCalculated facts, the only numbers you may use:\n${factsText}` : input.user;
    const bare = Boolean(deps.bareRetry);
    const effort = servReasoningEffort(entry.reasoningEffort);
    const firstTools = toolsFor(entry, !entry.applicationTool, endpoint, bare);
    const firstBody = applyTokenBound(
      endpoint === "responses"
        ? {
            model: inspected.model,
            instructions: entry.system,
            input: userText,
            reasoning: { effort, summary: "auto" as const },
            stream: false,
            tools: firstTools,
            ...(entry.applicationTool
              ? { tool_choice: { type: "function" as const, name: entry.applicationTool } }
              : {}),
          }
        : {
            model: inspected.model,
            stream,
            // Never "none" — application tools must use /v1/responses (endpointForProfile).
            reasoning_effort: effort,
            messages: [
              { role: "system", content: entry.system },
              { role: "user", content: userText },
            ],
            tools: firstTools,
            ...(effectiveJsonSchema
              ? {
                  response_format: {
                    type: "json_schema",
                    json_schema: {
                      name: effectiveJsonSchema.name,
                      strict: true,
                      schema: effectiveJsonSchema.schema,
                    },
                  },
                }
              : {}),
            ...(entry.applicationTool
              ? { tool_choice: { type: "function", function: { name: entry.applicationTool } } }
              : {}),
          },
    );

    let turn = await post(firstBody, entry.applicationTool ? false : stream);
    let recordedBody: unknown = firstBody;
    if (entry.applicationTool) {
      if (!turn.response.ok) {
        const proof = recordServProof(
          buildServProof({
            purpose: id,
            body: { ...firstBody, tools: toolsFor(entry, true, endpoint, bare) },
            payload: turn.payload,
            headers: turn.response.headers,
            status: turn.response.status,
            ok: false,
            text: turn.text,
            latencyMs: Date.now() - started,
            fallbackUsed: true,
            ...proofMeta,
          }),
        );
        return {
          ok: false,
          error: "SERV returned an error.",
          status: turn.response.status,
          proof,
          fallback: entry.fallback,
          upstream: servErrorSummary(turn.payload) || null,
          httpAttempts,
          transportPolicy,
          responseShape: turn.shape || null,
        };
      }
      const call = toolCall(turn.payload);
      const matched = call?.name === entry.applicationTool ? call : null;
      const followTools = toolsFor({ ...entry, applicationTool: undefined }, true, endpoint, bare);
      if (endpoint === "responses") {
        const priorInput: ResponsesInputItem[] = [responsesUserMessage(userText)];
        const responseOutput =
          turn.payload && typeof turn.payload === "object" && Array.isArray((turn.payload as { output?: unknown }).output)
            ? (turn.payload as { output: unknown }).output
            : [];
        const nextInput = matched
          ? appendResponsesToolRound({
              priorInput,
              responseOutput,
              outputs: [{ callId: matched.id, output: factsText }],
            })
          : [
              ...priorInput,
              responsesUserMessage(`Calculated facts (tool was not called):\n${factsText}`),
            ];
        const followBody = applyTokenBound({
          model: inspected.model,
          instructions: entry.system,
          input: nextInput,
          reasoning: { effort, summary: "auto" as const },
          stream: false,
          tools: followTools,
        });
        turn = await post(followBody, false);
        recordedBody = { ...followBody, tools: toolsFor(entry, true, endpoint, bare) };
      } else {
        // Gemini chat fallback — still never send reasoning_effort "none".
        const followBody = applyTokenBound({
          model: inspected.model,
          stream: false,
          reasoning_effort: effort,
          messages: matched
            ? [
                { role: "system", content: entry.system },
                { role: "user", content: userText },
                {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: matched.id,
                      type: "function",
                      function: { name: matched.name, arguments: matched.arguments },
                    },
                  ],
                },
                { role: "tool", tool_call_id: matched.id, content: factsText },
              ]
            : [
                { role: "system", content: entry.system },
                { role: "user", content: userText },
              ],
          tools: followTools,
        });
        turn = await post(followBody, false);
        recordedBody = { ...followBody, tools: toolsFor(entry, true, endpoint, bare) };
      }
    }

    // Structured json_schema: content null + refusal field is a transport failure class
    // (parent Gemini evidence). Do not promote refusal string into planner text / invent RCA.
    const messageFields = effectiveJsonSchema ? inspectServMessageFields(turn.payload) : null;
    const structuredRefusalOnly =
      Boolean(effectiveJsonSchema) &&
      turn.response.ok &&
      messageFields != null &&
      messageFields.refusalFieldPresent &&
      (messageFields.contentIsNull || messageFields.contentEmpty);

    const effectiveText = structuredRefusalOnly ? "" : turn.text;
    const proof = recordServProof(
      buildServProof({
        purpose: id,
        body: recordedBody,
        payload: turn.payload,
        headers: turn.response.headers,
        status: turn.response.status,
        ok: turn.response.ok && Boolean(effectiveText),
        // Never persist refusal field prose in proof text.
        text: effectiveText,
        latencyMs: Date.now() - started,
        fallbackUsed: !turn.response.ok || !effectiveText,
        ...proofMeta,
      }),
    );

    if (!turn.response.ok || !effectiveText) {
      const failureDiag = classifyServPlannerFailure({
        payload: turn.payload,
        httpOk: turn.response.ok,
        status: turn.response.status,
        text: effectiveText,
        parseKind: null,
      });
        const plain = turn.response.ok ? plainOutputFailure(turn.payload, effectiveText) : null;
        return {
        ok: false,
        error: turn.response.ok
          ? structuredRefusalOnly
            ? `SERV structured refusal field (${failureDiag.reasonCode}).`
            : plain ?? "SERV returned an empty explanation."
          : "SERV returned an error.",
        status: turn.response.status,
        proof,
        fallback: entry.fallback,
        upstream: turn.response.ok ? turn.shape || null : servErrorSummary(turn.payload) || null,
        httpAttempts,
        transportPolicy,
        responseShape: turn.shape || null,
        failureDiag,
        outputBudgetRetried: turn.outputBudgetRetried,
      };
    }
    return {
      ok: true,
      text: effectiveText,
      model: proof.modelReported,
      shadowOutcome: proof.shadowOutcome,
      rawStatus: turn.response.status,
      proof,
      httpAttempts,
      transportPolicy,
      responseShape: turn.shape || null,
      failureDiag: null,
      outputBudgetRetried: turn.outputBudgetRetried,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "ServBudgetError") {
      const proof = recordServProof(
        buildServProof({
          purpose: id,
          body: inspected,
          payload: null,
          headers: new Headers(),
          status: 429,
          ok: false,
          text: "",
          latencyMs: Date.now() - started,
          fallbackUsed: true,
          ...proofMeta,
        }),
      );
      return {
        ok: false,
        error: error.message || "SERV grant call budget exhausted.",
        status: 429,
        proof,
        fallback: entry.fallback,
        upstream: "grant_exhausted",
        httpAttempts,
        transportPolicy,
        responseShape: null,
      };
    }
    const classified = classifyServTransportError(error);
    const proof = recordServProof(
      buildServProof({
        purpose: id,
        body: inspected,
        payload: null,
        headers: new Headers(),
        status: 0,
        ok: false,
        text: "",
        latencyMs: Date.now() - started,
        fallbackUsed: true,
        ...proofMeta,
      }),
    );
    return {
      ok: false,
      error: classified.detail,
      status: 0,
      proof,
      fallback: entry.fallback,
      upstream: classified.class,
      httpAttempts,
      transportPolicy,
      responseShape: null,
      transportErrorClass: classified.class,
    };
  }
}
