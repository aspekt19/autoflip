/**
 * Agentic Find SERV loop — tools mode (preferred) or next_action fallback.
 * Model: gpt-6.1-sol only. No profile abort; SERV_HTTP_DEADLINE_MS on each HTTP.
 */
import {
  applyFindAgentGuardrails,
  FIND_AGENT_NEXT_ACTION_SCHEMA,
  FIND_AGENT_RESULT_SCHEMA,
  resolveFindAgentMode,
  validateFindAgentVerdict,
  type FindAgentMode,
  type FindAgentModeResolved,
  type FindAgentRelaxedCondition,
  type FindAgentVerdict,
} from "@/domain/find-agent";
import type { Listing } from "@/domain/types";
import { TtlCache } from "@/io/cache";
import { MemoryCounter } from "@/io/quota";
import { BASE_MODEL, messageText } from "@/server/serv";
import {
  buildServChatTurnBody,
  buildServResponsesTurnBody,
  postServChatTurn,
  postServResponsesTurn,
  type ServChatToolCallWire,
  type ServChatTurnMessage,
} from "@/server/serv/agent-chat-turn";
import { servApiBase, toolCall } from "@/server/serv/run";
import { servFinishReason } from "@/server/serv/response-failure";
import {
  createFindAgentToolState,
  executeFindAgentTool,
  findAgentResponsesTools,
  parseSearchListingsArgs,
  type FindAgentToolDeps,
  type FindAgentToolState,
} from "./tools";

export type FindAgentJournalServCall = {
  kind: "serv";
  responseId: string | null;
  model: string;
  latencyMs: number;
  mode: FindAgentModeResolved;
  finishReason: string | null;
  hadToolCalls: boolean;
};

export type FindAgentJournalToolCall = {
  kind: "tool";
  name: string;
  args: unknown;
  summary: string;
  ok: boolean;
};

export type FindAgentJournalEntry = FindAgentJournalServCall | FindAgentJournalToolCall;

export type FindAgentLoopDeps = {
  servKey: string;
  autodevKey: string;
  fetch?: typeof fetch;
  servBaseUrl?: string;
  /** Autodev cache/counter/reserve — tests inject MemoryCounter. */
  autodev?: FindAgentToolDeps["autodev"];
  seedListings?: readonly Listing[];
  budgetUsd?: number | null;
};

export type FindAgentLoopResult =
  | {
      ok: true;
      agentMode: FindAgentModeResolved;
      requestedMode: FindAgentMode;
      toolRounds: number;
      verdictReached: true;
      verdict: FindAgentVerdict;
      relaxedConditions: FindAgentRelaxedCondition[];
      journal: FindAgentJournalEntry[];
      knownVins: string[];
      listingsByVin: Map<string, Listing>;
      droppedPicks: Array<{ vin: string; reason: string }>;
    }
  | {
      ok: false;
      agentMode: FindAgentModeResolved | null;
      requestedMode: FindAgentMode;
      toolRounds: number;
      verdictReached: false;
      error: string;
      message: string;
      journal: FindAgentJournalEntry[];
      knownVins: string[];
    };

type ChatMessage = ServChatTurnMessage;
type ToolCallWire = ServChatToolCallWire;

function systemPrompt(note: string, formEdits?: Record<string, unknown> | null): string {
  const edits =
    formEdits && Object.keys(formEdits).length > 0
      ? `\nForm edits (structured overrides): ${JSON.stringify(formEdits)}`
      : "";
  return [
    "You are Lemonless Find's search agent on SERV (gpt-6.1-sol).",
    "You decide which listings to search. Prefer tight filters first.",
    "When results are empty or poor (see funnelHint on search_listings), relax soft conditions (radius, miles, year band, body, secondary models) and re-search. Hard budget and must-haves stay unless the shopper's note allows otherwise. Profit and sell-window are not inventory filters.",
    "Explain every relaxation in relaxedConditions when you finish.",
    "Finish only with picks whose VIN appeared in tool listing results. Never invent cars, prices, or VINs.",
    "offerUsd must be ≤ the shopper budget when a budget is known.",
    "Use tools for live evidence. Asking-price comps are not sold prices.",
    `Shopper note:\n${note.trim() || "(empty)"}${edits}`,
  ].join(" ");
}

function argumentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return JSON.stringify(value);
  return "{}";
}

function extractToolCalls(payload: unknown): ToolCallWire[] {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as { choices?: unknown; output?: unknown };
  const out: ToolCallWire[] = [];

  if (Array.isArray(record.choices) && record.choices[0] && typeof record.choices[0] === "object") {
    const calls = (record.choices[0] as { message?: { tool_calls?: unknown } }).message?.tool_calls;
    if (Array.isArray(calls)) {
      for (const item of calls) {
        if (!item || typeof item !== "object") continue;
        const call = item as {
          id?: unknown;
          type?: unknown;
          function?: { name?: unknown; arguments?: unknown };
        };
        const name = typeof call.function?.name === "string" ? call.function.name : "";
        if (!name || name.startsWith("serv_")) continue;
        const id =
          typeof call.id === "string" && call.id
            ? call.id
            : `call_${name}_${out.length}`;
        out.push({
          id,
          type: "function",
          function: { name, arguments: argumentText(call.function?.arguments) },
        });
      }
    }
  }

  if (Array.isArray(record.output)) {
    for (const item of record.output) {
      if (!item || typeof item !== "object") continue;
      const call = item as {
        type?: unknown;
        id?: unknown;
        call_id?: unknown;
        name?: unknown;
        arguments?: unknown;
      };
      if (call.type !== "function_call") continue;
      const name = typeof call.name === "string" ? call.name : "";
      if (!name || name.startsWith("serv_")) continue;
      const id =
        typeof call.id === "string" && call.id
          ? call.id
          : typeof call.call_id === "string" && call.call_id
            ? call.call_id
            : `call_${name}_${out.length}`;
      out.push({
        id,
        type: "function",
        function: { name, arguments: argumentText(call.arguments) },
      });
    }
  }

  if (out.length === 0) {
    const single = toolCall(payload);
    if (single) {
      out.push({
        id: single.id,
        type: "function",
        function: { name: single.name, arguments: single.arguments },
      });
    }
  }
  return out;
}

