/**
 * Agentic Resale SERV loop — tools mode (preferred) or next_action fallback.
 * Model: gpt-6.1-sol only. Code owns PnL; SERV picks flips with justification.
 * Multi-round runs are stepped across requests under the Hobby 300s cap
 * (persist checkpoint; never clip SERV call timeouts).
 */
import { synthesizeRelaxedConditionsFromSearches } from "@/domain/agent-verdict-complete";
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
import {
  AGENT_LOOP_BUDGET_CONTINUE,
  agentLoopMayStartRound,
  makeAgentLoopDeadline,
  type AgentLoopDeadline,
} from "@/domain/agent-loop-deadline";
import type { BuildResalePnlOptions, ResaleCandidatePnl } from "@/domain/resale-pnl";
import type { Listing } from "@/domain/types";
import { TtlCache } from "@/io/cache";
import { MemoryCounter } from "@/io/quota";
import { messageText } from "@/server/serv";
import {
  buildServChatTurnBody,
  buildServResponsesTurnBody,
  postServChatTurn,
  postServResponsesTurn,
  type ServChatToolCallWire,
  type ServChatToolDef,
  type ServChatTurnMessage,
} from "@/server/serv/agent-chat-turn";
import {
  deserializeListingsByVin,
  deserializePnlByVin,
  serializeListingsByVin,
  serializePnlByVin,
  type AgentLoopCheckpoint,
} from "@/server/serv/agent-loop-checkpoint";
import {
  classifyAgentFeatureRejection,
  formatFeatureRejectionFlags,
  journalFromBundle,
  mergeResponsesTools,
  resaleAgentServFeatureBundle,
  shadowOutcomeForAgentTurn,
  type AgentServFeatureBundle,
  type AgentServFeatureJournal,
  type AgentServFeatureRejection,
} from "@/server/serv/agent-serv-features";
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
  endpoint: "responses" | "chat";
  features: AgentServFeatureJournal["features"];
  promptGuard: AgentServFeatureJournal["promptGuard"];
  shadowRequested: boolean;
  shadowMaxIterations: number | null;
  shadowOutcome: string | null;
  featureRejections: AgentServFeatureRejection[];
  featureFlags: string[];
};

export type ResaleAgentJournalToolCall = {
  kind: "tool";
  name: string;
  args: unknown;
  summary: string;
  ok: boolean;
  resultCount?: number;
  funnel?: Array<{ step: string; count: number }>;
};

export type ResaleAgentJournalEntry = ResaleAgentJournalServCall | ResaleAgentJournalToolCall;

export function searchesFromResaleJournal(
  journal: readonly ResaleAgentJournalEntry[],
): import("@/domain/agent-verdict-complete").AgentSearchJournalRow[] {
  const out: import("@/domain/agent-verdict-complete").AgentSearchJournalRow[] = [];
  for (const entry of journal) {
    if (entry.kind !== "tool" || entry.name !== "search_listings") continue;
    const params =
      entry.args && typeof entry.args === "object" && !Array.isArray(entry.args)
        ? (entry.args as Record<string, unknown>)
        : null;
    const fromSummary = /→\s*(\d+)\s+hits/i.exec(entry.summary);
    const zeroSummary = /→\s*0\s+usable/i.test(entry.summary);
    const resultCount =
      entry.resultCount ??
      (fromSummary ? Number(fromSummary[1]) : zeroSummary ? 0 : 0);
    out.push({
      params,
      resultCount: Number.isFinite(resultCount) ? resultCount : 0,
      funnel: entry.funnel ?? null,
    });
  }
  return out;
}

function enrichResaleRelaxed(
  verdict: ResaleAgentVerdict,
  journal: readonly ResaleAgentJournalEntry[],
): ResaleAgentVerdict {
  if (verdict.relaxedConditions.length > 0) return verdict;
  const synthesized = synthesizeRelaxedConditionsFromSearches(searchesFromResaleJournal(journal));
  if (synthesized.length === 0) return verdict;
  return { ...verdict, relaxedConditions: synthesized };
}

