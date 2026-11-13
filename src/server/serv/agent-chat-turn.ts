/**
 * Multi-turn agent SERV posts (chat next_action / Responses tools). Kept inside
 * serv/ so every model HTTP still goes through the SERV layer (bypass.test).
 *
 * Production BASE_MODEL (OpenServ): reasoning_effort none|low|medium|high. Never
 * send "none" on agent builders. Prefer /v1/responses for function tools. Chat
 * fallback is json_schema only (no function tools) with effort "low" or omitted.
 * Legacy "xhigh" is clamped to "high".
 *
 * Agent turns set a sane max_output_tokens / max_completion_tokens per step
 * (OpenServ billing uses the ceiling for balance checks). HTTP still uses a
 * platform deadline so Hobby requests can step; that is not a model token budget.
 */
import { SERV_HTTP_DEADLINE_MS, servApiBase } from "./run";
import { BASE_MODEL } from "./profiles";

/** SERV-supported efforts for production BASE_MODEL. Never "none". */
export const SERV_AGENT_REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type ServAgentReasoningEffort = (typeof SERV_AGENT_REASONING_EFFORTS)[number];

export function normalizeServAgentReasoningEffort(
  effort: string | null | undefined,
): ServAgentReasoningEffort {
  const raw = (effort ?? "").trim().toLowerCase();
  if (raw === "medium" || raw === "high") return raw;
  if (raw === "xhigh") return "high";
  return "low";
}