function responseIdOf(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const id = (payload as { id?: unknown }).id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

function parseJsonObject(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function postChat(input: {
  apiKey: string;
  baseUrl: string;
  fetch: typeof fetch;
  body: Record<string, unknown>;
}): Promise<{ ok: boolean; status: number; payload: unknown; latencyMs: number; error?: string }> {
  return postServChatTurn({
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    fetch: input.fetch,
    body: input.body,
  });
}

function chatBody(input: {
  messages: ChatMessage[];
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  maxTokens?: number;
}): Record<string, unknown> {
  return buildServChatTurnBody({
    messages: input.messages,
    jsonSchema: input.jsonSchema,
    maxTokens: input.maxTokens,
  });
}

function responsesBody(input: {
  instructions: string;
  input: string;
  tools: ReturnType<typeof findAgentResponsesTools>;
}): Record<string, unknown> {
  return buildServResponsesTurnBody({
    instructions: input.instructions,
    input: input.input,
    tools: input.tools,
    toolChoice: "auto",
    reasoning: { effort: "low", summary: "auto" },
  });
}

async function postResponses(input: {
  apiKey: string;
  baseUrl: string;
  fetch: typeof fetch;
  body: Record<string, unknown>;
}): Promise<{ ok: boolean; status: number; payload: unknown; latencyMs: number; error?: string }> {
  return postServResponsesTurn({
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    fetch: input.fetch,
    body: input.body,
  });
}

/** Execute tool calls; append JSON results for the next Responses `input`. */
async function runToolCalls(input: {
  calls: ToolCallWire[];
  deps: FindAgentToolDeps;
  state: FindAgentToolState;
  journal: FindAgentJournalEntry[];
  toolResultBlocks: string[];
  finishMessages: ChatMessage[];
}): Promise<number> {
  let rounds = 0;
  const assistantCalls = input.calls;
  input.finishMessages.push({
    role: "assistant",
    content: `Calling tools: ${assistantCalls.map((c) => c.function.name).join(", ")}`,
  });
  for (const call of assistantCalls) {
    rounds += 1;
    let args: unknown = {};
    try {
      args = JSON.parse(call.function.arguments || "{}") as unknown;
    } catch {
      args = {};
    }
    const executed = await executeFindAgentTool(call.function.name, args, input.deps, input.state);
    input.journal.push({
      kind: "tool",
      name: executed.name,
      args,
      summary: executed.summary,
      ok: executed.ok,
    });
    const resultJson = JSON.stringify(executed.result);
    input.toolResultBlocks.push(
      JSON.stringify({
        type: "function_call_output",
        call_id: call.id,
        name: executed.name,
        output: executed.result,
      }),
    );
    input.finishMessages.push({
      role: "user",
      content: `Tool result for ${executed.name} (call_id=${call.id}):\n${resultJson}`,
    });
  }
  return rounds;
}

function buildResponsesFollowUpInput(seedUser: string, toolResultBlocks: readonly string[]): string {
  if (toolResultBlocks.length === 0) return seedUser;
  return [
    seedUser,
    "Prior tool results (function_call_output JSON). Use them; call more tools if needed, or stop tool use when ready to finalize.",
    ...toolResultBlocks,
  ].join("\n\n");
}

async function finalizeVerdict(input: {
  apiKey: string;
  baseUrl: string;
  fetch: typeof fetch;
  note: string;
  formEdits?: Record<string, unknown> | null;
  state: FindAgentToolState;
  journal: FindAgentJournalEntry[];
  priorMessages: ChatMessage[];
  mode: FindAgentModeResolved;
  budgetUsd: number | null;
}): Promise<
  | { ok: true; verdict: FindAgentVerdict; dropped: Array<{ vin: string; reason: string }> }
  | { ok: false; error: string; message: string }
> {
  const vinList = [...input.state.knownVins].slice(0, 40);
  const finishUser = [
    "Return the final find_agent_result JSON now.",
    "picks[].vin must be copied exactly from tool listing results.",
    `Known VINs from tools: ${vinList.length ? vinList.join(", ") : "(none — pass with passReason)"}`,
    input.budgetUsd != null ? `Budget USD ceiling: ${input.budgetUsd}` : "Budget unknown.",
  ].join("\n");

  const messages: ChatMessage[] = [
    ...input.priorMessages,
    { role: "user", content: finishUser },
  ];

  const body = chatBody({
    messages,
    jsonSchema: { name: "find_agent_result", schema: FIND_AGENT_RESULT_SCHEMA as unknown as Record<string, unknown> },
  });
  const turn = await postChat({
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    fetch: input.fetch,
    body,
  });
  input.journal.push({
    kind: "serv",
    responseId: responseIdOf(turn.payload),
    model: BASE_MODEL,
    latencyMs: turn.latencyMs,
    mode: input.mode,
    finishReason: turn.payload ? servFinishReason(turn.payload) : null,
    hadToolCalls: false,
  });
  if (!turn.ok) {
    return {
      ok: false,
      error: "serv_http",
      message: turn.error || `SERV finish call failed (HTTP ${turn.status}).`,
    };
  }

  const text = messageText(turn.payload, "structured");
  let validated = validateFindAgentVerdict(parseJsonObject(text));
  if (!validated.ok) {
    const repairBody = chatBody({
      messages: [
        ...messages,
        { role: "assistant", content: text || "{}" },
        {
          role: "user",
          content: JSON.stringify({
            validationError: {
              message: "Previous reply failed validation. Fix these issues and return JSON only.",
              issues: validated.issues,
            },
          }),
        },
      ],
      jsonSchema: {
        name: "find_agent_result",
        schema: FIND_AGENT_RESULT_SCHEMA as unknown as Record<string, unknown>,
      },
    });
    const repair = await postChat({
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      fetch: input.fetch,
      body: repairBody,
    });
    input.journal.push({
      kind: "serv",
      responseId: responseIdOf(repair.payload),
      model: BASE_MODEL,
      latencyMs: repair.latencyMs,
      mode: input.mode,
      finishReason: repair.payload ? servFinishReason(repair.payload) : null,
      hadToolCalls: false,
    });
    if (!repair.ok) {
      return {
        ok: false,
        error: "serv_repair_http",
        message: repair.error || `SERV repair call failed (HTTP ${repair.status}).`,
      };
    }
    const repairText = messageText(repair.payload, "structured");
    validated = validateFindAgentVerdict(parseJsonObject(repairText));
    if (!validated.ok) {
      return {
        ok: false,
        error: "verdict_validation_failed",
        message: validated.issues.map((i) => i.message).join("; "),
      };
    }
  }

  const guarded = applyFindAgentGuardrails(validated.verdict, {
    allowedVins: input.state.knownVins,
    budgetUsd: input.budgetUsd,
  });
  return { ok: true, verdict: guarded.verdict, dropped: guarded.dropped };
}

async function runToolsMode(input: {
  note: string;
  formEdits?: Record<string, unknown> | null;
  deps: FindAgentLoopDeps;
  toolDeps: FindAgentToolDeps;
  state: FindAgentToolState;
  journal: FindAgentJournalEntry[];
  maxRounds: number;
  baseUrl: string;
  fetchImpl: typeof fetch;
}): Promise<FindAgentLoopResult> {
  const requestedMode = resolveFindAgentMode(process.env);
  const instructions = systemPrompt(input.note, input.formEdits);
  const seedUser =
    "Search for cars that fit the shopper. Call tools as needed, then stop tool use when ready so we can finalize the verdict.";
  // Chat transcript for the finish json_schema turn (proven path); tools rounds use Responses.
  const finishMessages: ChatMessage[] = [
    { role: "system", content: instructions },
    { role: "user", content: seedUser },
  ];
  const tools = findAgentResponsesTools();
  const toolResultBlocks: string[] = [];
  let toolRounds = 0;
  let firstTurn = true;

  for (let round = 0; round < input.maxRounds; round += 1) {
    const body = responsesBody({
      instructions,
      input: buildResponsesFollowUpInput(seedUser, toolResultBlocks),
      tools,
    });
    const turn = await postResponses({
      apiKey: input.deps.servKey,
      baseUrl: input.baseUrl,
      fetch: input.fetchImpl,
      body,
    });
    const calls = turn.ok ? extractToolCalls(turn.payload) : [];
    input.journal.push({
      kind: "serv",
      responseId: responseIdOf(turn.payload),
      model: BASE_MODEL,
      latencyMs: turn.latencyMs,
      mode: "tools",
      finishReason: turn.payload ? servFinishReason(turn.payload) : null,
      hadToolCalls: calls.length > 0,
    });

    if (!turn.ok) {
      return {
        ok: false,
        agentMode: "tools",
        requestedMode,
        toolRounds,
        verdictReached: false,
        error: "serv_http",
        message: turn.error || `SERV tools call failed (HTTP ${turn.status}).`,
        journal: input.journal,
        knownVins: [...input.state.knownVins],
      };
    }

    if (firstTurn && calls.length === 0) {
      const text = messageText(turn.payload, "legacy");
      const maybe = validateFindAgentVerdict(parseJsonObject(text));
      if (!maybe.ok) {
        return {
          ok: false,
          agentMode: "tools",
          requestedMode,
          toolRounds,
          verdictReached: false,
          error: "tools_unsupported_or_empty",
          message: "First tools-mode response had no tool_calls and no usable finish.",
          journal: input.journal,
          knownVins: [...input.state.knownVins],
        };
      }
    }
    firstTurn = false;

    if (calls.length > 0) {
      toolRounds += await runToolCalls({
        calls,
        deps: input.toolDeps,
        state: input.state,
        journal: input.journal,
        toolResultBlocks,
        finishMessages,
      });
      continue;
    }

    // No tool calls → finalize structured verdict on chat json_schema.
    const finished = await finalizeVerdict({
      apiKey: input.deps.servKey,
      baseUrl: input.baseUrl,
      fetch: input.fetchImpl,
      note: input.note,
      formEdits: input.formEdits,
      state: input.state,
      journal: input.journal,
      priorMessages: finishMessages,
      mode: "tools",
      budgetUsd: input.deps.budgetUsd ?? null,
    });
    if (!finished.ok) {
      return {
        ok: false,
        agentMode: "tools",
        requestedMode,
        toolRounds,
        verdictReached: false,
        error: finished.error,
        message: finished.message,
        journal: input.journal,
        knownVins: [...input.state.knownVins],
      };
    }
    return {
      ok: true,
      agentMode: "tools",
      requestedMode,
      toolRounds,
      verdictReached: true,
      verdict: finished.verdict,
      relaxedConditions: finished.verdict.relaxedConditions,
      journal: input.journal,
      knownVins: [...input.state.knownVins],
      listingsByVin: input.state.listingsByVin,
      droppedPicks: finished.dropped,
    };
  }

  return {
    ok: false,
    agentMode: "tools",
    requestedMode,
    toolRounds,
    verdictReached: false,
    error: "max_rounds",
    message: `Hit runaway guard maxRounds=${input.maxRounds}.`,
    journal: input.journal,
    knownVins: [...input.state.knownVins],
  };
}

async function runNextActionMode(input: {
  note: string;
  formEdits?: Record<string, unknown> | null;
  deps: FindAgentLoopDeps;
  toolDeps: FindAgentToolDeps;
  state: FindAgentToolState;
  journal: FindAgentJournalEntry[];
  maxRounds: number;
  baseUrl: string;
  fetchImpl: typeof fetch;
}): Promise<FindAgentLoopResult> {
  const requestedMode = resolveFindAgentMode(process.env);
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        systemPrompt(input.note, input.formEdits),
        "Each turn return JSON with action search or finish.",
        "search runs search_listings with the provided filters.",
        "finish must include the find_agent_result fields (summary, confidence, picks, relaxedConditions, passReason).",
      ].join(" "),
    },
    { role: "user", content: "Begin. Prefer a focused search first." },
  ];
  let toolRounds = 0;

  for (let round = 0; round < input.maxRounds; round += 1) {
    const body = chatBody({
      messages,
      jsonSchema: {
        name: "find_agent_next_action",
        schema: FIND_AGENT_NEXT_ACTION_SCHEMA as unknown as Record<string, unknown>,
      },
    });
    const turn = await postChat({
      apiKey: input.deps.servKey,
      baseUrl: input.baseUrl,
      fetch: input.fetchImpl,
      body,
    });
    input.journal.push({
      kind: "serv",
      responseId: responseIdOf(turn.payload),
      model: BASE_MODEL,
      latencyMs: turn.latencyMs,
      mode: "next_action",
      finishReason: turn.payload ? servFinishReason(turn.payload) : null,
      hadToolCalls: false,
    });
    if (!turn.ok) {
      return {
        ok: false,
        agentMode: "next_action",
        requestedMode,
        toolRounds,
        verdictReached: false,
        error: "serv_http",
        message: turn.error || `SERV next_action call failed (HTTP ${turn.status}).`,
        journal: input.journal,
        knownVins: [...input.state.knownVins],
      };
    }

    const text = messageText(turn.payload, "structured");
    let parsed = parseJsonObject(text);
    if (!parsed || typeof parsed !== "object") {
      const repairBody = chatBody({
        messages: [
          ...messages,
          { role: "assistant", content: text || "{}" },
          {
            role: "user",
            content: JSON.stringify({
              validationError: {
                message: "Previous reply was not valid JSON for find_agent_next_action. Fix and return JSON only.",
                issues: [{ field: "action", message: "Expected search|finish object." }],
              },
            }),
          },
        ],
        jsonSchema: {
          name: "find_agent_next_action",
          schema: FIND_AGENT_NEXT_ACTION_SCHEMA as unknown as Record<string, unknown>,
        },
      });
      const repair = await postChat({
        apiKey: input.deps.servKey,
        baseUrl: input.baseUrl,
        fetch: input.fetchImpl,
        body: repairBody,
      });
      input.journal.push({
        kind: "serv",
        responseId: responseIdOf(repair.payload),
        model: BASE_MODEL,
        latencyMs: repair.latencyMs,
        mode: "next_action",
        finishReason: repair.payload ? servFinishReason(repair.payload) : null,
        hadToolCalls: false,
      });
      if (!repair.ok) {
        return {
          ok: false,
          agentMode: "next_action",
          requestedMode,
          toolRounds,
          verdictReached: false,
          error: "serv_repair_http",
          message: repair.error || `SERV next_action repair failed (HTTP ${repair.status}).`,
          journal: input.journal,
          knownVins: [...input.state.knownVins],
        };
      }
      parsed = parseJsonObject(messageText(repair.payload, "structured"));
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false,
        agentMode: "next_action",
        requestedMode,
        toolRounds,
        verdictReached: false,
        error: "next_action_parse",
        message: "Could not parse next_action JSON.",
        journal: input.journal,
        knownVins: [...input.state.knownVins],
      };
    }

    const row = parsed as Record<string, unknown>;
    const action = typeof row.action === "string" ? row.action.trim().toLowerCase() : "";
    messages.push({ role: "assistant", content: JSON.stringify(parsed) });

    if (action === "search") {
      const searchArgs = parseSearchListingsArgs(row);
      const argsValue = searchArgs.ok ? searchArgs.value : row;
      const executed = await executeFindAgentTool(
        "search_listings",
        argsValue,
        input.toolDeps,
        input.state,
      );
      toolRounds += 1;
      input.journal.push({
        kind: "tool",
        name: executed.name,
        args: argsValue,
        summary: executed.summary,
        ok: executed.ok,
      });
      messages.push({
        role: "user",
        content: `Tool result for search_listings:\n${JSON.stringify(executed.result)}\nContinue with action search or finish.`,
      });
      continue;
    }

    if (action === "finish") {
      let validated = validateFindAgentVerdict(parsed);
      if (!validated.ok) {
        const repairBody = chatBody({
          messages: [
            ...messages,
            {
              role: "user",
              content: JSON.stringify({
                validationError: {
                  message: "Finish payload failed validation. Return a corrected finish action JSON.",
                  issues: validated.issues,
                },
              }),
            },
          ],
          jsonSchema: {
            name: "find_agent_next_action",
            schema: FIND_AGENT_NEXT_ACTION_SCHEMA as unknown as Record<string, unknown>,
          },
        });
        const repair = await postChat({
          apiKey: input.deps.servKey,
          baseUrl: input.baseUrl,
          fetch: input.fetchImpl,
          body: repairBody,
        });
        input.journal.push({
          kind: "serv",
          responseId: responseIdOf(repair.payload),
          model: BASE_MODEL,
          latencyMs: repair.latencyMs,
          mode: "next_action",
          finishReason: repair.payload ? servFinishReason(repair.payload) : null,
          hadToolCalls: false,
        });
        if (!repair.ok) {
          return {
            ok: false,
            agentMode: "next_action",
            requestedMode,
            toolRounds,
            verdictReached: false,
            error: "serv_repair_http",
            message: repair.error || "SERV finish repair failed.",
            journal: input.journal,
            knownVins: [...input.state.knownVins],
          };
        }
        const repaired = parseJsonObject(messageText(repair.payload, "structured"));
        validated = validateFindAgentVerdict(repaired);
        if (!validated.ok) {
          return {
            ok: false,
            agentMode: "next_action",
            requestedMode,
            toolRounds,
            verdictReached: false,
            error: "verdict_validation_failed",
            message: validated.issues.map((i) => i.message).join("; "),
            journal: input.journal,
            knownVins: [...input.state.knownVins],
          };
        }
      }

      const guarded = applyFindAgentGuardrails(validated.verdict, {
        allowedVins: input.state.knownVins,
        budgetUsd: input.deps.budgetUsd ?? null,
      });
      return {
        ok: true,
        agentMode: "next_action",
        requestedMode,
        toolRounds,
        verdictReached: true,
        verdict: guarded.verdict,
        relaxedConditions: guarded.verdict.relaxedConditions,
        journal: input.journal,
        knownVins: [...input.state.knownVins],
        listingsByVin: input.state.listingsByVin,
        droppedPicks: guarded.dropped,
      };
    }

    messages.push({
      role: "user",
      content: 'action must be "search" or "finish". Try again.',
    });
  }

  return {
    ok: false,
    agentMode: "next_action",
    requestedMode,
    toolRounds,
    verdictReached: false,
    error: "max_rounds",
    message: `Hit runaway guard maxRounds=${input.maxRounds}.`,
    journal: input.journal,
    knownVins: [...input.state.knownVins],
  };
}

