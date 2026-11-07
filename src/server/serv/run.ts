import { BASE_MODEL, modelFor, profile, type ProfileId, type ServProfile } from "./profiles";
import { buildServProof, recordServProof, type ServProof } from "./proof";
import {
  resolveServOutputTokenBound,
  withServOutputTokenBound,
} from "./output-tokens";

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
      /** Keys/lengths only — never string values (safe for compare artifacts). */
      responseShape: string | null;
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

function promptGuardTool(endpoint: ServProfile["endpoint"]): Tool {
  if (endpoint === "responses") return { type: "function", name: "serv_prompt_guard" };
  return { type: "function", function: { name: "serv_prompt_guard" } };
}

function shadowTool(entry: ServProfile): Tool {
  const parameters = {
    type: "object",
    properties: {
      hint: { type: "string", default: entry.shadowHint ?? "" },
      max_iterations: { type: "integer", default: entry.shadowMaxIterations ?? 2 },
    },
  };
  if (entry.endpoint === "responses") {
    return { type: "function", name: "serv_shadow_agent", description: "Enable SERV shadow-agent validation.", parameters };
  }
  return {
    type: "function",
    function: {
      name: "serv_shadow_agent",
      description: "Enable SERV shadow-agent validation.",
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

function toolsFor(entry: ServProfile, includeShadow: boolean): Tool[] {
  const tools: Tool[] = [];
  if (entry.tools.includes("prompt_guard")) tools.push(promptGuardTool(entry.endpoint));
  if (includeShadow && entry.tools.includes("shadow")) tools.push(shadowTool(entry));
  if (entry.applicationTool) tools.push(factsTool(entry.endpoint));
  return tools;
}

export function requestFor(
  id: ProfileId,
  user: string,
  model = BASE_MODEL,
  env: Record<string, string | undefined> = process.env,
) {
  const entry = profile(id);
  const tools = toolsFor(entry, true);
  const chosen = modelFor(id, model);
  const bound = resolveServOutputTokenBound(env);
  if (!bound.ok) {
    throw new Error(bound.message);
  }
  if (entry.endpoint === "responses") {
    return withServOutputTokenBound(
      "responses",
      {
        endpoint: "responses" as const,
        model: chosen,
        stream: entry.stream,
        reasoning_effort: entry.reasoningEffort,
        reasoning: { effort: entry.reasoningEffort, summary: "auto" as const },
        instructions: entry.system,
        input: user,
        tools,
      },
      bound.tokens,
    );
  }
  return withServOutputTokenBound(
    "chat",
    {
      endpoint: "chat" as const,
      model: chosen,
      stream: entry.stream,
      reasoning_effort: entry.reasoningEffort,
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

function fromMessage(message: unknown): string {
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

/** Shopper-facing text. A reasoning trace is used only when it contains the JSON object. */
export function messageText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as { output_text?: unknown; output?: unknown; choices?: unknown };
  if (typeof record.output_text === "string" && record.output_text.trim()) return record.output_text.trim();
  if (Array.isArray(record.output)) {
    const chunks: string[] = [];
    for (const item of record.output) {
      if (!item || typeof item !== "object") continue;
      const row = item as { type?: unknown; text?: unknown; content?: unknown; name?: unknown; arguments?: unknown };
      if (row.type === "function_call" && typeof row.name === "string" && !row.name.startsWith("serv_")) {
        const args = typeof row.arguments === "string" ? row.arguments : row.arguments && typeof row.arguments === "object" ? JSON.stringify(row.arguments) : "";
        if (args.trim()) chunks.push(args);
      }
      if (row.type === "reasoning") {
        const buried = typeof row.text === "string" ? jsonObject(row.text) : "";
        if (buried) chunks.push(buried);
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
    const text = fromMessage(row.message);
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
  console.error(`[serv] ${id} HTTP ${status}${summary ? ` ${summary}` : " no error body"}`);
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
  const base = (deps.baseUrl || "https://inference-api.openserv.ai/v1").replace(/\/$/, "");
  const model = deps.model || BASE_MODEL;
  const env = deps.env ?? process.env;
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
        streamed: entry.stream,
        endpoint: entry.endpoint,
        reasoningEffort: entry.reasoningEffort,
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
    withServOutputTokenBound(entry.endpoint, body, tokenBound.tokens);
  let inspected: ReturnType<typeof requestFor>;
  try {
    inspected = requestFor(id, input.user, model, env);
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
        streamed: entry.stream,
        endpoint: entry.endpoint,
        reasoningEffort: entry.reasoningEffort,
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
  const proofMeta = {
    streamed: entry.stream,
    endpoint: entry.endpoint,
    reasoningEffort: entry.reasoningEffort,
    applicationTool: entry.applicationTool ?? null,
    jsonSchema: entry.jsonSchema?.name ?? null,
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

  // Protocol rounds (tool → finalize) are not silent retries. Experiment disables only
  // empty-text / timeout re-POSTs so each requested compare step stays one attempt for
  // profiles without applicationTool (including scout_plan).
  const protocolRounds = entry.applicationTool && entry.endpoint === "chat" ? 2 : 1;
  const deadline = started + timeoutMs * protocolRounds;
  const postOnce = async (body: unknown, stream: boolean, capMs: number) => {
    const budget = Math.min(deadline - Date.now(), capMs);
    if (budget < 500) throw new DOMException("The operation was aborted.", "TimeoutError");
    if (deps.beforeHttp) {
      const gate = await deps.beforeHttp();
      if (!gate.ok) {
        const err = new Error(gate.message);
        err.name = "ServBudgetError";
        throw err;
      }
    }
    httpAttempts += 1;
    const path = entry.endpoint === "responses" ? "/responses" : "/chat/completions";
    const response = await (deps.fetch ?? fetch)(`${base}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(budget),
    });
    if (stream && response.ok) {
      const streamed = await readChatStream(response);
      return { response, payload: streamed.payload, text: streamed.text, shape: responseShape(streamed.payload) };
    }
    const payload: unknown = await response.json().catch(() => null);
    const text = messageText(payload);
    const shape = responseShape(payload);
    if (!response.ok) logServError(id, response.status, payload);
    else if (!text) console.error(`[serv] ${id} HTTP ${response.status} empty ${shape}`);
    return { response, payload, text, shape };
  };
  const post = async (body: unknown, stream: boolean) => {
    const remain = deadline - Date.now();
    // Production-only: personal_alert_review splits the deadline and retries once on timeout.
    if (experiment || id !== "personal_alert_review") return postOnce(body, stream, remain);
    const firstWait = Math.min(8_000, Math.floor(timeoutMs / 2));
    try {
      return await postOnce(body, stream, firstWait);
    } catch (error) {
      if (!isTimeout(error) || deadline - Date.now() < 1_000) throw error;
      return await postOnce(body, stream, deadline - Date.now());
    }
  };

  const postProse = async (body: unknown, stream: boolean) => {
    let turn = await post(body, stream);
    // Production-only: one silent re-POST when the first success returns empty text.
    if (
      !experiment &&
      turn.response.ok &&
      !turn.text.trim() &&
      deadline - Date.now() > 1_000
    ) {
      turn = await post(body, stream);
    }
    return turn;
  };

  try {
    const factsText = JSON.stringify(input.facts ?? {});
    const userText = entry.applicationTool ? `${input.user}\n\nCalculated facts, the only numbers you may use:\n${factsText}` : input.user;
    const firstTools = toolsFor(entry, !entry.applicationTool);
    const firstBody = applyTokenBound(
      entry.endpoint === "responses"
        ? {
            model: inspected.model,
            instructions: entry.system,
            input: userText,
            reasoning: { effort: entry.reasoningEffort, summary: "auto" },
            stream: false,
            tools: firstTools,
          }
        : {
            model: inspected.model,
            stream: entry.stream,
            // gpt-5.4-mini rejects a function tool on chat completions unless effort is none.
            reasoning_effort: entry.applicationTool ? "none" : entry.reasoningEffort,
            messages: [
              { role: "system", content: entry.system },
              { role: "user", content: userText },
            ],
            tools: firstTools,
            ...(entry.jsonSchema
              ? { response_format: { type: "json_schema", json_schema: { name: entry.jsonSchema.name, strict: true, schema: entry.jsonSchema.schema } } }
              : {}),
            ...(entry.applicationTool ? { tool_choice: { type: "function", function: { name: entry.applicationTool } } } : {}),
          },
    );

    let turn = entry.applicationTool ? await post(firstBody, false) : await postProse(firstBody, entry.stream);
    let recordedBody: unknown = firstBody;
    if (entry.applicationTool && entry.endpoint === "chat") {
      if (!turn.response.ok) {
        const proof = recordServProof(
          buildServProof({
            purpose: id,
            body: { ...firstBody, tools: toolsFor(entry, true) },
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
      const followTools = toolsFor({ ...entry, applicationTool: undefined }, true);
      const followBody = applyTokenBound({
        model: inspected.model,
        stream: false,
        reasoning_effort: entry.reasoningEffort,
        messages: matched
          ? [
              { role: "system", content: entry.system },
              { role: "user", content: userText },
              { role: "assistant", content: null, tool_calls: [{ id: matched.id, type: "function", function: { name: matched.name, arguments: matched.arguments } }] },
              { role: "tool", tool_call_id: matched.id, content: factsText },
            ]
          : [
              { role: "system", content: entry.system },
              { role: "user", content: userText },
            ],
        tools: followTools,
      });
      turn = await postProse(followBody, false);
      recordedBody = { ...followBody, tools: toolsFor(entry, true) };
    }

    const proof = recordServProof(
      buildServProof({
        purpose: id,
        body: recordedBody,
        payload: turn.payload,
        headers: turn.response.headers,
        status: turn.response.status,
        ok: turn.response.ok && Boolean(turn.text),
        text: turn.text,
        latencyMs: Date.now() - started,
        fallbackUsed: !turn.response.ok || !turn.text,
        ...proofMeta,
      }),
    );
    if (!turn.response.ok || !turn.text) {
      return {
        ok: false,
        error: turn.response.ok ? "SERV returned an empty explanation." : "SERV returned an error.",
        status: turn.response.status,
        proof,
        fallback: entry.fallback,
        upstream: turn.response.ok ? turn.shape || null : servErrorSummary(turn.payload) || null,
        httpAttempts,
        transportPolicy,
        responseShape: turn.shape || null,
      };
    }
    return {
      ok: true,
      text: turn.text,
      model: proof.modelReported,
      shadowOutcome: proof.shadowOutcome,
      rawStatus: turn.response.status,
      proof,
      httpAttempts,
      transportPolicy,
      responseShape: turn.shape || null,
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
      error: "SERV did not respond.",
      status: 0,
      proof,
      fallback: entry.fallback,
      upstream: null,
      httpAttempts,
      transportPolicy,
      responseShape: null,
    };
  }
}
