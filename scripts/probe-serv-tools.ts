/**
 * Cheap live probe: does SERV return tool_calls for chat.completions?
 * Prints JSON only — never prints the API key.
 *
 * Tries a few request shapes (tool_choice required → auto; with/without
 * reasoning_effort) so a single 400 does not hide support.
 *
 *   SERV_API_KEY=… npm run probe:serv-tools
 */
import { BASE_MODEL, SERV_OUTPUT_TOKEN_DEFAULT, withServOutputTokenBound } from "../src/server/serv";
import { servApiBase, toolCall } from "../src/server/serv/run";
import { servFinishReason } from "../src/server/serv/response-failure";

type ProbeAttempt = {
  label: string;
  supported: boolean;
  responseId: string | null;
  finishReason: string | null;
  toolCalls: Array<{ id: string; name: string; arguments: string }> | null;
  httpStatus: number | null;
  upstream: string | null;
  error: string | null;
};

type ProbeResult = {
  supported: boolean;
  responseId: string | null;
  finishReason: string | null;
  toolCalls: Array<{ id: string; name: string; arguments: string }> | null;
  error: string | null;
  winningLabel: string | null;
  attempts: ProbeAttempt[];
};

function redactUpstream(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const err = (payload as { error?: unknown }).error;
  if (typeof err === "string") return err.slice(0, 500);
  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    const type = (err as { type?: unknown }).type;
    const code = (err as { code?: unknown }).code;
    const parts = [
      typeof type === "string" ? type : null,
      typeof code === "string" ? code : null,
      typeof message === "string" ? message.replace(/sk-[a-zA-Z0-9_-]+/g, "sk-REDACTED") : null,
    ].filter(Boolean);
    return parts.join(": ").slice(0, 800) || null;
  }
  return null;
}

function responseIdOf(payload: unknown): string | null {
  return payload && typeof payload === "object" && typeof (payload as { id?: unknown }).id === "string"
    ? ((payload as { id: string }).id as string)
    : null;
}

function echoTools() {
  return [
    {
      type: "function" as const,
      function: {
        name: "echo_ping",
        description: "Echo a ping string for the probe.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            ping: { type: "string" },
          },
          required: ["ping"],
        },
      },
    },
  ];
}