function journalResaleSearchEntry(
  executed: { name: string; summary: string; ok: boolean; result: unknown },
  args: unknown,
): ResaleAgentJournalToolCall {
  const resultRecord =
    executed.result && typeof executed.result === "object" && !Array.isArray(executed.result)
      ? (executed.result as Record<string, unknown>)
      : null;
  const funnel = Array.isArray(resultRecord?.funnel)
    ? (resultRecord!.funnel as Array<{ step: string; count: number }>)
    : undefined;
  const resultCount =
    typeof resultRecord?.totalReturned === "number"
      ? resultRecord.totalReturned
      : typeof resultRecord?.count === "number"
        ? resultRecord.count
        : undefined;
  return {
    kind: "tool",
    name: executed.name,
    args,
    summary: executed.summary,
    ok: executed.ok,
    ...(executed.name === "search_listings" ? { resultCount, funnel } : {}),
  };
}

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

export type ResaleAgentLoopContinue = {
  ok: false;
  continue: true;
  error: typeof AGENT_LOOP_BUDGET_CONTINUE;
  message: string;
  agentMode: ResaleAgentModeResolved;
  requestedMode: ResaleAgentMode;
  toolRounds: number;
  verdictReached: false;
  journal: ResaleAgentJournalEntry[];
  knownVins: string[];
  featureRejections: AgentServFeatureRejection[];
  featureFlags: string[];
  servFeatures: AgentServFeatureJournal | null;
  checkpoint: AgentLoopCheckpoint;
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
      featureRejections: AgentServFeatureRejection[];
      featureFlags: string[];
      servFeatures: AgentServFeatureJournal;
    }
  | ResaleAgentLoopContinue
  | {
      ok: false;
      continue?: false;
      agentMode: ResaleAgentModeResolved | null;
      requestedMode: ResaleAgentMode;
      toolRounds: number;
      verdictReached: false;
      error: string;
      message: string;
      journal: ResaleAgentJournalEntry[];
      knownVins: string[];
      featureRejections: AgentServFeatureRejection[];
      featureFlags: string[];
      servFeatures: AgentServFeatureJournal | null;
    };

type ChatMessage = ServChatTurnMessage;
type ToolCallWire = ServChatToolCallWire;

function buildResaleCheckpoint(input: {
  phase: "tools" | "next_action";
  toolRounds: number;
  roundsCompleted: number;
  responsesInput: ResponsesInputItem[];
  messages: ChatMessage[];
  journal: ResaleAgentJournalEntry[];
  state: ResaleAgentToolState;
  submitNudgeSent: boolean;
  firstTurn: boolean;
  featureRejections: AgentServFeatureRejection[];
}): AgentLoopCheckpoint {
  return {
    v: 1,
    product: "resale",
    phase: input.phase,
    toolRounds: input.toolRounds,
    roundsCompleted: input.roundsCompleted,
    responsesInput: input.responsesInput,
    messages: input.messages,
    journal: input.journal as unknown as Array<Record<string, unknown>>,
    knownVins: [...input.state.knownVins],
    listingsByVin: serializeListingsByVin(input.state.listingsByVin),
    pnlByVin: serializePnlByVin(input.state.pnlByVin),
    submitNudgeSent: input.submitNudgeSent,
    firstTurn: input.firstTurn,
    featureRejections: input.featureRejections as unknown as Array<Record<string, unknown>>,
  };
}

