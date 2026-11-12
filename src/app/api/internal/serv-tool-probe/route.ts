/**
 * POST /api/internal/serv-tool-probe
 *
 * Auth: Bearer CRON_SECRET or RADAR_CRON_SECRET.
 * One cheap gpt-6.1-sol chat.completions call with tools + tool_choice=required
 * to verify OpenServ returns tool_calls. Never charges report credits.
 */
import { BASE_MODEL, SERV_OUTPUT_TOKEN_DEFAULT } from "@/server/serv";
import { buildServChatTurnBody, postServChatTurn } from "@/server/serv/agent-chat-turn";
import { toolCall } from "@/server/serv/run";
import { servFinishReason } from "@/server/serv/response-failure";
import { bearer, secretMatch } from "@/server/secrets";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  const radar = process.env.RADAR_CRON_SECRET?.trim() ?? "";
  const vercel = process.env.CRON_SECRET?.trim() ?? "";
  if (!radar && !vercel) {
    return Response.json(
      { error: "not_configured", message: "RADAR_CRON_SECRET (or CRON_SECRET) is not set." },
      { status: 503 },
    );
  }
  const token = bearer(request);
  const authed = (radar && secretMatch(token, radar)) || (vercel && secretMatch(token, vercel));
  if (!authed) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.SERV_API_KEY?.trim() ?? "";
  if (!apiKey) {
    return Response.json(
      {
        supported: false,
        responseId: null,
        finishReason: null,
        toolCalls: null,
        error: "SERV_API_KEY is not set",
      },
      { status: 503 },
    );
  }

  const body = buildServChatTurnBody({
    model: BASE_MODEL,
    reasoningEffort: "low",
    maxTokens: Math.min(1024, SERV_OUTPUT_TOKEN_DEFAULT),
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
            properties: { ping: { type: "string" } },
            required: ["ping"],
          },
        },
      },
    ],
    toolChoice: "required",
  });

  const turn = await postServChatTurn({
    apiKey,
    baseUrl: process.env.SERV_BASE_URL,
    body,
  });
  const call = turn.ok ? toolCall(turn.payload) : null;
  const finishReason = turn.payload ? servFinishReason(turn.payload) : null;
  const responseId =
    turn.payload && typeof turn.payload === "object" && typeof (turn.payload as { id?: unknown }).id === "string"
      ? ((turn.payload as { id: string }).id as string)
      : null;

  if (!turn.ok) {
    return Response.json({
      supported: false,
      responseId,
      finishReason,
      toolCalls: null,
      error: turn.error || `HTTP ${turn.status}`,
      latencyMs: turn.latencyMs,
    });
  }

  return Response.json({
    supported: Boolean(call && call.name === "echo_ping"),
    responseId,
    finishReason,
    toolCalls: call ? [{ id: call.id, name: call.name, arguments: call.arguments }] : null,
    error: null,
    latencyMs: turn.latencyMs,
    model: BASE_MODEL,
  });
}
