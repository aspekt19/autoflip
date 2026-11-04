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
  | { ok: false; error: string; status: number; proof: ServProof; fallback: string };

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
  const parameters = {
    type: "object",
    properties: {},
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

function messageText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as { output_text?: unknown; output?: unknown; choices?: unknown };
  if (typeof record.output_text === "string" && record.output_text.trim()) return record.output_text.trim();
  if (Array.isArray(record.output)) {
    const chunks: string[] = [];
    for (const item of record.output) {
      if (!item || typeof item !== "object") continue;
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") chunks.push((part as { text: string }).text);
      }
    }
    if (chunks.length > 0) return chunks.join("").trim();
  }
  if (!Array.isArray(record.choices) || record.choices.length === 0) return "";
  const message = (record.choices[0] as { message?: { content?: unknown } }).message;
  return typeof message?.content === "string" ? message.content.trim() : "";
}

function toolCall(payload: unknown): { id: string; name: string; arguments: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: { tool_calls?: unknown } }).message;
  const calls = message?.tool_calls;
  if (!Array.isArray(calls) || calls.length === 0) return null;
  const first = calls[0] as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
  if (typeof first.id !== "string" || typeof first.function?.name !== "string") return null;
  return {
    id: first.id,
    name: first.function.name,
    arguments: typeof first.function.arguments === "string" ? first.function.arguments : "{}",
  };
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

  const post = async (body: unknown, stream: boolean) => {
    const path = entry.endpoint === "responses" ? "/responses" : "/chat/completions";
    const response = await (deps.fetch ?? fetch)(`${base}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (stream && response.ok) {
      const streamed = await readChatStream(response);
      return { response, payload: streamed.payload, text: streamed.text };
    }
    const payload: unknown = await response.json().catch(() => null);
    return { response, payload, text: messageText(payload) };
  };

  try {
    const firstTools = toolsFor(entry, !entry.applicationTool);
    const firstBody =
      entry.endpoint === "responses"
        ? {
            model: inspected.model,
            instructions: entry.system,
            input: input.user,
            reasoning: { effort: entry.reasoningEffort, summary: "auto" },
            stream: false,
            tools: firstTools,
          }
        : {
            model: inspected.model,
            stream: entry.stream,
            reasoning_effort: entry.reasoningEffort,
            messages: [
              { role: "system", content: entry.system },
              { role: "user", content: input.user },
            ],
            tools: firstTools,
            ...(entry.jsonSchema
              ? { response_format: { type: "json_schema", json_schema: { name: entry.jsonSchema.name, strict: true, schema: entry.jsonSchema.schema } } }
              : {}),
            ...(entry.applicationTool ? { tool_choice: { type: "function", function: { name: entry.applicationTool } } } : {}),
          };

    let turn = await post(firstBody, entry.stream && !entry.applicationTool);
    let recordedBody: unknown = firstBody;
    if (entry.applicationTool && entry.endpoint === "chat") {
      const call = toolCall(turn.payload);
      if (!turn.response.ok || !call || call.name !== entry.applicationTool) {
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
        return { ok: false, error: "SERV did not read the calculated figures.", status: turn.response.status, proof, fallback: entry.fallback };
      }
      const followTools = toolsFor({ ...entry, applicationTool: undefined }, true);
      const followBody = {
        model: inspected.model,
        stream: false,
        reasoning_effort: entry.reasoningEffort,
        messages: [
          { role: "system", content: entry.system },
          { role: "user", content: input.user },
          { role: "assistant", content: null, tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }] },
          { role: "tool", tool_call_id: call.id, content: JSON.stringify(input.facts ?? {}) },
        ],
        tools: followTools,
      };
      turn = await post(followBody, false);
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
    return { ok: false, error: "SERV did not respond.", status: 0, proof, fallback: entry.fallback };
  }
}
