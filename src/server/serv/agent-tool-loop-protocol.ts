/**
 * OpenServ /v1/responses multi-turn tool protocol for agentic Find/Resale.
 *
 * Live gpt-6.1-sol contract (owner probe):
 * - Chat + function tools → 400 (reasoning_effort catch-22). Use /v1/responses.
 * - System/developer content is required (via `instructions` and/or input messages).
 * - Turn N+1 input = prior input + output items of type `reasoning` and
 *   `function_call` + one `{type:'function_call_output', call_id, output}` per call_id.
 * - Missing any tool output → 400 "No tool output found".
 * - Parallel function_call items are normal; answer every call_id.
 */

export type ResponsesInputItem = Record<string, unknown>;

export type ResponsesFunctionCall = {
  /** Prefer Responses `call_id` (required for function_call_output). */
  callId: string;
  name: string;
  arguments: string;
  /** Original output item — echo back on the next turn. */
  raw: ResponsesInputItem;
};

export type ResponsesFunctionCallOutput = {
  type: "function_call_output";
  call_id: string;
  output: string;
};

function argumentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return JSON.stringify(value);
  return "{}";
}

/** User message item for Responses `input` arrays. */
export function responsesUserMessage(text: string): ResponsesInputItem {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  };
}

/**
 * Keep reasoning + function_call items from a Responses `output` array so the
 * next turn preserves the model's reasoning state (live requirement).
 */
export function keepResponsesLoopItems(output: unknown): ResponsesInputItem[] {
  if (!Array.isArray(output)) return [];
  const kept: ResponsesInputItem[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as ResponsesInputItem;
    const type = typeof row.type === "string" ? row.type : "";
    if (type === "reasoning" || type === "function_call") {
      kept.push(row);
    }
  }
  return kept;
}

/**
 * Extract parallel function_call items. Prefer `call_id` over `id` — function_call_output
 * must reference call_id or SERV returns 400.
 */
export function extractResponsesFunctionCalls(output: unknown): ResponsesFunctionCall[] {
  if (!Array.isArray(output)) return [];
  const out: ResponsesFunctionCall[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as ResponsesInputItem;
    if (row.type !== "function_call") continue;
    const name = typeof row.name === "string" ? row.name : "";
    if (!name || name.startsWith("serv_")) continue;
    const callId =
      typeof row.call_id === "string" && row.call_id
        ? row.call_id
        : typeof row.id === "string" && row.id
          ? row.id
          : `call_${name}_${out.length}`;
    out.push({
      callId,
      name,
      arguments: argumentText(row.arguments),
      raw: row,
    });
  }
  return out;
}

export function responsesFunctionCallOutput(
  callId: string,
  output: unknown,
): ResponsesFunctionCallOutput {
  return {
    type: "function_call_output",
    call_id: callId,
    output: typeof output === "string" ? output : JSON.stringify(output),
  };
}

/**
 * Build the next-turn `input`: prior input + kept reasoning/function_call items
 * + one function_call_output per call (parallel-safe).
 */
export function appendResponsesToolRound(input: {
  priorInput: readonly ResponsesInputItem[];
  responseOutput: unknown;
  outputs: ReadonlyArray<{ callId: string; output: unknown }>;
}): ResponsesInputItem[] {
  const kept = keepResponsesLoopItems(input.responseOutput);
  const byCallId = new Map(input.outputs.map((row) => [row.callId, row.output]));
  const calls = extractResponsesFunctionCalls(input.responseOutput);
  const callOutputs: ResponsesFunctionCallOutput[] = [];
  for (const call of calls) {
    const payload = byCallId.has(call.callId)
      ? byCallId.get(call.callId)
      : { error: "missing_tool_output", call_id: call.callId, name: call.name };
    callOutputs.push(responsesFunctionCallOutput(call.callId, payload));
  }
  // Any extra outputs the caller supplied (should not happen) — still emit to avoid orphans.
  for (const [callId, payload] of byCallId) {
    if (calls.some((c) => c.callId === callId)) continue;
    callOutputs.push(responsesFunctionCallOutput(callId, payload));
  }
  return [...input.priorInput, ...kept, ...callOutputs];
}

export function responsesOutputOf(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return null;
  return (payload as { output?: unknown }).output ?? null;
}