export type ServChatTurnMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ServChatToolCallWire[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ServChatToolCallWire = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ServChatToolDef = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

/** Flat Responses function tools (OpenServ / OpenAI Responses shape). */
export type ServResponsesToolDef = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ServChatTurnBody = {
  messages: ServChatTurnMessage[];
  tools?: ServChatToolDef[];
  toolChoice?: "auto" | "required" | "none" | { type: "function"; function: { name: string } };
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  /** Chat `max_completion_tokens` ceiling when set. */
  maxTokens?: number;
  model?: string;
  /**
   * Chat reasoning effort. Never send "none" for the production BASE_MODEL.
   * Pass null/undefined to omit the field; otherwise normalize to low|medium|high.
   */
  reasoningEffort?: ServAgentReasoningEffort | "none" | null;
  /** When true (default), omit reasoning_effort entirely rather than sending a value. */
  omitReasoningEffort?: boolean;
};

export type ServResponsesTurnBody = {
  /** System / developer instructions (Responses `instructions`) — required for the production BASE_MODEL. */
  instructions: string;
  /**
   * Responses `input`: string (simple) or item array (agentic multi-turn).
   * Agentic turns must keep prior input + reasoning/function_call items +
   * function_call_output for every call_id (live BASE_MODEL contract).
   */
  input: string | Array<Record<string, unknown>>;
  tools?: ServResponsesToolDef[];
  toolChoice?: "auto" | "required" | "none" | { type: "function"; name: string };
  /** Responses `max_output_tokens` ceiling when set. */
  maxTokens?: number;
  model?: string;
  /** Live probe: effort low works with tools; default low. Never "none". */
  reasoning?: { effort: ServAgentReasoningEffort | "none"; summary?: "auto" | "concise" | "detailed" };
  /** Optional Responses structured output (text.format json_schema). Prefer submit_picks tool for agent loops. */
  textFormat?: { name: string; schema: Record<string, unknown>; strict?: boolean };
};

export type ServChatTurnResult = {
  ok: boolean;
  status: number;
  payload: unknown;
  latencyMs: number;
  error?: string;
};

export type ServResponsesTurnResult = ServChatTurnResult;

/** True when a URL is the configured SERV chat completions endpoint. */
export function isServChatCompletionsUrl(url: string, baseUrl?: string): boolean {
  try {
    const base = new URL(servApiBase(baseUrl));
    const target = new URL(url);
    return target.host === base.host && /\/chat\/completions\/?$/.test(target.pathname);
  } catch {
    return false;
  }
}

/** True when a URL is the configured SERV Responses endpoint. */
export function isServResponsesUrl(url: string, baseUrl?: string): boolean {
  try {
    const base = new URL(servApiBase(baseUrl));
    const target = new URL(url);
    return target.host === base.host && /\/responses\/?$/.test(target.pathname);
  } catch {
    return false;
  }
}

export function buildServChatTurnBody(input: ServChatTurnBody): Record<string, unknown> {
  const bare: Record<string, unknown> = {
    model: input.model ?? BASE_MODEL,
    stream: false,
    messages: input.messages,
  };
  // Never send reasoning_effort "none" (unsupported on agent builders). Omit only when asked.
  if (input.omitReasoningEffort !== true) {
    bare.reasoning_effort = normalizeServAgentReasoningEffort(
      input.reasoningEffort === "none" ? "low" : (input.reasoningEffort ?? "low"),
    );
  }
  if (input.tools && input.tools.length > 0) {
    bare.tools = input.tools;
    bare.tool_choice = input.toolChoice ?? "auto";
  }
  if (input.jsonSchema) {
    bare.response_format = {
      type: "json_schema",
      json_schema: {
        name: input.jsonSchema.name,
        strict: true,
        schema: input.jsonSchema.schema,
      },
    };
  }
  if (typeof input.maxTokens === "number" && Number.isFinite(input.maxTokens) && input.maxTokens > 0) {
    bare.max_completion_tokens = Math.floor(input.maxTokens);
  }
  return bare;
}

/**
 * Build a Responses tools body (flat tools + reasoning). Mirrors run.ts
 * responses path without requiring a PROFILES entry (bypass.test keeps
 * responses_reasoning unused on product profiles).
 */
export function buildServResponsesTurnBody(input: ServResponsesTurnBody): Record<string, unknown> {
  const effort = normalizeServAgentReasoningEffort(input.reasoning?.effort ?? "low");
  const summary = input.reasoning?.summary ?? "auto";
  const bare: Record<string, unknown> = {
    model: input.model ?? BASE_MODEL,
    stream: false,
    instructions: input.instructions,
    input: input.input,
    reasoning: { effort, summary },
  };
  if (input.tools && input.tools.length > 0) {
    bare.tools = input.tools;
    bare.tool_choice = input.toolChoice ?? "auto";
  }
  if (input.textFormat) {
    bare.text = {
      format: {
        type: "json_schema",
        name: input.textFormat.name,
        strict: input.textFormat.strict ?? true,
        schema: input.textFormat.schema,
      },
    };
  }
  if (typeof input.maxTokens === "number" && Number.isFinite(input.maxTokens) && input.maxTokens > 0) {
    bare.max_output_tokens = Math.floor(input.maxTokens);
  }
  return bare;
}

export async function postServChatTurn(input: {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  body: Record<string, unknown>;
}): Promise<ServChatTurnResult> {
  return postServEndpoint({
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    fetch: input.fetch,
    path: "/chat/completions",
    body: input.body,
  });
}

export async function postServResponsesTurn(input: {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  body: Record<string, unknown>;
}): Promise<ServResponsesTurnResult> {
  return postServEndpoint({
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    fetch: input.fetch,
    path: "/responses",
    body: input.body,
  });
}

async function postServEndpoint(input: {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  path: "/chat/completions" | "/responses";
  body: Record<string, unknown>;
}): Promise<ServChatTurnResult> {
  const started = Date.now();
  const base = servApiBase(input.baseUrl);
  const url = `${base}${input.path}`;
  const fetchImpl = input.fetch ?? fetch;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input.body),
      signal: AbortSignal.timeout(SERV_HTTP_DEADLINE_MS),
    });
    const payload: unknown = await response.json().catch(() => null);
    return {
      ok: response.ok,
      status: response.status,
      payload,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      payload: null,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : "SERV HTTP failed",
    };
  }
}
