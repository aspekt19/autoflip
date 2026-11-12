/**
 * Cheap live probe: does SERV return tool_calls for chat.completions?
 * Prints JSON only — never prints the API key.
 *
 *   SERV_API_KEY=… npm run probe:serv-tools
 */
import { BASE_MODEL, SERV_OUTPUT_TOKEN_DEFAULT, withServOutputTokenBound } from "../src/server/serv";
import { servApiBase, toolCall } from "../src/server/serv/run";
import { servFinishReason } from "../src/server/serv/response-failure";

type ProbeResult = {
  supported: boolean;
  responseId: string | null;
  finishReason: string | null;
  toolCalls: Array<{ id: string; name: string; arguments: string }> | null;
  error: string | null;
};

async function main(): Promise<number> {
  const apiKey = process.env.SERV_API_KEY?.trim() || "";
  if (!apiKey) {
    const out: ProbeResult = {
      supported: false,
      responseId: null,
      finishReason: null,
      toolCalls: null,
      error: "SERV_API_KEY is not set — probe not run.",
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return 0;
  }

  const base = servApiBase(process.env.SERV_BASE_URL);
  const body = withServOutputTokenBound(
    "chat",
    {
      model: BASE_MODEL,
      stream: false,
      reasoning_effort: "none",
      messages: [
        {
          role: "system",
          content: "You are a tool-calling probe. Call echo_ping exactly once with ping set to pong.",
        },
        { role: "user", content: "Please call echo_ping now." },
      ],
      tools: [
        {
          type: "function",
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
      ],
      tool_choice: "required",
    },
    Math.min(1024, SERV_OUTPUT_TOKEN_DEFAULT),
  );

  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const payload: unknown = await response.json().catch(() => null);
    const call = toolCall(payload);
    const finishReason = payload ? servFinishReason(payload) : null;
    const responseId =
      payload && typeof payload === "object" && typeof (payload as { id?: unknown }).id === "string"
        ? ((payload as { id: string }).id as string)
        : null;

    if (!response.ok) {
      const out: ProbeResult = {
        supported: false,
        responseId,
        finishReason,
        toolCalls: null,
        error: `HTTP ${response.status}`,
      };
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      return 0;
    }

    const out: ProbeResult = {
      supported: Boolean(call && call.name === "echo_ping"),
      responseId,
      finishReason,
      toolCalls: call ? [{ id: call.id, name: call.name, arguments: call.arguments }] : null,
      error: null,
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return 0;
  } catch (err) {
    const out: ProbeResult = {
      supported: false,
      responseId: null,
      finishReason: null,
      toolCalls: null,
      error: err instanceof Error ? err.message : "probe failed",
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return 0;
  }
}

main().then((code) => process.exit(code));
