import { BASE_MODEL, modelFor, profile, type ProfileId, type ServProfile } from "./profiles";
import { buildServProof, interpretGuard, recordServProof, type ServProof } from "./proof";

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

function promptGuardTool() {
  return { type: "function" as const, function: { name: "serv_prompt_guard" } };
}

function shadowTool(entry: ServProfile) {
  return {
    type: "function" as const,
    function: {
      name: "serv_shadow_agent",
      description: "Enable SERV shadow-agent validation.",
      parameters: {
        type: "object",
        properties: {
          hint: { type: "string", default: entry.shadowHint ?? "" },
          max_iterations: { type: "integer", default: entry.shadowMaxIterations ?? 2 },
        },
      },
    },
  };
}

export function requestFor(id: ProfileId, user: string, model = BASE_MODEL) {
  const entry = profile(id);
  const tools = entry.tools.map((tool) => (tool === "prompt_guard" ? promptGuardTool() : shadowTool(entry)));
  return {
    model: modelFor(id, model),
    stream: false as const,
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
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const message = (choices[0] as { message?: { content?: unknown } }).message;
  return typeof message?.content === "string" ? message.content.trim() : "";
}

export async function runServ(id: ProfileId, input: { user: string }, deps: ServDeps = {}): Promise<ServResult> {
  const entry = profile(id);
  const body = requestFor(id, input.user, deps.model || BASE_MODEL);
  const timeoutMs = deps.timeoutMs ?? entry.timeoutMs;
  const started = Date.now();
  const base = (deps.baseUrl || "https://inference-api.openserv.ai/v1").replace(/\/$/, "");
  if (!deps.apiKey) {
    const proof = recordServProof(
      buildServProof({
        purpose: id,
        body,
        payload: null,
        headers: new Headers(),
        status: 0,
        ok: false,
        text: "",
        latencyMs: 0,
      }),
    );
    proof.promptGuard = "not_configured";
    return { ok: false, error: "SERV is not configured.", status: 0, proof, fallback: entry.fallback };
  }
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(`${base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    const proof = recordServProof(
      buildServProof({
        purpose: id,
        body,
        payload: null,
        headers: new Headers(),
        status: 0,
        ok: false,
        text: "",
        latencyMs: Date.now() - started,
      }),
    );
    return { ok: false, error: "SERV did not respond.", status: 0, proof, fallback: entry.fallback };
  }
  const json: unknown = await response.json().catch(() => null);
  const text = messageText(json);
  const proof = recordServProof(
    buildServProof({
      purpose: id,
      body,
      payload: json,
      headers: response.headers,
      status: response.status,
      ok: response.ok && Boolean(text),
      text,
      latencyMs: Date.now() - started,
    }),
  );
  if (!response.ok || !text) {
    return {
      ok: false,
      error: response.ok ? "SERV returned an empty explanation." : "SERV returned an error.",
      status: response.status,
      proof,
      fallback: entry.fallback,
    };
  }
  return { ok: true, text, model: proof.modelReported, shadowOutcome: proof.shadowOutcome, rawStatus: response.status, proof };
}
