/**
 * Agentic Resale SERV loop — tools mode (preferred) or next_action fallback.
 * Model: gpt-6.1-sol only. Code owns PnL; SERV picks flips with justification.
 */
import {
  applyResaleAgentGuardrails,
  RESALE_AGENT_NEXT_ACTION_SCHEMA,
  RESALE_AGENT_RESULT_SCHEMA,
  resolveResaleAgentMode,
  validateResaleAgentVerdict,
  validateResaleSubmitPicks,
  type ResaleAgentMode,
  type ResaleAgentModeResolved,
  type ResaleAgentRelaxedCondition,
  type ResaleAgentVerdict,
} from "@/domain/resale-agent";
import type { BuildResalePnlOptions, ResaleCandidatePnl } from "@/domain/resale-pnl";
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
import {
  appendResponsesToolRound,
  extractResponsesFunctionCalls,
  responsesOutputOf,
  responsesUserMessage,
  type ResponsesInputItem,
} from "@/server/serv/agent-tool-loop-protocol";
import { servApiBase, toolCall } from "@/server/serv/run";
import { servFinishReason } from "@/server/serv/response-failure";
import {
  createResaleAgentToolState,
  executeResaleAgentTool,
  parseSearchListingsArgs,
  pnlFactsFromState,
  resaleAgentResponsesTools,
  type ResaleAgentToolDeps,
  type ResaleAgentToolState,
} from "./tools";

export type ResaleAgentJournalServCall = {
  kind: "serv";
  responseId: string | null;
  model: string;
  latencyMs: number;
  mode: ResaleAgentModeResolved;
  finishReason: string | null;
  hadToolCalls: boolean;
};

export type ResaleAgentJournalToolCall = {
  kind: "tool";
  name: string;
  args: unknown;
  summary: string;
  ok: boolean;
};

export type ResaleAgentJournalEntry = ResaleAgentJournalServCall | ResaleAgentJournalToolCall;

export type ResaleAgentLoopDeps = {
  servKey: string;
  autodevKey: string;
  fetch?: typeof fetch;
  servBaseUrl?: string;
  autodev?: ResaleAgentToolDeps["autodev"];
  seedListings?: readonly Listing[];
  budgetUsd?: number | null;
  pnlOptions?: BuildResalePnlOptions;
  /** Shopper brief extras (zip, repair skill, sell window, etc.). */
  shopperContext?: Record<string, unknown> | null;
};

export type ResaleAgentLoopResult =
  | {
      ok: true;
      agentMode: ResaleAgentModeResolved;
      requestedMode: ResaleAgentMode;
      toolRounds: number;
      verdictReached: true;
      verdict: ResaleAgentVerdict;
      relaxedConditions: ResaleAgentRelaxedCondition[];
      journal: ResaleAgentJournalEntry[];
      knownVins: string[];
      listingsByVin: Map<string, Listing>;
      pnlByVin: Map<string, ResaleCandidatePnl>;
      droppedPicks: Array<{ vin: string; reason: string }>;
    }
  | {
      ok: false;
      agentMode: ResaleAgentModeResolved | null;
      requestedMode: ResaleAgentMode;
      toolRounds: number;
      verdictReached: false;
      error: string;
      message: string;
      journal: ResaleAgentJournalEntry[];
      knownVins: string[];
    };

type ChatMessage = ServChatTurnMessage;
type ToolCallWire = ServChatToolCallWire;

