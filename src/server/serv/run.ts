import { BASE_MODEL, modelFor, profile, type ProfileId, type ServProfile } from "./profiles";
import { buildServProof, recordServProof, type ServProof } from "./proof";

export type ServDeps = {
  fetch?: typeof fetch;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
};

export type ServResult =
  | { ok: true; text: string; model: string; shadowOutcome: string; rawStatus: number; proof: ServProof }
  | { ok: false; error: string; status: number; proof: ServProof; fallback: string; upstream?: string | null };

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

export function requestFor(id: ProfileId, user: string, model = BASE_MODEL) {
  const entry = profile(id);
  const tools = toolsFor(entry, true);
  const chosen = modelFor(id, model);
  if (entry.endpoint === "responses") {
    return {
      endpoint: "responses" as const,
      model: chosen,
      stream: entry.stream,
      reasoning_effort: entry.reasoningEffort,
      reasoning: { effort: entry.reasoningEffort, summary: "auto" as const },
      instructions: entry.system,
      input: user,
      tools,
    };
  }
  return {
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
  };
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

/** Shopper-facing text. Reasoning traces are not the answer, even when content is blank. */
export function messageText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as { output_text?: unknown; output?: unknown; choices?: unknown };
  if (typeof record.output_text === "string" && record.output_text.trim()) return record.output_text.trim();
  if (Array.isArray(record.output)) {
    const chunks: string[] = [];
    for (const item of record.output) {
      if (!item || typeof item !== "object") continue;
      const row = item as { type?: unknown; text?: unknown; content?: unknown };
      if (row.type === "reasoning") continue;
      if (row.type === "output_text" && typeof row.text === "string") chunks.push(row.text);
      chunks.push(...visibleText(row.content));
    }
    const joined = chunks.join("").trim();
    if (joined) return joined;
  }
  if (!Array.isArray(record.choices) || record.choices.length === 0) return "";
  const choice = record.choices[0] as { text?: unknown; message?: { content?: unknown } };
  const fromMessage = visibleText(choice.message?.content).join("").trim();
  if (fromMessage) return fromMessage;
  return typeof choice.text === "string" ? choice.text.trim() : "";
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
  input: { user: string; facts?: unknown },
  deps: ServDeps = {},
): Promise<ServResult> {
  const entry = profile(id);
  const timeoutMs = deps.timeoutMs ?? entry.timeoutMs;
  const started = Date.now();
  const base = (deps.baseUrl || "https://inference-api.openserv.ai/v1").replace(/\/$/, "");
  const model = deps.model || BASE_MODEL;
  const inspected = requestFor(id, input.user, model);
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
    return { ok: false, error: "SERV is not configured.", status: 0, proof, fallback: entry.fallback };
  }

  const rounds = entry.applicationTool && entry.endpoint === "chat" ? 2 : 1;
  const deadline = started + timeoutMs * rounds;
  const post = async (body: unknown, stream: boolean) => {
    const remain = deadline - Date.now();
    if (remain < 500) throw new DOMException("The operation was aborted.", "TimeoutError");
    const path = entry.endpoint === "responses" ? "/responses" : "/chat/completions";
    const response = await (deps.fetch ?? fetch)(`${base}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(remain),
    });
    if (stream && response.ok) {
      const streamed = await readChatStream(response);
      return { response, payload: streamed.payload, text: streamed.text };
    }
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) logServError(id, response.status, payload);
    return { response, payload, text: messageText(payload) };
  };

  const postProse = async (body: unknown, stream: boolean) => {
    let turn = await post(body, stream);
    if (turn.response.ok && !turn.text.trim() && deadline - Date.now() > 1_000) {
      turn = await post(body, stream);
    }
    return turn;
  };

  try {
    const factsText = JSON.stringify(input.facts ?? {});
    const userText = entry.applicationTool ? `${input.user}\n\nCalculated facts, the only numbers you may use:\n${factsText}` : input.user;
    const firstTools = toolsFor(entry, !entry.applicationTool);
    const firstBody =
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
          };

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
        return { ok: false, error: "SERV returned an error.", status: turn.response.status, proof, fallback: entry.fallback, upstream: servErrorSummary(turn.payload) || null };
      }
      const call = toolCall(turn.payload);
      const matched = call?.name === entry.applicationTool ? call : null;
      const followTools = toolsFor({ ...entry, applicationTool: undefined }, true);
      const followBody = {
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
      };
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
        upstream: turn.response.ok ? null : servErrorSummary(turn.payload) || null,
      };
    }
    return { ok: true, text: turn.text, model: proof.modelReported, shadowOutcome: proof.shadowOutcome, rawStatus: turn.response.status, proof };
  } catch {
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
    return { ok: false, error: "SERV did not respond.", status: 0, proof, fallback: entry.fallback, upstream: null };
  }
}
