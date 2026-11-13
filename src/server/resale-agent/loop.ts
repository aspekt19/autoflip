/**
 * Agentic Resale SERV loop — tools mode (preferred) or next_action fallback.
 * Model: shared BASE_MODEL only. Code owns PnL; SERV picks flips with justification.
 * Multi-round runs are stepped across requests under the Hobby 300s cap
 * (persist checkpoint; never clip SERV call timeouts).
 */
import {
  boundaryRepairMessage,
  honestNothingFitsReasonFromSearches,
  searchesAllEmpty,
  searchesDocumented,
  synthesizeRelaxedConditionsFromSearches,
} from "@/domain/agent-verdict-complete";
import { fromShopperInputEvent } from "@/domain/constraint-provenance";
import {
  formatShopperBriefCard,
  SERV_TOPIC_SCOPE_RULE,
  type ShopperBrief,
} from "@/domain/shopper-brief";
import {
  fingerprintsFromSearchJournal,
  hardSearchKeysFromUserBag,
} from "@/domain/search-listings-feedback";
import {
  assertNoNonUserSetConstraints,
  buildUserIntentFromFlatForm,
  serializeUserIntentConstraints,
  type UserIntent,
} from "@/domain/serv-boundary";
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
  agentLoopMayStartServCall,
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
  buildAgentServFeatureBundle,
  classifyAgentFeatureRejection,
  formatFeatureRejectionFlags,
  journalFromBundle,
  mergeResponsesTools,
  resolveAgentServStep,
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
import {
  extractAgentServCallUsage,
  servFinishReason,
  sumAgentServUsage,
  type AgentServCallUsage,
  type AgentServUsageTotals,
} from "@/server/serv/response-failure";
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
  step?: AgentServFeatureJournal["step"];
  maxOutputTokens?: number;
  usage?: AgentServCallUsage | null;
};

export type ResaleAgentJournalToolCall = {
  kind: "tool";
  name: string;
  args: unknown;
  summary: string;
  ok: boolean;
  resultCount?: number;
  funnel?: Array<{ step: string; count: number }>;
  /** Provider HTTP status when search_listings failed upstream (0 = network/timeout). */
  providerStatus?: number;
  /** Upstream cause: http_error | timeout | network | aborted | … */
  providerCause?: string;
  /** Attempts including retries before the final provider outcome. */
  providerAttempts?: number;
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
      providerStatus: entry.providerStatus ?? null,
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
  const providerStatus =
    typeof resultRecord?.status === "number" ? resultRecord.status : undefined;
  const providerCause =
    typeof resultRecord?.cause === "string" ? resultRecord.cause : undefined;
  const providerAttempts =
    typeof resultRecord?.attempts === "number" ? resultRecord.attempts : undefined;
  return {
    kind: "tool",
    name: executed.name,
    args,
    summary: executed.summary,
    ok: executed.ok,
    ...(executed.name === "search_listings"
      ? {
          resultCount,
          funnel,
          ...(providerStatus != null ? { providerStatus } : {}),
          ...(providerCause ? { providerCause } : {}),
          ...(providerAttempts != null ? { providerAttempts } : {}),
        }
      : {}),
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

/** SERV called ask_shopper or submit_brief — pause for the shopper. */
export type ResaleAgentLoopAwaitUser = {
  ok: false;
  awaitUser: true;
  question: string;
  message: string;
  awaitKind?: "ask" | "brief";
  brief?: ShopperBrief | null;
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
  | ResaleAgentLoopAwaitUser
  | {
      ok: false;
      continue?: false;
      awaitUser?: false;
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
  selectionHop: boolean;
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
    selectionHop: input.selectionHop,
    firstTurn: input.firstTurn,
    featureRejections: input.featureRejections as unknown as Array<Record<string, unknown>>,
    shopperFacts: { ...input.state.shopperFacts },
    briefConfirmed: input.state.briefConfirmed === true,
    radiusWidenAgreed: input.state.radiusWidenAgreed === true,
    zipGeocodeFailed: input.state.zipGeocodeFailed === true,
    searchCenter: input.state.searchCenter ?? null,
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
  selectionHop: boolean;
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
      selectionHop: false,
      firstTurn: true,
      featureRejections: [],
      phase: null,
    };
  }
  const state = createResaleAgentToolState(seedListings);
  state.knownVins = new Set(checkpoint.knownVins.map((v) => v.toUpperCase()));
  state.listingsByVin = deserializeListingsByVin(checkpoint.listingsByVin);
  state.pnlByVin = deserializePnlByVin(checkpoint.pnlByVin);
  if (checkpoint.shopperFacts) {
    state.shopperFacts = {
      budgetUsd: checkpoint.shopperFacts.budgetUsd ?? null,
      zip: checkpoint.shopperFacts.zip ?? null,
      radiusMi: checkpoint.shopperFacts.radiusMi ?? null,
    };
  }
  state.briefConfirmed = checkpoint.briefConfirmed === true;
  state.radiusWidenAgreed = checkpoint.radiusWidenAgreed === true;
  state.zipGeocodeFailed = checkpoint.zipGeocodeFailed === true;
  const center = checkpoint.searchCenter;
  state.searchCenter =
    center &&
    typeof center.latitude === "number" &&
    typeof center.longitude === "number" &&
    typeof center.zip === "string"
      ? { latitude: center.latitude, longitude: center.longitude, zip: center.zip }
      : null;
  const journal = checkpoint.journal as unknown as ResaleAgentJournalEntry[];
  state.searchFingerprints = fingerprintsFromSearchJournal(searchesFromResaleJournal(journal));
  return {
    state,
    journal,
    toolRounds: checkpoint.toolRounds,
    roundsCompleted: checkpoint.roundsCompleted,
    responsesInput: checkpoint.responsesInput,
    messages: checkpoint.messages as ChatMessage[],
    submitNudgeSent: checkpoint.submitNudgeSent,
    selectionHop: checkpoint.selectionHop === true,
    firstTurn: checkpoint.firstTurn,
    featureRejections: checkpoint.featureRejections as unknown as AgentServFeatureRejection[],
    phase: checkpoint.phase,
  };
}


function constraintsFromFormEdits(
  note: string,
  formEdits?: Record<string, unknown> | null,
): { intent: UserIntent; constraints: Record<string, unknown> } {
  const form = formEdits ?? {};
  const looksTagged = Object.values(form).some(
    (v) =>
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      "value" in (v as object) &&
      ("origin" in (v as object) || "provenance" in (v as object)),
  );
  if (looksTagged) {
    const intent: UserIntent = { note, fields: {} };
    const constraints: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(form)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const row = raw as { value?: unknown; provenance?: unknown; origin?: unknown; quote?: unknown };
      const origin = typeof row.origin === "string" ? row.origin : row.provenance;
      if (origin !== "user" && origin !== "form") continue;
      const revived = fromShopperInputEvent({
        kind: "wire",
        field: key as import("@/domain/constraint-provenance").ConstraintFieldKey,
        value: row.value,
      });
      const field = {
        value: revived.value,
        provenance: "user" as const,
        origin: "user" as const,
        ...(typeof row.quote === "string" ? { quote: row.quote } : {}),
      };
      (intent.fields as Record<string, unknown>)[key] = field;
      constraints[key] = field;
    }
    return { intent, constraints };
  }
  const intent = buildUserIntentFromFlatForm({ note, form });
  return { intent, constraints: serializeUserIntentConstraints(intent) };
}