function systemPrompt(note: string, shopperContext?: Record<string, unknown> | null): string {
  const ctx =
    shopperContext && Object.keys(shopperContext).length > 0
      ? `\nShopper structured context: ${JSON.stringify(shopperContext)}`
      : "";
  return [
    "You are Lemonless Resale's flip shopper agent on SERV (gpt-6.1-sol).",
    "You decide which listings to search for profitable flips given budget, region, and flip goal.",
    "Prefer tight filters first. When results are empty or weak, relax soft filters (radius, miles, year, secondary models) and re-search.",
    "Hard budget stays unless the shopper note allows otherwise. Explain every relaxation in relaxedConditions.",
    "Finish only with flip picks whose VIN appeared in tool listing results. Never invent cars, prices, or VINs.",
    "Dollar facts for fees, tax, recon, and expected resale come ONLY from tool flipPnl / get_flip_pnl — never invent those numbers.",
    "Profit floors and sell-within-N-days are ranking/verdict signals — never hard inventory filters. When search_listings returns funnel counts or relaxHints, relax the step that hit zero (omit_body / widen_radius / raise_price / drop_transmission) and re-search. Prefer bodyFamily=car; never rely on provider Sedan.",
    "Pick buy|negotiate only when code mid-profit is positive; otherwise pass or needs_inspection with justification.",
    "Finish by calling submit_picks. Code validates real VINs, offer ≤ budget/asking, and buy|negotiate only with non-negative code mid-profit — on failure you get issues back and must fix via another submit_picks.",
    "Parallel tool calls are fine. Never invent cars, prices, VINs, or dollar figures.",
    `Shopper note:\n${note.trim() || "(empty)"}${ctx}`,
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
  input: string | ResponsesInputItem[];
  tools: ReturnType<typeof resaleAgentResponsesTools>;
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

function listingFactsFromState(
  state: ResaleAgentToolState,
): Map<string, { vin: string; priceUsd: number | null }> {
  const out = new Map<string, { vin: string; priceUsd: number | null }>();
  for (const [vin, listing] of state.listingsByVin) {
    out.set(vin, { vin, priceUsd: listing.priceUsd ?? null });
  }
  return out;
}

async function finalizeVerdict(input: {
  apiKey: string;
  baseUrl: string;
  fetch: typeof fetch;
  note: string;
  shopperContext?: Record<string, unknown> | null;
  state: ResaleAgentToolState;
  journal: ResaleAgentJournalEntry[];
  priorMessages: ChatMessage[];
  mode: ResaleAgentModeResolved;
  budgetUsd: number | null;
}): Promise<
  | { ok: true; verdict: ResaleAgentVerdict; dropped: Array<{ vin: string; reason: string }> }
  | { ok: false; error: string; message: string }
> {
  const vinList = [...input.state.knownVins].slice(0, 40);
  const finishUser = [
    "Return the final resale_agent_result JSON now.",
    "picks[].vin must be copied exactly from tool listing results.",
    `Known VINs from tools: ${vinList.length ? vinList.join(", ") : "(none — return empty picks with a summary pass)"}`,
    input.budgetUsd != null ? `Budget USD ceiling: ${input.budgetUsd}` : "Budget unknown.",
    "Use only code flipPnl / get_flip_pnl dollars for profit reasoning.",
  ].join("\n");

  const messages: ChatMessage[] = [
    ...input.priorMessages,
    { role: "user", content: finishUser },
  ];

  const body = chatBody({
    messages,
    jsonSchema: {
      name: "resale_agent_result",
      schema: RESALE_AGENT_RESULT_SCHEMA as unknown as Record<string, unknown>,
    },
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
  let validated = validateResaleAgentVerdict(parseJsonObject(text));
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
        name: "resale_agent_result",
        schema: RESALE_AGENT_RESULT_SCHEMA as unknown as Record<string, unknown>,
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
    validated = validateResaleAgentVerdict(parseJsonObject(repairText));
    if (!validated.ok) {
      return {
        ok: false,
        error: "verdict_validation_failed",
        message: validated.issues.map((i) => i.message).join("; "),
      };
    }
  }

  const guarded = applyResaleAgentGuardrails(validated.verdict, {
    allowedVins: input.state.knownVins,
    budgetUsd: input.budgetUsd,
    pnlByVin: pnlFactsFromState(input.state),
  });
  return { ok: true, verdict: guarded.verdict, dropped: guarded.dropped };
}

async function runToolsMode(input: {
  note: string;
  shopperContext?: Record<string, unknown> | null;
  deps: ResaleAgentLoopDeps;
  toolDeps: ResaleAgentToolDeps;
  state: ResaleAgentToolState;
  journal: ResaleAgentJournalEntry[];
  maxRounds: number;
  baseUrl: string;
  fetchImpl: typeof fetch;
}): Promise<ResaleAgentLoopResult> {
  const requestedMode = resolveResaleAgentMode(process.env);
  const instructions = systemPrompt(input.note, input.shopperContext);
  const seedUser =
    "Search for profitable flips that fit the shopper. Call tools as needed (search_listings injects code flipPnl; parallel OK). When ready, call submit_picks — do not invent VINs or dollars.";
  const finishMessages: ChatMessage[] = [
    { role: "system", content: instructions },
    { role: "user", content: seedUser },
  ];
  const tools = resaleAgentResponsesTools();
  let responsesInput: ResponsesInputItem[] = [responsesUserMessage(seedUser)];
  let toolRounds = 0;
  let firstTurn = true;
  let submitNudgeSent = false;

  for (let round = 0; round < input.maxRounds; round += 1) {
    const body = responsesBody({
      instructions,
      input: responsesInput,
      tools,
    });
    const turn = await postResponses({
      apiKey: input.deps.servKey,
      baseUrl: input.baseUrl,
      fetch: input.fetchImpl,
      body,
    });
    const output = turn.ok ? responsesOutputOf(turn.payload) : null;
    const calls = turn.ok ? extractResponsesFunctionCalls(output) : [];
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
      return {
        ok: false,
        agentMode: "tools",
        requestedMode,
        toolRounds,
        verdictReached: false,
        error: "tools_unsupported_or_empty",
        message: "First tools-mode response had no function_call items.",
        journal: input.journal,
        knownVins: [...input.state.knownVins],
      };
    }
    firstTurn = false;

    if (calls.length === 0) {
      if (!submitNudgeSent) {
        submitNudgeSent = true;
        responsesInput = [
          ...responsesInput,
          responsesUserMessage(
            "No tool calls received. Call submit_picks now with summary/confidence/picks/relaxedConditions using only VINs and code flipPnl from prior tool results.",
          ),
        ];
        continue;
      }
      const finished = await finalizeVerdict({
        apiKey: input.deps.servKey,
        baseUrl: input.baseUrl,
        fetch: input.fetchImpl,
        note: input.note,
        shopperContext: input.shopperContext,
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
        pnlByVin: input.state.pnlByVin,
        droppedPicks: finished.dropped,
      };
    }

    const settled = await Promise.all(
      calls.map(async (call) => {
        let args: unknown = {};
        try {
          args = JSON.parse(call.arguments || "{}") as unknown;
        } catch {
          args = {};
        }

        if (call.name === "submit_picks") {
          const checked = validateResaleSubmitPicks(args, {
            listingsByVin: listingFactsFromState(input.state),
            budgetUsd: input.deps.budgetUsd ?? null,
            pnlByVin: pnlFactsFromState(input.state),
          });
          if (!checked.ok) {
            input.journal.push({
              kind: "tool",
              name: "submit_picks",
              args,
              summary: `submit_picks rejected: ${checked.issues.map((i) => i.message).join("; ")}`,
              ok: false,
            });
            return {
              callId: call.callId,
              name: "submit_picks" as const,
              accepted: false as const,
              output: {
                ok: false,
                error: "validation_failed",
                issues: checked.issues,
                message: "Fix these issues and call submit_picks again.",
              },
            };
          }
          input.journal.push({
            kind: "tool",
            name: "submit_picks",
            args,
            summary: `submit_picks accepted picks=${checked.verdict.picks.length}`,
            ok: true,
          });
          return {
            callId: call.callId,
            name: "submit_picks" as const,
            accepted: true as const,
            verdict: checked.verdict,
            output: {
              ok: true,
              accepted: true,
              picks: checked.verdict.picks.length,
              message: "Verdict accepted.",
            },
          };
        }

        const executed = await executeResaleAgentTool(call.name, args, input.toolDeps, input.state);
        input.journal.push({
          kind: "tool",
          name: executed.name,
          args,
          summary: executed.summary,
          ok: executed.ok,
        });
        finishMessages.push({
          role: "user",
          content: `Tool result for ${executed.name} (call_id=${call.callId}):\n${JSON.stringify(executed.result)}`,
        });
        return {
          callId: call.callId,
          name: executed.name,
          accepted: false as const,
          output: executed.result,
        };
      }),
    );

    toolRounds += calls.length;
    responsesInput = appendResponsesToolRound({
      priorInput: responsesInput,
      responseOutput: output,
      outputs: settled.map((row) => ({ callId: row.callId, output: row.output })),
    });

    const accepted = settled.find(
      (row) => row.name === "submit_picks" && "accepted" in row && row.accepted === true && "verdict" in row,
    ) as
      | { callId: string; name: "submit_picks"; accepted: true; verdict: ResaleAgentVerdict; output: unknown }
      | undefined;
    if (accepted) {
      return {
        ok: true,
        agentMode: "tools",
        requestedMode,
        toolRounds,
        verdictReached: true,
        verdict: accepted.verdict,
        relaxedConditions: accepted.verdict.relaxedConditions,
        journal: input.journal,
        knownVins: [...input.state.knownVins],
        listingsByVin: input.state.listingsByVin,
        pnlByVin: input.state.pnlByVin,
        droppedPicks: [],
      };
    }
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
  shopperContext?: Record<string, unknown> | null;
  deps: ResaleAgentLoopDeps;
  toolDeps: ResaleAgentToolDeps;
  state: ResaleAgentToolState;
  journal: ResaleAgentJournalEntry[];
  maxRounds: number;
  baseUrl: string;
  fetchImpl: typeof fetch;
}): Promise<ResaleAgentLoopResult> {
  const requestedMode = resolveResaleAgentMode(process.env);
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        systemPrompt(input.note, input.shopperContext),
        "Each turn return JSON with action search or finish.",
        "search runs search_listings (code injects flipPnl) with the provided filters.",
        "finish must include the resale_agent_result fields (summary, confidence, picks, relaxedConditions).",
      ].join(" "),
    },
    { role: "user", content: "Begin. Prefer a focused flip search first." },
  ];
  let toolRounds = 0;

  for (let round = 0; round < input.maxRounds; round += 1) {
    const body = chatBody({
      messages,
      jsonSchema: {
        name: "resale_agent_next_action",
        schema: RESALE_AGENT_NEXT_ACTION_SCHEMA as unknown as Record<string, unknown>,
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
                message: "Previous reply was not valid JSON for resale_agent_next_action. Fix and return JSON only.",
                issues: [{ field: "action", message: "Expected search|finish object." }],
              },
            }),
          },
        ],
        jsonSchema: {
          name: "resale_agent_next_action",
          schema: RESALE_AGENT_NEXT_ACTION_SCHEMA as unknown as Record<string, unknown>,
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
      const executed = await executeResaleAgentTool(
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
      let validated = validateResaleAgentVerdict(parsed);
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
            name: "resale_agent_next_action",
            schema: RESALE_AGENT_NEXT_ACTION_SCHEMA as unknown as Record<string, unknown>,
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
        validated = validateResaleAgentVerdict(repaired);
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

      const guarded = applyResaleAgentGuardrails(validated.verdict, {
        allowedVins: input.state.knownVins,
        budgetUsd: input.deps.budgetUsd ?? null,
        pnlByVin: pnlFactsFromState(input.state),
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
        pnlByVin: input.state.pnlByVin,
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
 * Run the Resale agentic SERV loop.
 * maxRounds is a runaway guard only — not a wall-clock timeout.
 */
export async function runResaleAgentLoop(input: {
  note: string;
  mode?: ResaleAgentMode;
  shopperContext?: Record<string, unknown> | null;
  deps: ResaleAgentLoopDeps;
  maxRounds?: number;
}): Promise<ResaleAgentLoopResult> {
  const requestedMode = input.mode ?? resolveResaleAgentMode(process.env);
  const maxRounds = input.maxRounds ?? 40;
  const fetchImpl = input.deps.fetch ?? fetch;
  const baseUrl = servApiBase(input.deps.servBaseUrl);
  const journal: ResaleAgentJournalEntry[] = [];
  const state = createResaleAgentToolState(input.deps.seedListings);
  const toolDeps: ResaleAgentToolDeps = {
    fetch: fetchImpl,
    autodevKey: input.deps.autodevKey,
    autodev: input.deps.autodev ?? {
      cache: new TtlCache<unknown>(),
      counter: new MemoryCounter(),
    },
    seedListings: input.deps.seedListings,
    pnlOptions: input.deps.pnlOptions,
  };

  const shared = {
    note: input.note,
    shopperContext: input.shopperContext ?? input.deps.shopperContext,
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

  return runNextActionMode(shared);
}

/** Journal step counts for eval reports. */
export function summarizeResaleAgentJournal(journal: readonly ResaleAgentJournalEntry[]): {
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