async function attemptAt(input: {
  apiKey: string;
  base: string;
  path: "/chat/completions" | "/responses";
  label: string;
  body: Record<string, unknown>;
}): Promise<ProbeAttempt> {
  try {
    const response = await fetch(`${input.base}${input.path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input.body),
    });
    const payload: unknown = await response.json().catch(() => null);
    const call = toolCall(payload);
    const finishReason = payload ? servFinishReason(payload) : null;
    const responseId = responseIdOf(payload);
    const upstream = redactUpstream(payload);
    if (!response.ok) {
      return {
        label: input.label,
        supported: false,
        responseId,
        finishReason,
        toolCalls: null,
        httpStatus: response.status,
        upstream,
        error: `HTTP ${response.status}`,
      };
    }
    return {
      label: input.label,
      supported: Boolean(call && call.name === "echo_ping"),
      responseId,
      finishReason,
      toolCalls: call ? [{ id: call.id, name: call.name, arguments: call.arguments }] : null,
      httpStatus: response.status,
      upstream,
      error: null,
    };
  } catch (err) {
    return {
      label: input.label,
      supported: false,
      responseId: null,
      finishReason: null,
      toolCalls: null,
      httpStatus: null,
      upstream: null,
      error: err instanceof Error ? err.message : "probe failed",
    };
  }
}

async function attempt(input: {
  apiKey: string;
  base: string;
  label: string;
  body: Record<string, unknown>;
}): Promise<ProbeAttempt> {
  return attemptAt({ ...input, path: "/chat/completions" });
}

async function attemptResponses(input: {
  apiKey: string;
  base: string;
  label: string;
  body: Record<string, unknown>;
}): Promise<ProbeAttempt> {
  return attemptAt({ ...input, path: "/responses" });
}

async function main(): Promise<number> {
  const apiKey = process.env.SERV_API_KEY?.trim() || "";
  if (!apiKey) {
    const out: ProbeResult = {
      supported: false,
      responseId: null,
      finishReason: null,
      toolCalls: null,
      error: "SERV_API_KEY is not set — probe not run.",
      winningLabel: null,
      attempts: [],
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return 0;
  }

  const base = servApiBase(process.env.SERV_BASE_URL);
  const messages = [
    {
      role: "system",
      content: "You are a tool-calling probe. Call echo_ping exactly once with ping set to pong.",
    },
    { role: "user", content: "Please call echo_ping now." },
  ];
  const tools = echoTools();
  const tokens = Math.min(1024, SERV_OUTPUT_TOKEN_DEFAULT);

  const chatShapes: Array<{ label: string; body: Record<string, unknown> }> = [
    {
      label: "chat:tool_choice=required,reasoning_effort=none",
      body: withServOutputTokenBound(
        "chat",
        {
          model: BASE_MODEL,
          stream: false,
          reasoning_effort: "none",
          messages,
          tools,
          tool_choice: "required",
        },
        tokens,
      ),
    },
    {
      label: "chat:tool_choice=auto,reasoning_effort=low",
      body: withServOutputTokenBound(
        "chat",
        {
          model: BASE_MODEL,
          stream: false,
          reasoning_effort: "low",
          messages,
          tools,
          tool_choice: "auto",
        },
        tokens,
      ),
    },
    {
      label: "chat:tool_choice=auto,no_reasoning_effort",
      body: withServOutputTokenBound(
        "chat",
        {
          model: BASE_MODEL,
          stream: false,
          messages,
          tools,
          tool_choice: "auto",
        },
        tokens,
      ),
    },
  ];

  // Flat Responses tool shape (name at top level), matching run.ts factsTool("responses").
  const responsesTools = [
    {
      type: "function" as const,
      name: "echo_ping",
      description: "Echo a ping string for the probe.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { ping: { type: "string" } },
        required: ["ping"],
      },
    },
  ];
  const responsesShapes: Array<{ label: string; body: Record<string, unknown> }> = [
    {
      label: "responses:tools+reasoning.low",
      body: withServOutputTokenBound(
        "responses",
        {
          model: BASE_MODEL,
          instructions: "You are a tool-calling probe. Call echo_ping exactly once with ping set to pong.",
          input: "Please call echo_ping now.",
          reasoning: { effort: "low", summary: "auto" },
          stream: false,
          tools: responsesTools,
          tool_choice: "auto",
        },
        tokens,
      ),
    },
    {
      label: "responses:tools+tool_choice.required",
      body: withServOutputTokenBound(
        "responses",
        {
          model: BASE_MODEL,
          instructions: "You are a tool-calling probe. Call echo_ping exactly once with ping set to pong.",
          input: "Please call echo_ping now.",
          reasoning: { effort: "low", summary: "auto" },
          stream: false,
          tools: responsesTools,
          tool_choice: "required",
        },
        tokens,
      ),
    },
  ];

  const attempts: ProbeAttempt[] = [];
  let winner: ProbeAttempt | null = null;
  for (const shape of chatShapes) {
    const result = await attempt({ apiKey, base, label: shape.label, body: shape.body });
    attempts.push(result);
    if (result.supported) {
      winner = result;
      break;
    }
  }
  if (!winner) {
    for (const shape of responsesShapes) {
      const result = await attemptResponses({ apiKey, base, label: shape.label, body: shape.body });
      attempts.push(result);
      if (result.supported) {
        winner = result;
        break;
      }
    }
  }

  const out: ProbeResult = {
    supported: Boolean(winner?.supported),
    responseId: winner?.responseId ?? attempts.find((a) => a.responseId)?.responseId ?? null,
    finishReason: winner?.finishReason ?? null,
    toolCalls: winner?.toolCalls ?? null,
    error: winner ? null : attempts.map((a) => `${a.label}: ${a.error}${a.upstream ? ` (${a.upstream})` : ""}`).join(" | "),
    winningLabel: winner?.label ?? null,
    attempts,
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  return 0;
}

main().then((code) => process.exit(code));
