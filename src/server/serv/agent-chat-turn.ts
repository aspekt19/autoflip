/**
 * Multi-turn agent SERV posts (chat next_action / Responses tools). Kept inside
 * serv/ so every model HTTP still goes through the SERV layer (bypass.test).
 *
 * gpt-6.1-sol: chat/completions rejects function tools (reasoning_effort cannot
 * be none, but tools require none). Responses with reasoning.effort=low works
 * (probe winningLabel responses:tools+reasoning.low). Prefer Responses for
 * tools mode; keep chat json_schema for next_action and finish.
 */
import { SERV_HTTP_DEADLINE_MS, servApiBase } from "./run";
import { withServOutputTokenBound, SERV_OUTPUT_TOKEN_DEFAULT } from "./output-tokens";
import { BASE_MODEL } from "./profiles";

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
  maxTokens?: number;
  model?: string;
  reasoningEffort?: "none" | "low" | "medium" | "high";
};

export type ServResponsesTurnBody = {
  /** System / developer instructions (Responses `instructions`). */
  instructions: string;
  /** User turn or pragmatic multi-round transcript (Responses `input`). */
  input: string;
  tools?: ServResponsesToolDef[];
  toolChoice?: "auto" | "required" | "none" | { type: "function"; name: string };
  maxTokens?: number;
  model?: string;
  /** Live probe: effort low works with tools; default low. */
  reasoning?: { effort: "none" | "low" | "medium" | "high"; summary?: "auto" | "concise" | "detailed" };
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
    reasoning_effort: input.reasoningEffort ?? "none",
    messages: input.messages,
  };
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
  return withServOutputTokenBound("chat", bare, input.maxTokens ?? SERV_OUTPUT_TOKEN_DEFAULT);
}

/**
 * Build a Responses tools body (flat tools + reasoning). Mirrors run.ts
 * responses path without requiring a PROFILES entry (bypass.test keeps
 * responses_reasoning unused on product profiles).
 */
export function buildServResponsesTurnBody(input: ServResponsesTurnBody): Record<string, unknown> {
  const effort = input.reasoning?.effort ?? "low";
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
  return withServOutputTokenBound("responses", bare, input.maxTokens ?? SERV_OUTPUT_TOKEN_DEFAULT);
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