function restoreResaleStateFromCheckpoint(
  checkpoint: AgentLoopCheckpoint | null | undefined,
  seedListings?: readonly Listing[],
): {
  state: ResaleAgentToolState;
  journal: ResaleAgentJournalEntry[];
  toolRounds: number;
  roundsCompleted: number;
  responsesInput: ResponsesInputItem[] | null;
  messages: ChatMessage[] | null;
  submitNudgeSent: boolean;
  firstTurn: boolean;
  featureRejections: AgentServFeatureRejection[];
  phase: "tools" | "next_action" | null;
} {
  if (!checkpoint || checkpoint.product !== "resale") {
    return {
      state: createResaleAgentToolState(seedListings),
      journal: [],
      toolRounds: 0,
      roundsCompleted: 0,
      responsesInput: null,
      messages: null,
      submitNudgeSent: false,
      firstTurn: true,
      featureRejections: [],
      phase: null,
    };
  }
  const state = createResaleAgentToolState(seedListings);
  state.knownVins = new Set(checkpoint.knownVins.map((v) => v.toUpperCase()));
  state.listingsByVin = deserializeListingsByVin(checkpoint.listingsByVin);
  state.pnlByVin = deserializePnlByVin(checkpoint.pnlByVin);
  return {
    state,
    journal: checkpoint.journal as unknown as ResaleAgentJournalEntry[],
    toolRounds: checkpoint.toolRounds,
    roundsCompleted: checkpoint.roundsCompleted,
    responsesInput: checkpoint.responsesInput,
    messages: checkpoint.messages as ChatMessage[],
    submitNudgeSent: checkpoint.submitNudgeSent,
    firstTurn: checkpoint.firstTurn,
    featureRejections: checkpoint.featureRejections as unknown as AgentServFeatureRejection[],
    phase: checkpoint.phase,
  };
}

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
  model?: string;
  /** Chat fallback must not attach function tools for gpt-6.1-sol. */
  tools?: ServChatToolDef[];
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
}): Record<string, unknown> {
  return buildServChatTurnBody({
    messages: input.messages,
    jsonSchema: input.jsonSchema,
    maxTokens: input.maxTokens,
    model: input.model,
    // Never attach function tools on chat — gpt-6.1-sol cannot pair tools with a
    // supported reasoning_effort. Prompt Guard / Shadow live on /v1/responses.
    tools: undefined,
    reasoningEffort: input.reasoningEffort ?? "low",
  });
}