/**
 * Byte-stable Resale system prompt / Responses `instructions`.
 * OpenServ prompt cache keys on the system prompt (+ transform type) — never put
 * transcript, brief, dates, ids, or other per-request data here.
 */
export function resaleAgentStableInstructions(): string {
  return [
    "You are Lemonless Resale. Use ask_shopper in this same chat when budget, location, or flip use/goal is missing; call record_shopper_facts; then submit_brief for Confirm/Correct before search. You are Lemonless Resale's flip shopper agent on SERV.",
    SERV_TOPIC_SCOPE_RULE,
    "As soon as you have budget (or explicit no budget), location, and use/goal — call submit_brief immediately. Do not keep asking once those three are known.",
    "submit_brief: budget.maxUsd + budget.userQuote (verbatim shopper words). Do not search until the shopper confirms.",
    "After confirmation, search starts immediately — call search_listings next; do not ask again or call submit_brief again. Use confirmed ZIP+radius; on location_not_recognized ask once for a residential ZIP — never nationwide silently.",
    "You decide which listings to search for profitable flips given budget, region, and flip goal.",
    "Prefer tight filters first. When results are empty or weak, read funnel + relaxHints + constraintRoles and change a relaxable (SERV-chosen) filter then re-search. Code never auto-relaxes or forces filter changes.",
    "constraintRoles.hard are shopper origin=user filters — keep unless the shopper note allows otherwise; never invent which keys are hard. Explain every relaxation in relaxedConditions (real text; never redacted).",
    "search_listings returns unfiltered provider rows plus an observational funnel — code does not drop rows for product decisions. If duplicateSearch is set, prefer changing a relaxable filter; a reasoned pass with journaled searches is still valid.",
    "End ONLY with a terminal tool: submit_picks (chosen flips) or submit_nothing_fits (written reason). Code journals every search_listings call — never re-document those params/counts/HTTP statuses.",
    "Finish only with flip picks whose VIN appeared in tool listing results. Never invent cars, prices, or VINs.",
    "Dollar facts for fees, tax, recon, and expected resale come ONLY from tool flipPnl / get_flip_pnl — never invent those numbers.",
    "Profit floors and sell-within-N-days are ranking/verdict signals — never hard inventory filters. When search_listings returns funnel counts or relaxHints, relax the step that hit zero (omit_body / widen_radius / raise_price / drop_transmission) and re-search. Prefer bodyFamily=car; never rely on provider Sedan.",
    "Pick buy|negotiate only when code mid-profit is positive; otherwise pass or needs_inspection with justification.",
    "On validation failure you get a repair message with the exact problem — fix via another terminal tool call. Code never substitutes a pick.",
    "Parallel tool calls are fine. Never invent cars, prices, VINs, or dollar figures.",
    "Per-request shopper conversation, confirmed brief, and form constraints arrive in input messages — not in these instructions.",
  ].join(" ");
}