/**
 * Run the Find agentic SERV loop.
 * maxRounds is a runaway guard only — not a wall-clock timeout.
 */
export async function runFindAgentLoop(input: {
  note: string;
  mode?: FindAgentMode;
  formEdits?: Record<string, unknown> | null;
  deps: FindAgentLoopDeps;
  maxRounds?: number;
}): Promise<FindAgentLoopResult> {
  const requestedMode = input.mode ?? resolveFindAgentMode(process.env);
  const maxRounds = input.maxRounds ?? 40;
  const fetchImpl = input.deps.fetch ?? fetch;
  const baseUrl = servApiBase(input.deps.servBaseUrl);
  const journal: FindAgentJournalEntry[] = [];
  const state = createFindAgentToolState(input.deps.seedListings);
  const toolDeps: FindAgentToolDeps = {
    fetch: fetchImpl,
    autodevKey: input.deps.autodevKey,
    autodev: input.deps.autodev ?? {
      cache: new TtlCache<unknown>(),
      counter: new MemoryCounter(),
    },
    seedListings: input.deps.seedListings,
  };

  const shared = {
    note: input.note,
    formEdits: input.formEdits,
    deps: input.deps,
    toolDeps,
    state,
    journal,
    maxRounds,
    baseUrl,
    fetchImpl,
  };

  if (requestedMode === "next_action") {
    return runNextActionMode(shared);
  }

  if (requestedMode === "tools") {
    return runToolsMode(shared);
  }

  // auto: Responses tools first; fall back to next_action on empty tools or SERV HTTP failure.
  const toolsAttempt = await runToolsMode(shared);
  if (toolsAttempt.ok) return toolsAttempt;
  if (toolsAttempt.error !== "tools_unsupported_or_empty" && toolsAttempt.error !== "serv_http") {
    return toolsAttempt;
  }

  journal.push({
    kind: "tool",
    name: "_mode_fallback",
    args: { from: "tools", to: "next_action", reason: toolsAttempt.error },
    summary: `auto mode fell back to next_action after tools error=${toolsAttempt.error}`,
    ok: true,
  });

  return runNextActionMode({
    ...shared,
    // Fresh message transcript; keep tool state + journal across the mode switch.
  });
}

/** Journal step counts for eval reports. */
export function summarizeFindAgentJournal(journal: readonly FindAgentJournalEntry[]): {
  servCalls: number;
  toolCalls: number;
  toolRounds: number;
} {
  let servCalls = 0;
  let toolCalls = 0;
  for (const entry of journal) {
    if (entry.kind === "serv") servCalls += 1;
    else if (entry.kind === "tool" && entry.name !== "_mode_fallback") toolCalls += 1;
  }
  return { servCalls, toolCalls, toolRounds: toolCalls };
}