function responsesBody(input: {
  instructions: string;
  input: string | ResponsesInputItem[];
  applicationTools: ReturnType<typeof resaleAgentResponsesTools>;
  bundle: AgentServFeatureBundle;
}): Record<string, unknown> {
  return buildServResponsesTurnBody({
    model: input.bundle.model,
    instructions: input.instructions,
    input: input.input,
    tools: mergeResponsesTools(input.bundle.responsesExtensionTools, input.applicationTools),
    toolChoice: "auto",
    reasoning: { effort: input.bundle.reasoningEffort, summary: "auto" },
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

function pushServJournal(input: {
  journal: ResaleAgentJournalEntry[];
  rejections: AgentServFeatureRejection[];
  bundle: AgentServFeatureBundle;
  responseId: string | null;
  latencyMs: number;
  mode: ResaleAgentModeResolved;
  finishReason: string | null;
  hadToolCalls: boolean;
  endpoint: "responses" | "chat";
  turn: { ok: boolean; status: number; payload: unknown; error?: string };
}): void {
  const turnRejections = input.turn.ok
    ? []
    : classifyAgentFeatureRejection({
        status: input.turn.status,
        payload: input.turn.payload,
        error: input.turn.error,
        endpoint: input.endpoint,
        requestedFeatures: input.bundle.features,
      });
  for (const row of turnRejections) input.rejections.push(row);
  const flags = formatFeatureRejectionFlags(turnRejections);
  const base = journalFromBundle(input.bundle, {
    endpoint: input.endpoint,
    shadowOutcome: input.turn.ok ? shadowOutcomeForAgentTurn(input.turn.payload) : null,
    featureRejections: turnRejections,
  });
  input.journal.push({
    kind: "serv",
    responseId: input.responseId,
    model: base.model,
    latencyMs: input.latencyMs,
    mode: input.mode,
    finishReason: input.finishReason,
    hadToolCalls: input.hadToolCalls,
    endpoint: input.endpoint,
    features: base.features,
    promptGuard: base.promptGuard,
    shadowRequested: base.shadowRequested,
    shadowMaxIterations: base.shadowMaxIterations,
    shadowOutcome: base.shadowOutcome,
    featureRejections: turnRejections,
    featureFlags: flags,
  });
}

function resaleLoopMeta(bundle: AgentServFeatureBundle, rejections: AgentServFeatureRejection[]) {
  return {
    featureRejections: [...rejections],
    featureFlags: formatFeatureRejectionFlags(rejections),
    servFeatures: journalFromBundle(bundle, { featureRejections: rejections, endpoint: "responses" }),
  };
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
  bundle: AgentServFeatureBundle;
  rejections: AgentServFeatureRejection[];
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
    model: input.bundle.model,
    jsonSchema: {
      name: "resale_agent_result",
      schema: RESALE_AGENT_RESULT_SCHEMA as unknown as Record<string, unknown>,
    },
    reasoningEffort: "low",
  });
  const turn = await postChat({
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    fetch: input.fetch,
    body,
  });
  pushServJournal({
    journal: input.journal,
    rejections: input.rejections,
    bundle: input.bundle,
    responseId: responseIdOf(turn.payload),
    latencyMs: turn.latencyMs,
    mode: input.mode,
    finishReason: turn.payload ? servFinishReason(turn.payload) : null,
    hadToolCalls: false,
    endpoint: "chat",
    turn,
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
    pushServJournal({
      journal: input.journal,
      rejections: input.rejections,
      bundle: input.bundle,
      responseId: responseIdOf(repair.payload),
      latencyMs: repair.latencyMs,
      mode: input.mode,
      finishReason: repair.payload ? servFinishReason(repair.payload) : null,
      hadToolCalls: false,
      endpoint: "chat",
      turn: repair,
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

  const gated = validateResaleSubmitPicks(validated.verdict, {
    listingsByVin: listingFactsFromState(input.state),
    budgetUsd: input.budgetUsd,
    pnlByVin: pnlFactsFromState(input.state),
    searches: searchesFromResaleJournal(input.journal),
  });
  if (!gated.ok) {
    return {
      ok: false,
      error: "verdict_incomplete",
      message: gated.issues.map((i) => i.message).join("; "),
    };
  }
  const guarded = applyResaleAgentGuardrails(gated.verdict, {
    allowedVins: input.state.knownVins,
    budgetUsd: input.budgetUsd,
    pnlByVin: pnlFactsFromState(input.state),
  });
  return {
    ok: true,
    verdict: enrichResaleRelaxed(guarded.verdict, input.journal),
    dropped: guarded.dropped,
  };
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
  deadline?: AgentLoopDeadline | null;
  resume?: {
    toolRounds: number;
    roundsCompleted: number;
    responsesInput: ResponsesInputItem[] | null;
    messages: ChatMessage[] | null;
    submitNudgeSent: boolean;
    firstTurn: boolean;
    featureRejections: AgentServFeatureRejection[];
  } | null;
}): Promise<ResaleAgentLoopResult> {
  const requestedMode = resolveResaleAgentMode(process.env);
  const bundle = resaleAgentServFeatureBundle();
  const rejections: AgentServFeatureRejection[] = [...(input.resume?.featureRejections ?? [])];
  const instructions = systemPrompt(input.note, input.shopperContext);
  const seedUser =
    "Search for profitable flips that fit the shopper. Call tools as needed (search_listings injects code flipPnl; parallel OK). When ready, call submit_picks — do not invent VINs or dollars.";
  const finishMessages: ChatMessage[] = input.resume?.messages?.length
    ? [...input.resume.messages]
    : [
        { role: "system", content: instructions },
        { role: "user", content: seedUser },
      ];
  const applicationTools = resaleAgentResponsesTools();
  let responsesInput: ResponsesInputItem[] = input.resume?.responsesInput?.length
    ? [...input.resume.responsesInput]
    : [responsesUserMessage(seedUser)];
  let toolRounds = input.resume?.toolRounds ?? 0;
  let firstTurn = input.resume?.firstTurn ?? true;
  let submitNudgeSent = input.resume?.submitNudgeSent ?? false;
  const startRound = input.resume?.roundsCompleted ?? 0;

  for (let round = startRound; round < input.maxRounds; round += 1) {
    if (!agentLoopMayStartRound(input.deadline)) {
      const checkpoint = buildResaleCheckpoint({
        phase: "tools",
        toolRounds,
        roundsCompleted: round,
        responsesInput,
        messages: finishMessages,
        journal: input.journal,
        state: input.state,
        submitNudgeSent,
        firstTurn,
        featureRejections: rejections,
      });
      return {
        ok: false,
        continue: true,
        error: AGENT_LOOP_BUDGET_CONTINUE,
        message:
          "Agentic Resale loop paused under the request time budget; continue on the next search step.",
        agentMode: "tools",
        requestedMode,
        toolRounds,
        verdictReached: false,
        journal: input.journal,
        knownVins: [...input.state.knownVins],
        checkpoint,
        ...resaleLoopMeta(bundle, rejections),
      };
    }
    const body = responsesBody({
      instructions,
      input: responsesInput,
      applicationTools,
      bundle,
    });
    const turn = await postResponses({
      apiKey: input.deps.servKey,
      baseUrl: input.baseUrl,
      fetch: input.fetchImpl,
      body,
    });
    const output = turn.ok ? responsesOutputOf(turn.payload) : null;
    const calls = turn.ok ? extractResponsesFunctionCalls(output) : [];
    pushServJournal({
      journal: input.journal,
      rejections,
      bundle,
      responseId: responseIdOf(turn.payload),
      latencyMs: turn.latencyMs,
      mode: "tools",
      finishReason: turn.payload ? servFinishReason(turn.payload) : null,
      hadToolCalls: calls.length > 0,
      endpoint: "responses",
      turn,
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
        ...resaleLoopMeta(bundle, rejections)
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
        ...resaleLoopMeta(bundle, rejections)
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
        bundle,
        rejections,
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
          ...resaleLoopMeta(bundle, rejections),
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
        ...resaleLoopMeta(bundle, rejections),
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
            searches: searchesFromResaleJournal(input.journal),
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
          const enriched = enrichResaleRelaxed(checked.verdict, input.journal);
          input.journal.push({
            kind: "tool",
            name: "submit_picks",
            args,
            summary: `submit_picks accepted picks=${enriched.picks.length}`,
            ok: true,
          });
          return {
            callId: call.callId,
            name: "submit_picks" as const,
            accepted: true as const,
            verdict: enriched,
            output: {
              ok: true,
              accepted: true,
              picks: enriched.picks.length,
              message: "Verdict accepted.",
            },
          };
        }

        const executed = await executeResaleAgentTool(call.name, args, input.toolDeps, input.state);
        input.journal.push(journalResaleSearchEntry(executed, args));
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
        ...resaleLoopMeta(bundle, rejections),
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
    ...resaleLoopMeta(bundle, rejections),
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
  deadline?: AgentLoopDeadline | null;
  resume?: {
    toolRounds: number;
    roundsCompleted: number;
    responsesInput: ResponsesInputItem[] | null;
    messages: ChatMessage[] | null;
    submitNudgeSent: boolean;
    firstTurn: boolean;
    featureRejections: AgentServFeatureRejection[];
  } | null;
}): Promise<ResaleAgentLoopResult> {
  const requestedMode = resolveResaleAgentMode(process.env);
  const bundle = resaleAgentServFeatureBundle();
  const rejections: AgentServFeatureRejection[] = [...(input.resume?.featureRejections ?? [])];
  const messages: ChatMessage[] = input.resume?.messages?.length
    ? [...input.resume.messages]
    : [
        {
          role: "system",
          content: [
            systemPrompt(input.note, input.shopperContext),
            "Each turn return JSON with action search or finish.",
            "search runs search_listings with the provided filters.",
            "finish must include the resale_agent_result fields (summary, confidence, picks, relaxedConditions).",
          ].join(" "),
        },
        { role: "user", content: "Begin. Prefer a focused search first." },
      ];
  let toolRounds = input.resume?.toolRounds ?? 0;
  const startRound = input.resume?.roundsCompleted ?? 0;

  const nextActionBody = (msgs: ChatMessage[]) =>
    chatBody({
      messages: msgs,
      model: bundle.model,
      // Schema-only chat; never function tools + never reasoning_effort "none".
      jsonSchema: {
        name: "resale_agent_next_action",
        schema: RESALE_AGENT_NEXT_ACTION_SCHEMA as unknown as Record<string, unknown>,
      },
      reasoningEffort: "low",
    });

  for (let round = startRound; round < input.maxRounds; round += 1) {
    if (!agentLoopMayStartRound(input.deadline)) {
      const checkpoint = buildResaleCheckpoint({
        phase: "next_action",
        toolRounds,
        roundsCompleted: round,
        responsesInput: [],
        messages,
        journal: input.journal,
        state: input.state,
        submitNudgeSent: false,
        firstTurn: false,
        featureRejections: rejections,
      });
      return {
        ok: false,
        continue: true,
        error: AGENT_LOOP_BUDGET_CONTINUE,
        message:
          "Agentic Resale loop paused under the request time budget; continue on the next search step.",
        agentMode: "next_action",
        requestedMode,
        toolRounds,
        verdictReached: false,
        journal: input.journal,
        knownVins: [...input.state.knownVins],
        checkpoint,
        ...resaleLoopMeta(bundle, rejections),
      };
    }
    let body = nextActionBody(messages);
    let turn = await postChat({
      apiKey: input.deps.servKey,
      baseUrl: input.baseUrl,
      fetch: input.fetchImpl,
      body,
    });
    pushServJournal({
      journal: input.journal,
      rejections,
      bundle,
      responseId: responseIdOf(turn.payload),
      latencyMs: turn.latencyMs,
      mode: "next_action",
      finishReason: turn.payload ? servFinishReason(turn.payload) : null,
      hadToolCalls: false,
      endpoint: "chat",
      turn,
    });
    if (!turn.ok) {
      const flagged = classifyAgentFeatureRejection({
        status: turn.status,
        payload: turn.payload,
        error: turn.error,
        endpoint: "chat",
        requestedFeatures: bundle.features,
      });
      if (flagged.length > 0) {
        // Schema-only retry keeps the feature model suffix; flag the tool rejection.
        body = chatBody({
          messages,
          model: bundle.model,
          jsonSchema: {
            name: "resale_agent_next_action",
            schema: RESALE_AGENT_NEXT_ACTION_SCHEMA as unknown as Record<string, unknown>,
          },
        });
        turn = await postChat({
          apiKey: input.deps.servKey,
          baseUrl: input.baseUrl,
          fetch: input.fetchImpl,
          body,
        });
        pushServJournal({
          journal: input.journal,
          rejections,
          bundle,
          responseId: responseIdOf(turn.payload),
          latencyMs: turn.latencyMs,
          mode: "next_action",
          finishReason: turn.payload ? servFinishReason(turn.payload) : null,
          hadToolCalls: false,
          endpoint: "chat",
          turn,
        });
        input.journal.push({
          kind: "tool",
          name: "_feature_flag",
          args: { phase: "next_action_schema_only_retry", flagged },
          summary: formatFeatureRejectionFlags(flagged).join(" | "),
          ok: false,
        });
      }
    }
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
        ...resaleLoopMeta(bundle, rejections),
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
        model: bundle.model,
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
      pushServJournal({
        journal: input.journal,
        rejections,
        bundle,
        responseId: responseIdOf(repair.payload),
        latencyMs: repair.latencyMs,
        mode: "next_action",
        finishReason: repair.payload ? servFinishReason(repair.payload) : null,
        hadToolCalls: false,
        endpoint: "chat",
        turn: repair,
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
          ...resaleLoopMeta(bundle, rejections),
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
        ...resaleLoopMeta(bundle, rejections),
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
      input.journal.push(journalResaleSearchEntry(executed, argsValue));
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
          model: bundle.model,
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
        pushServJournal({
          journal: input.journal,
          rejections,
          bundle,
          responseId: responseIdOf(repair.payload),
          latencyMs: repair.latencyMs,
          mode: "next_action",
          finishReason: repair.payload ? servFinishReason(repair.payload) : null,
          hadToolCalls: false,
          endpoint: "chat",
          turn: repair,
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
            ...resaleLoopMeta(bundle, rejections),
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
            ...resaleLoopMeta(bundle, rejections),
          };
        }
      }

      const gated = validateResaleSubmitPicks(validated.verdict, {
        listingsByVin: listingFactsFromState(input.state),
        budgetUsd: input.deps.budgetUsd ?? null,
        pnlByVin: pnlFactsFromState(input.state),
        searches: searchesFromResaleJournal(input.journal),
      });
      if (!gated.ok) {
        messages.push({
          role: "user",
          content: JSON.stringify({
            validationError: {
              message: "Finish verdict incomplete. Fix and return finish again.",
              issues: gated.issues,
            },
          }),
        });
        continue;
      }
      const guarded = applyResaleAgentGuardrails(gated.verdict, {
        allowedVins: input.state.knownVins,
        budgetUsd: input.deps.budgetUsd ?? null,
        pnlByVin: pnlFactsFromState(input.state),
      });
      const enriched = enrichResaleRelaxed(guarded.verdict, input.journal);
      return {
        ok: true,
        agentMode: "next_action",
        requestedMode,
        toolRounds,
        verdictReached: true,
        verdict: enriched,
        relaxedConditions: enriched.relaxedConditions,
        journal: input.journal,
        knownVins: [...input.state.knownVins],
        listingsByVin: input.state.listingsByVin,
        pnlByVin: input.state.pnlByVin,
        droppedPicks: guarded.dropped,
        ...resaleLoopMeta(bundle, rejections),
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
    ...resaleLoopMeta(bundle, rejections),
  };
}

/**
 * Run the Resale agentic SERV loop.
 * maxRounds is a runaway guard only — not a wall-clock timeout.
 * Pass `deadline` + prior `checkpoint` to step across Hobby 300s requests.
 */
export async function runResaleAgentLoop(input: {
  note: string;
  mode?: ResaleAgentMode;
  shopperContext?: Record<string, unknown> | null;
  deps: ResaleAgentLoopDeps;
  maxRounds?: number;
  deadline?: AgentLoopDeadline | null;
  checkpoint?: AgentLoopCheckpoint | null;
  budgetMs?: number;
}): Promise<ResaleAgentLoopResult> {
  const requestedMode = input.mode ?? resolveResaleAgentMode(process.env);
  const maxRounds = input.maxRounds ?? 40;
  const fetchImpl = input.deps.fetch ?? fetch;
  const baseUrl = servApiBase(input.deps.servBaseUrl);
  const restored = restoreResaleStateFromCheckpoint(input.checkpoint, input.deps.seedListings);
  const journal = restored.journal;
  const state = restored.state;
  const deadline =
    input.deadline === undefined
      ? makeAgentLoopDeadline(input.budgetMs)
      : input.deadline;
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

  const resume = {
    toolRounds: restored.toolRounds,
    roundsCompleted: restored.roundsCompleted,
    responsesInput: restored.responsesInput,
    messages: restored.messages,
    submitNudgeSent: restored.submitNudgeSent,
    firstTurn: restored.firstTurn,
    featureRejections: restored.featureRejections,
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
    deadline,
    resume: input.checkpoint ? resume : null,
  };

  if (restored.phase === "next_action") {
    return runNextActionMode(shared);
  }
  if (restored.phase === "tools") {
    return runToolsMode(shared);
  }

  if (requestedMode === "next_action") {
    return runNextActionMode(shared);
  }

  if (requestedMode === "tools") {
    return runToolsMode(shared);
  }

  // Prefer /v1/responses tools. Fall back to schema-only chat only when tools
  // are unsupported/empty — never on serv_http (Resale must stay on tools when available).
  const toolsAttempt = await runToolsMode(shared);
  if (toolsAttempt.ok) return toolsAttempt;
  if ("continue" in toolsAttempt && toolsAttempt.continue) return toolsAttempt;
  if (toolsAttempt.error !== "tools_unsupported_or_empty") {
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
    resume: null,
  });
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