/** Per-request shopper/context payload for Responses `input` (not instructions). */
export function resaleAgentRequestContextMessage(
  note: string,
  shopperContext?: Record<string, unknown> | null,
): string {
  const { intent, constraints } = constraintsFromFormEdits(note, shopperContext);
  const gate = assertNoNonUserSetConstraints(constraints, intent);
  if (!gate.ok) {
    throw new Error(
      `UserIntent boundary violation: ${gate.hits.map((h) => h.detail).join("; ")}`,
    );
  }
  const rankingKeys = [
    "repairAbility",
    "targetProfitUsd",
    "asIs",
    "sellWithinDays",
    "timeToSell",
    "resaleChannel",
    "preferredMakes",
    "preferredModels",
    "plannedDirectionIds",
  ] as const;
  const ranking: Record<string, unknown> = {};
  for (const key of rankingKeys) {
    const value = shopperContext?.[key];
    if (value == null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    ranking[key] = value;
  }
  const constraintLine =
    Object.keys(constraints).length > 0
      ? `\nUser form constraints (origin=user only; note/serv/suggestion excluded): ${JSON.stringify(constraints)}`
      : "";
  const rankingLine =
    Object.keys(ranking).length > 0
      ? `\nFlip ranking context (not hard inventory filters): ${JSON.stringify(ranking)}`
      : "";
  return `Shopper note:\n${note.trim() || "(empty)"}${constraintLine}${rankingLine}`;
}

function systemPrompt(note: string, shopperContext?: Record<string, unknown> | null): string {
  void resaleAgentRequestContextMessage(note, shopperContext);
  return resaleAgentStableInstructions();
}

const RESALE_TERMINAL_NUDGE =
  "No terminal tool yet. Call submit_picks (chosen flips) or submit_nothing_fits (reason only). Code already journals every search_listings call — do not re-document searches. If every search kept 0 listings, you MUST call submit_nothing_fits with a short written reason now.";

const RESALE_COULD_NOT_FINISH =
  "We couldn't finish this flip search — SERV stopped without submit_picks or submit_nothing_fits after a repair turn.";

function nothingFitsResaleVerdictFromReason(
  reason: string,
  journal: readonly ResaleAgentJournalEntry[],
): import("@/domain/resale-agent").ResaleAgentVerdict {
  const searches = searchesFromResaleJournal(journal);
  return {
    summary: reason.trim(),
    confidence: "low",
    picks: [],
    relaxedConditions: synthesizeRelaxedConditionsFromSearches(searches),
  };
}

/** After a failed terminal nudge: empty search journal → honest nothing-fits (not incomplete). */
function honestEmptyNothingFitsFromResaleJournal(
  journal: readonly ResaleAgentJournalEntry[],
): import("@/domain/resale-agent").ResaleAgentVerdict | null {
  const searches = searchesFromResaleJournal(journal);
  if (!searchesAllEmpty(searches)) return null;
  return nothingFitsResaleVerdictFromReason(honestNothingFitsReasonFromSearches(searches), journal);
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
  /** Chat fallback must not attach function tools for the production BASE_MODEL. */
  tools?: ServChatToolDef[];
  reasoningEffort?: "low" | "medium" | "high";
}): Record<string, unknown> {
  return buildServChatTurnBody({
    messages: input.messages,
    jsonSchema: input.jsonSchema,
    maxTokens: input.maxTokens,
    model: input.model,
    // Never attach function tools on chat — chat cannot pair function tools with a
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
    maxTokens: input.bundle.maxOutputTokens,
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
): Map<
  string,
  { vin: string; priceUsd: number | null; miles: number | null; distanceMiles: number | null }
> {
  const out = new Map<
    string,
    { vin: string; priceUsd: number | null; miles: number | null; distanceMiles: number | null }
  >();
  for (const [vin, listing] of state.listingsByVin) {
    out.set(vin, {
      vin,
      priceUsd: listing.priceUsd ?? null,
      miles: listing.miles ?? null,
      distanceMiles: listing.distanceMiles ?? null,
    });
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
    step: base.step,
    maxOutputTokens: base.maxOutputTokens,
    usage: extractAgentServCallUsage(input.turn.payload),
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
    maxTokens: input.bundle.maxOutputTokens,
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

  const searches = searchesFromResaleJournal(input.journal);
  let gated = validateResaleSubmitPicks(validated.verdict, {
    listingsByVin: listingFactsFromState(input.state),
    budgetUsd: input.budgetUsd,
    pnlByVin: pnlFactsFromState(input.state),
    searches,
  });
  if (!gated.ok) {
    const repairBody = chatBody({
      messages: [
        ...messages,
        { role: "assistant", content: text || "{}" },
        {
          role: "user",
          content: boundaryRepairMessage({
            issues: gated.issues,
            searches,
            hint: "Return corrected resale_agent_result JSON only. Prefer submit_picks / submit_nothing_fits on the tools path.",
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
        message: repair.error || `SERV boundary repair failed (HTTP ${repair.status}).`,
      };
    }
    const repaired = validateResaleAgentVerdict(parseJsonObject(messageText(repair.payload, "structured")));
    if (!repaired.ok) {
      return {
        ok: false,
        error: "verdict_validation_failed",
        message: RESALE_COULD_NOT_FINISH,
      };
    }
    gated = validateResaleSubmitPicks(repaired.verdict, {
      listingsByVin: listingFactsFromState(input.state),
      budgetUsd: input.budgetUsd,
      pnlByVin: pnlFactsFromState(input.state),
      searches: searchesFromResaleJournal(input.journal),
    });
    if (!gated.ok) {
      return {
        ok: false,
        error: "verdict_incomplete",
        message: RESALE_COULD_NOT_FINISH,
      };
    }
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
    selectionHop?: boolean;
    firstTurn: boolean;
    featureRejections: AgentServFeatureRejection[];
  } | null;
}): Promise<ResaleAgentLoopResult> {
  const requestedMode = resolveResaleAgentMode(process.env);
  const rejections: AgentServFeatureRejection[] = [...(input.resume?.featureRejections ?? [])];
  const instructions = systemPrompt(input.note, input.shopperContext);
  const requestContext = resaleAgentRequestContextMessage(input.note, input.shopperContext);
  const seedUser =
    "Search for profitable flips that fit the shopper. Call tools as needed (search_listings injects code flipPnl; parallel OK). When ready, call submit_picks — do not invent VINs or dollars.";
  const finishMessages: ChatMessage[] = input.resume?.messages?.length
    ? [...input.resume.messages]
    : [
        { role: "system", content: instructions },
        { role: "user", content: requestContext },
        { role: "user", content: seedUser },
      ];
  const applicationTools = resaleAgentResponsesTools();
  let responsesInput: ResponsesInputItem[] = input.resume?.responsesInput?.length
    ? [...input.resume.responsesInput]
    : [responsesUserMessage(requestContext), responsesUserMessage(seedUser)];
  let toolRounds = input.resume?.toolRounds ?? 0;
  let firstTurn = input.resume?.firstTurn ?? true;
  let submitNudgeSent = input.resume?.submitNudgeSent ?? false;
  let selectionHop = input.resume?.selectionHop === true;
  const startRound = input.resume?.roundsCompleted ?? 0;
  let latestBundle = buildAgentServFeatureBundle({
    product: "resale",
    step: resolveAgentServStep({
      requireBriefConfirm: input.state.requireBriefConfirm === true,
      briefConfirmed: input.state.briefConfirmed === true,
      searchCount: searchesFromResaleJournal(input.journal).length,
      submitNudgeSent,
      selectionHop,
    }),
    includePromptGuard: firstTurn,
  });

  for (let round = startRound; round < input.maxRounds; round += 1) {
    if (!agentLoopMayStartServCall(input.deadline)) {
      const checkpoint = buildResaleCheckpoint({
        phase: "tools",
        toolRounds,
        roundsCompleted: round,
        responsesInput,
        messages: finishMessages,
        journal: input.journal,
        state: input.state,
        submitNudgeSent,
        selectionHop,
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
        ...resaleLoopMeta(latestBundle, rejections),
      };
    }
    const step = resolveAgentServStep({
      requireBriefConfirm: input.state.requireBriefConfirm === true,
      briefConfirmed: input.state.briefConfirmed === true,
      searchCount: searchesFromResaleJournal(input.journal).length,
      submitNudgeSent,
      selectionHop,
    });
    const bundle = buildAgentServFeatureBundle({
      product: "resale",
      step,
      includePromptGuard: firstTurn,
    });
    latestBundle = bundle;
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
        ...resaleLoopMeta(latestBundle, rejections)
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
        ...resaleLoopMeta(latestBundle, rejections)
      };
    }
    firstTurn = false;

    if (calls.length === 0) {
      if (!submitNudgeSent) {
        submitNudgeSent = true;
        responsesInput = [
          ...responsesInput,
          responsesUserMessage(
            `${RESALE_TERMINAL_NUDGE}\n${boundaryRepairMessage({
              issues: ["Missing terminal tool call."],
              searches: searchesFromResaleJournal(input.journal),
            })}`,
          ),
        ];
        continue;
      }
      const emptyTerminal = honestEmptyNothingFitsFromResaleJournal(input.journal);
      if (emptyTerminal) {
        return {
          ok: true,
          agentMode: "tools",
          requestedMode,
          toolRounds,
          verdictReached: true,
          verdict: emptyTerminal,
          relaxedConditions: emptyTerminal.relaxedConditions,
          journal: input.journal,
          knownVins: [...input.state.knownVins],
          listingsByVin: input.state.listingsByVin,
          pnlByVin: input.state.pnlByVin,
          droppedPicks: [],
          ...resaleLoopMeta(latestBundle, rejections),
        };
      }
      const searches = searchesFromResaleJournal(input.journal);
      return {
        ok: false,
        agentMode: "tools",
        requestedMode,
        toolRounds,
        verdictReached: false,
        error: "missing_terminal",
        message: searchesDocumented(searches)
          ? honestNothingFitsReasonFromSearches(searches)
          : RESALE_COULD_NOT_FINISH,
        journal: input.journal,
        knownVins: [...input.state.knownVins],
        ...resaleLoopMeta(latestBundle, rejections),
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

        if (call.name === "ask_shopper") {
          const executed = await executeResaleAgentTool(call.name, args, input.toolDeps, input.state);
          input.journal.push(journalResaleSearchEntry(executed, args));
          const question =
            executed.ok && typeof (executed.result as { question?: unknown }).question === "string"
              ? String((executed.result as { question: string }).question)
              : typeof (args as { question?: unknown }).question === "string"
                ? String((args as { question: string }).question)
                : "Could you share a bit more about the flip you want?";
          return {
            callId: call.callId,
            name: "ask_shopper" as const,
            accepted: false as const,
            askQuestion: question,
            output: { ok: true, status: "awaiting_shopper", message: "Paused for the shopper reply in chat.", question },
          };
        }

        if (call.name === "submit_brief") {
          const executed = await executeResaleAgentTool(call.name, args, input.toolDeps, input.state);
          input.journal.push(journalResaleSearchEntry(executed, args));
          if (!executed.ok) {
            return {
              callId: call.callId,
              name: "submit_brief" as const,
              accepted: false as const,
              output: executed.result,
            };
          }
          const brief = (executed.result as { brief?: ShopperBrief }).brief ?? null;
          const card =
            typeof (executed.result as { card?: unknown }).card === "string"
              ? String((executed.result as { card: string }).card)
              : brief
                ? formatShopperBriefCard(brief)
                : "Please confirm this search brief.";
          return {
            callId: call.callId,
            name: "submit_brief" as const,
            accepted: false as const,
            brief,
            askQuestion: card,
            output: {
              ok: true,
              status: "awaiting_brief_confirm",
              message: "Paused for Confirm/Correct on the search brief.",
              brief,
              card,
            },
          };
        }

        if (call.name === "submit_picks" || call.name === "submit_nothing_fits") {
          if (step !== "verdict") {
            selectionHop = true;
            input.journal.push({
              kind: "tool",
              name: call.name,
              args,
              summary: `${call.name} deferred: selection hop required`,
              ok: false,
            });
            return {
              callId: call.callId,
              name: call.name as "submit_picks" | "submit_nothing_fits",
              accepted: false as const,
              output: {
                ok: false,
                error: "selection_hop_required",
                message:
                  "Call submit_picks or submit_nothing_fits again on the final selection hop (quality features attach only there). Do not search on that hop.",
              },
            };
          }
          const searches = searchesFromResaleJournal(input.journal);
          const submitArgs =
            call.name === "submit_nothing_fits"
              ? nothingFitsResaleVerdictFromReason(
                  typeof (args as { reason?: unknown }).reason === "string"
                    ? String((args as { reason: string }).reason)
                    : "",
                  input.journal,
                )
              : args;
          const checked = validateResaleSubmitPicks(submitArgs, {
            listingsByVin: listingFactsFromState(input.state),
            budgetUsd: input.deps.budgetUsd ?? null,
            maxRadiusMi: input.state.shopperFacts.radiusMi,
            radiusWidenAgreed: input.state.radiusWidenAgreed === true,
            pnlByVin: pnlFactsFromState(input.state),
            searches,
          });
          if (!checked.ok) {
            const repair = boundaryRepairMessage({
              issues: checked.issues,
              searches,
              hint:
                call.name === "submit_nothing_fits"
                  ? "Fix the reason (or run search_listings first), then call submit_nothing_fits again."
                  : "Fix these issues and call submit_picks or submit_nothing_fits again.",
            });
            input.journal.push({
              kind: "tool",
              name: call.name,
              args,
              summary: `${call.name} rejected: ${checked.issues.map((i) => i.message).join("; ")}`,
              ok: false,
            });
            return {
              callId: call.callId,
              name: call.name as "submit_picks" | "submit_nothing_fits",
              accepted: false as const,
              output: {
                ok: false,
                error: "validation_failed",
                issues: checked.issues,
                message: repair,
                searchJournalEvidence: searches,
              },
            };
          }
          const enriched = enrichResaleRelaxed(checked.verdict, input.journal);
          input.journal.push({
            kind: "tool",
            name: call.name,
            args,
            summary: `${call.name} accepted picks=${enriched.picks.length}`,
            ok: true,
          });
          return {
            callId: call.callId,
            name: call.name as "submit_picks" | "submit_nothing_fits",
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

    const budgetPaused = settled.some((row) => {
      const out = row.output;
      return (
        out != null &&
        typeof out === "object" &&
        !Array.isArray(out) &&
        (out as { error?: unknown }).error === AGENT_LOOP_BUDGET_CONTINUE
      );
    });
    if (budgetPaused) {
      const checkpoint = buildResaleCheckpoint({
        phase: "tools",
        toolRounds,
        roundsCompleted: round + 1,
        responsesInput,
        messages: finishMessages,
        journal: input.journal,
        state: input.state,
        submitNudgeSent,
        selectionHop,
        firstTurn,
        featureRejections: rejections,
      });
      return {
        ok: false,
        continue: true,
        error: AGENT_LOOP_BUDGET_CONTINUE,
        message:
          "Agentic Resale loop paused under the request time budget; continue on the next decide call.",
        agentMode: "tools",
        requestedMode,
        toolRounds,
        verdictReached: false,
        journal: input.journal,
        knownVins: [...input.state.knownVins],
        checkpoint,
        ...resaleLoopMeta(latestBundle, rejections),
      };
    }

    const asked = settled.find(
      (row) => row.name === "ask_shopper" && "askQuestion" in row && typeof (row as { askQuestion?: unknown }).askQuestion === "string",
    ) as { callId: string; name: "ask_shopper"; askQuestion: string; output: unknown } | undefined;
    if (asked) {
      const checkpoint = buildResaleCheckpoint({
        phase: "tools",
        toolRounds,
        roundsCompleted: round + 1,
        responsesInput,
        messages: finishMessages,
        journal: input.journal,
        state: input.state,
        submitNudgeSent,
        selectionHop,
        firstTurn,
        featureRejections: rejections,
      });
      checkpoint.pendingAskCallId = asked.callId;
      checkpoint.pendingAskQuestion = asked.askQuestion;
      return {
        ok: false,
        awaitUser: true as const,
        awaitKind: "ask" as const,
        question: asked.askQuestion,
        message: asked.askQuestion,
        agentMode: "tools" as const,
        requestedMode,
        toolRounds,
        verdictReached: false as const,
        journal: input.journal,
        knownVins: [...input.state.knownVins],
        checkpoint,
        featureRejections: rejections,
        featureFlags: [] as string[],
        servFeatures: null,
      };
    }

    const briefed = settled.find(
      (row) =>
        row.name === "submit_brief" &&
        "brief" in row &&
        (row as { brief?: unknown }).brief &&
        typeof (row as { askQuestion?: unknown }).askQuestion === "string",
    ) as
      | { callId: string; name: "submit_brief"; brief: ShopperBrief; askQuestion: string; output: unknown }
      | undefined;
    if (briefed) {
      const checkpoint = buildResaleCheckpoint({
        phase: "tools",
        toolRounds,
        roundsCompleted: round + 1,
        responsesInput,
        messages: finishMessages,
        journal: input.journal,
        state: input.state,
        submitNudgeSent,
        selectionHop,
        firstTurn,
        featureRejections: rejections,
      });
      checkpoint.pendingBriefCallId = briefed.callId;
      checkpoint.pendingBrief = briefed.brief as unknown as Record<string, unknown>;
      checkpoint.pendingAskQuestion = briefed.askQuestion;
      checkpoint.briefConfirmed = false;
      return {
        ok: false,
        awaitUser: true as const,
        awaitKind: "brief" as const,
        brief: briefed.brief,
        question: briefed.askQuestion,
        message: briefed.askQuestion,
        agentMode: "tools" as const,
        requestedMode,
        toolRounds,
        verdictReached: false as const,
        journal: input.journal,
        knownVins: [...input.state.knownVins],
        checkpoint,
        featureRejections: rejections,
        featureFlags: [] as string[],
        servFeatures: null,
      };
    }

    const accepted = settled.find(
      (row) =>
        (row.name === "submit_picks" || row.name === "submit_nothing_fits") &&
        "accepted" in row &&
        row.accepted === true &&
        "verdict" in row,
    ) as
      | {
          callId: string;
          name: "submit_picks" | "submit_nothing_fits";
          accepted: true;
          verdict: ResaleAgentVerdict;
          output: unknown;
        }
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
        ...resaleLoopMeta(latestBundle, rejections),
      };
    }
  }

  {
    const emptyTerminal = honestEmptyNothingFitsFromResaleJournal(input.journal);
    if (emptyTerminal) {
      return {
        ok: true,
        agentMode: "tools",
        requestedMode,
        toolRounds,
        verdictReached: true,
        verdict: emptyTerminal,
        relaxedConditions: emptyTerminal.relaxedConditions,
        journal: input.journal,
        knownVins: [...input.state.knownVins],
        listingsByVin: input.state.listingsByVin,
        pnlByVin: input.state.pnlByVin,
        droppedPicks: [],
        ...resaleLoopMeta(latestBundle, rejections),
      };
    }
    const searches = searchesFromResaleJournal(input.journal);
    return {
      ok: false,
      agentMode: "tools",
      requestedMode,
      toolRounds,
      verdictReached: false,
      error: "missing_terminal",
      message: searchesDocumented(searches)
        ? honestNothingFitsReasonFromSearches(searches)
        : RESALE_COULD_NOT_FINISH,
      journal: input.journal,
      knownVins: [...input.state.knownVins],
      ...resaleLoopMeta(latestBundle, rejections),
    };
  }
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
    selectionHop?: boolean;
    firstTurn: boolean;
    featureRejections: AgentServFeatureRejection[];
  } | null;
}): Promise<ResaleAgentLoopResult> {
  const requestedMode = resolveResaleAgentMode(process.env);
  const rejections: AgentServFeatureRejection[] = [...(input.resume?.featureRejections ?? [])];
  const stable = resaleAgentStableInstructions();
  const requestContext = resaleAgentRequestContextMessage(input.note, input.shopperContext);
  const messages: ChatMessage[] = input.resume?.messages?.length
    ? [...input.resume.messages]
    : [
        {
          role: "system",
          content: [
            stable,
            "Each turn return JSON with action search or finish.",
            "search runs search_listings with the provided filters.",
            "finish must include the resale_agent_result fields (summary, confidence, picks, relaxedConditions).",
          ].join(" "),
        },
        { role: "user", content: requestContext },
        { role: "user", content: "Begin. Prefer a focused search first." },
      ];
  let toolRounds = input.resume?.toolRounds ?? 0;
  const startRound = input.resume?.roundsCompleted ?? 0;
  let firstTurn = input.resume?.firstTurn ?? true;
  let submitNudgeSent = input.resume?.submitNudgeSent ?? false;
  let selectionHop = input.resume?.selectionHop === true;
  let latestBundle = buildAgentServFeatureBundle({
    product: "resale",
    step: resolveAgentServStep({
      requireBriefConfirm: input.state.requireBriefConfirm === true,
      briefConfirmed: input.state.briefConfirmed === true,
      searchCount: searchesFromResaleJournal(input.journal).length,
      submitNudgeSent,
      selectionHop,
    }),
    includePromptGuard: firstTurn,
  });

  const nextActionBody = (msgs: ChatMessage[], bundle: AgentServFeatureBundle) =>
    chatBody({
      messages: msgs,
      model: bundle.model,
      // Schema-only chat; never function tools + never reasoning_effort "none".
      jsonSchema: {
        name: "resale_agent_next_action",
        schema: RESALE_AGENT_NEXT_ACTION_SCHEMA as unknown as Record<string, unknown>,
      },
      reasoningEffort: "low",
      maxTokens: bundle.maxOutputTokens,
    });

  for (let round = startRound; round < input.maxRounds; round += 1) {
    const step = resolveAgentServStep({
      requireBriefConfirm: input.state.requireBriefConfirm === true,
      briefConfirmed: input.state.briefConfirmed === true,
      searchCount: searchesFromResaleJournal(input.journal).length,
      submitNudgeSent,
      selectionHop,
    });
    const bundle = buildAgentServFeatureBundle({
      product: "resale",
      step,
      includePromptGuard: firstTurn,
    });
    latestBundle = bundle;
    if (!agentLoopMayStartServCall(input.deadline)) {
      const checkpoint = buildResaleCheckpoint({
        phase: "next_action",
        toolRounds,
        roundsCompleted: round,
        responsesInput: [],
        messages,
        journal: input.journal,
        state: input.state,
        submitNudgeSent,
        selectionHop,
        firstTurn,
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
        ...resaleLoopMeta(latestBundle, rejections),
      };
    }
    let body = nextActionBody(messages, bundle);
    firstTurn = false;

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
        ...resaleLoopMeta(latestBundle, rejections),
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
          ...resaleLoopMeta(latestBundle, rejections),
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
        ...resaleLoopMeta(latestBundle, rejections),
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
      if (executed.result?.error === AGENT_LOOP_BUDGET_CONTINUE) {
        const checkpoint = buildResaleCheckpoint({
          phase: "next_action",
          toolRounds,
          roundsCompleted: round + 1,
          responsesInput: [],
          messages,
          journal: input.journal,
          state: input.state,
          submitNudgeSent: false,
          selectionHop,
          firstTurn: false,
          featureRejections: rejections,
        });
        return {
          ok: false,
          continue: true,
          error: AGENT_LOOP_BUDGET_CONTINUE,
          message:
            "Agentic Resale loop paused under the request time budget; continue on the next decide call.",
          agentMode: "next_action",
          requestedMode,
          toolRounds,
          verdictReached: false,
          journal: input.journal,
          knownVins: [...input.state.knownVins],
          checkpoint,
          ...resaleLoopMeta(latestBundle, rejections),
        };
      }
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
            ...resaleLoopMeta(latestBundle, rejections),
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
            ...resaleLoopMeta(latestBundle, rejections),
          };
        }
      }

      const searches = searchesFromResaleJournal(input.journal);
      const gated = validateResaleSubmitPicks(validated.verdict, {
        listingsByVin: listingFactsFromState(input.state),
        budgetUsd: input.deps.budgetUsd ?? null,
        pnlByVin: pnlFactsFromState(input.state),
        searches,
      });
      if (!gated.ok) {
        messages.push({
          role: "user",
          content: boundaryRepairMessage({
            issues: gated.issues,
            searches,
            hint: "Finish verdict incomplete. Return a corrected finish action JSON (or keep searching).",
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
        ...resaleLoopMeta(latestBundle, rejections),
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
    ...resaleLoopMeta(latestBundle, rejections),
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
  shopperReply?: string | null;
  briefConfirmed?: boolean;
  requireBriefConfirm?: boolean;
}): Promise<ResaleAgentLoopResult> {
  const requestedMode = input.mode ?? resolveResaleAgentMode(process.env);
  const maxRounds = input.maxRounds ?? 40;
  const fetchImpl = input.deps.fetch ?? fetch;
  const baseUrl = servApiBase(input.deps.servBaseUrl);
  const restored = restoreResaleStateFromCheckpoint(input.checkpoint, input.deps.seedListings);
  const journal = restored.journal;
  const state = restored.state;
  state.requireBriefConfirm = input.requireBriefConfirm === true;
  if (input.briefConfirmed === true) state.briefConfirmed = true;
  const shopperContext = input.shopperContext ?? input.deps.shopperContext;
  // Provenance → constraintRoles: origin=user form keys are hard; SERV-chosen are relaxable.
  const { constraints: userFormConstraints } = constraintsFromFormEdits(
    input.note,
    shopperContext,
  );
  state.userHardKeys = hardSearchKeysFromUserBag(userFormConstraints);
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
    chatTranscript: input.note,
    deadline,
  };

  const reply = typeof input.shopperReply === "string" ? input.shopperReply.trim() : "";
  let responsesInput = restored.responsesInput;
  let messages = restored.messages;
  const pendingBrief = input.checkpoint?.pendingBrief as ShopperBrief | null | undefined;
  if (input.briefConfirmed && pendingBrief && responsesInput) {
    const card = formatShopperBriefCard(pendingBrief);
    journal.push({
      kind: "tool",
      name: "submit_brief_confirmed",
      args: pendingBrief,
      summary: `submit_brief confirmed: ${pendingBrief.summary.slice(0, 80)}`,
      ok: true,
    });
    if (pendingBrief.budget.maxUsd != null) input.deps.budgetUsd = pendingBrief.budget.maxUsd;
    responsesInput = [
      ...responsesInput,
      responsesUserMessage(
        `Shopper CONFIRMED the search brief:\n${card}\nJournal recorded submit_brief_confirmed. Search starts now — call search_listings next (do not ask/resubmit_brief). Then submit_picks or submit_nothing_fits.`,
      ),
    ];
    messages = [...(messages ?? []), { role: "user" as const, content: `Shopper confirmed the search brief:\n${card}` }];
    state.briefConfirmed = true;
    if (pendingBrief.budget.maxUsd != null) state.shopperFacts.budgetUsd = pendingBrief.budget.maxUsd;
    if (pendingBrief.zip) state.shopperFacts.zip = pendingBrief.zip;
    if (Object.prototype.hasOwnProperty.call(pendingBrief, "radiusMi")) {
      state.shopperFacts.radiusMi = pendingBrief.radiusMi;
    }
    state.radiusWidenAgreed = Boolean(
      pendingBrief.agreedRelaxations?.some((row) =>
        /radius|distance|nationwide|widen/i.test(`${row.key} ${row.value}`),
      ),
    );
    if (input.checkpoint) {
      input.checkpoint.pendingBrief = null;
      input.checkpoint.pendingBriefCallId = null;
      input.checkpoint.pendingAskQuestion = null;
      input.checkpoint.briefConfirmed = true;
    }
  } else if (reply && pendingBrief && responsesInput) {
    responsesInput = [
      ...responsesInput,
      responsesUserMessage(
        `Shopper CORRECTED the search brief:\n${reply}\nCall submit_brief again. Do not search until they confirm.`,
      ),
    ];
    messages = [...(messages ?? []), { role: "user" as const, content: `Shopper corrected the search brief:\n${reply}` }];
    if (input.checkpoint) {
      input.checkpoint.pendingBrief = null;
      input.checkpoint.pendingBriefCallId = null;
      input.checkpoint.pendingAskQuestion = null;
      input.checkpoint.briefConfirmed = false;
    }
  } else if (reply && responsesInput) {
    const question = input.checkpoint?.pendingAskQuestion?.trim() || "your question";
    responsesInput = [
      ...responsesInput,
      responsesUserMessage(
        `Shopper replied to ask_shopper ("${question}"):\n${reply}\nContinue: submit_brief before search_listings / submit_picks.`,
      ),
    ];
    messages = [...(messages ?? []), { role: "user" as const, content: `Shopper replied: ${reply}` }];
    if (input.checkpoint) {
      input.checkpoint.pendingAskCallId = null;
      input.checkpoint.pendingAskQuestion = null;
    }
  }

  const resume = {
    toolRounds: restored.toolRounds,
    roundsCompleted: restored.roundsCompleted,
    responsesInput,
    messages,
    submitNudgeSent: restored.submitNudgeSent,
    selectionHop: restored.selectionHop,
    firstTurn: restored.firstTurn,
    featureRejections: restored.featureRejections,
  };

  const shared = {
    note: input.note,
    shopperContext,
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
  if ("awaitUser" in toolsAttempt && toolsAttempt.awaitUser) {
    return toolsAttempt;
  }
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

/** Journal step counts + per-request SERV usage total for eval reports. */
export function summarizeResaleAgentJournal(journal: readonly ResaleAgentJournalEntry[]): {
  servCalls: number;
  toolCalls: number;
  toolRounds: number;
  servUsageTotal: AgentServUsageTotals;
  featuresActive: string[];
  featuresActivePerCall: string[][];
  featureRejections: string[];
  servResponseIds: string[];
} {
  let servCalls = 0;
  let toolCalls = 0;
  const usageRows: Array<AgentServCallUsage | null> = [];
  const features = new Set<string>();
  const featuresActivePerCall: string[][] = [];
  const featureRejections = new Set<string>();
  const servResponseIds: string[] = [];
  for (const entry of journal) {
    if (entry.kind === "serv") {
      servCalls += 1;
      usageRows.push(entry.usage ?? null);
      const callFeatures: string[] = [];
      for (const f of entry.features ?? []) {
        if (typeof f === "string" && f.trim()) {
          features.add(f.trim());
          callFeatures.push(f.trim());
        }
      }
      featuresActivePerCall.push(callFeatures);
      if (typeof entry.responseId === "string" && entry.responseId.trim()) {
        servResponseIds.push(entry.responseId.trim());
      }
      for (const flag of entry.featureFlags ?? []) {
        if (typeof flag === "string" && flag.includes("FEATURE_REJECTION")) {
          featureRejections.add(flag);
        }
      }
    } else if (entry.kind === "tool" && entry.name !== "_mode_fallback") {
      toolCalls += 1;
    }
  }
  return {
    servCalls,
    toolCalls,
    toolRounds: toolCalls,
    servUsageTotal: sumAgentServUsage(usageRows),
    featuresActive: [...features],
    featuresActivePerCall,
    featureRejections: [...featureRejections],
    servResponseIds,
  };
}
