/**
 * Agentic Find SERV loop — tools mode (preferred) or next_action fallback.
 * Model: gpt-6.1-sol only. No profile abort; SERV_HTTP_DEADLINE_MS on each HTTP.
 * Multi-round runs are stepped across requests under the Hobby 300s cap
 * (persist checkpoint; never clip SERV call timeouts).
 */
import {
  synthesizeRelaxedConditionsFromSearches,
} from "@/domain/agent-verdict-complete";
import { fromShopperInputEvent } from "@/domain/constraint-provenance";
import {
  fingerprintsFromSearchJournal,
  hardSearchKeysFromUserBag,
} from "@/domain/search-listings-feedback";
import {
  assertNoNonUserSetConstraints,
  buildUserIntentFromFlatForm,
  serializeUserIntentConstraints,
} from "@/domain/serv-boundary";
import {
  applyFindAgentGuardrails,
  FIND_AGENT_NEXT_ACTION_SCHEMA,
  FIND_AGENT_RESULT_SCHEMA,
  resolveFindAgentMode,
  validateFindAgentVerdict,
  validateFindSubmitPicks,
  type FindAgentMode,
  type FindAgentModeResolved,
  type FindAgentRelaxedCondition,
  type FindAgentVerdict,
} from "@/domain/find-agent";
import {
  AGENT_LOOP_BUDGET_CONTINUE,
  agentLoopMayStartRound,
  makeAgentLoopDeadline,
  type AgentLoopDeadline,
} from "@/domain/agent-loop-deadline";
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
  serializeListingsByVin,
  type AgentLoopCheckpoint,
} from "@/server/serv/agent-loop-checkpoint";
import {
  classifyAgentFeatureRejection,
  findAgentServFeatureBundle,
  formatFeatureRejectionFlags,
  journalFromBundle,
  mergeResponsesTools,
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
  endpoint: "responses" | "chat";
  /** Documented SERV features requested on this call (never silently omitted). */
  features: AgentServFeatureJournal["features"];
  promptGuard: AgentServFeatureJournal["promptGuard"];
  shadowRequested: boolean;
  shadowMaxIterations: number | null;
  shadowOutcome: string | null;
  featureRejections: AgentServFeatureRejection[];
  featureFlags: string[];
};

export type FindAgentJournalToolCall = {
  kind: "tool";
  name: string;
  args: unknown;
  summary: string;
  ok: boolean;
  /** search_listings: listings kept after funnel (for scoring / nothing-fits). */
  resultCount?: number;
  funnel?: Array<{ step: string; count: number }>;
  /** Provider HTTP status when search_listings failed upstream (0 = network/timeout). */
  providerStatus?: number;
  /** Upstream cause: http_error | timeout | network | aborted | … */
  providerCause?: string;
  /** Attempts including retries before the final provider outcome. */
  providerAttempts?: number;
};

/** Extract documented search_listings rows from the agent journal. */
export function searchesFromFindJournal(
  journal: readonly FindAgentJournalEntry[],
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
      (fromSummary ? Number(fromSummary[1]) : zeroSummary ? 0 : entry.ok ? 0 : 0);
    out.push({
      params,
      resultCount: Number.isFinite(resultCount) ? resultCount : 0,
      funnel: entry.funnel ?? null,
    });
  }
  return out;
}

function enrichFindRelaxed(
  verdict: FindAgentVerdict,
  journal: readonly FindAgentJournalEntry[],
): FindAgentVerdict {
  // Placeholders already stripped in validateFindAgentVerdict; synthesize when empty.
  if (verdict.relaxedConditions.length > 0) return verdict;
  const synthesized = synthesizeRelaxedConditionsFromSearches(searchesFromFindJournal(journal));
  if (synthesized.length === 0) return verdict;
  return { ...verdict, relaxedConditions: synthesized };
}

function journalSearchListingsEntry(
  executed: { name: string; summary: string; ok: boolean; result: unknown },
  args: unknown,
): FindAgentJournalToolCall {
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

export type FindAgentJournalEntry = FindAgentJournalServCall | FindAgentJournalToolCall;

export type FindAgentLoopDeps = {
  servKey: string;
  autodevKey: string;
  fetch?: typeof fetch;
  servBaseUrl?: string;
  /** Autodev cache/counter/reserve — tests inject MemoryCounter. */
  autodev?: FindAgentToolDeps["autodev"];
  seedListings?: readonly Listing[];
  /**
   * Budget USD ceiling — only when labeled user/note provenance.
   * Untagged need.budgetUsd must never be passed here.
   */
  budgetUsd?: number | null;
  /** Provenance label for the budget ceiling (user | note). */
  budgetProvenance?: "user" | "note" | "form" | string | null;
};

export type FindAgentLoopContinue = {
  ok: false;
  continue: true;
  error: typeof AGENT_LOOP_BUDGET_CONTINUE;
  message: string;
  agentMode: FindAgentModeResolved;
  requestedMode: FindAgentMode;
  toolRounds: number;
  verdictReached: false;
  journal: FindAgentJournalEntry[];
  knownVins: string[];
  featureRejections: AgentServFeatureRejection[];
  featureFlags: string[];
  servFeatures: AgentServFeatureJournal | null;
  checkpoint: AgentLoopCheckpoint;
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
      /** Exact Responses/chat feature rejection strings — empty when all extensions accepted. */
      featureRejections: AgentServFeatureRejection[];
      featureFlags: string[];
      servFeatures: AgentServFeatureJournal;
    }
  | FindAgentLoopContinue
  | {
      ok: false;
      continue?: false;
      agentMode: FindAgentModeResolved | null;
      requestedMode: FindAgentMode;
      toolRounds: number;
      verdictReached: false;
      error: string;
      message: string;
      journal: FindAgentJournalEntry[];
      knownVins: string[];
      featureRejections: AgentServFeatureRejection[];
      featureFlags: string[];
      servFeatures: AgentServFeatureJournal | null;
    };

type ChatMessage = ServChatTurnMessage;
type ToolCallWire = ServChatToolCallWire;

function buildFindCheckpoint(input: {
  phase: "tools" | "next_action";
  toolRounds: number;
  roundsCompleted: number;
  responsesInput: ResponsesInputItem[];
  messages: ChatMessage[];
  journal: FindAgentJournalEntry[];
  state: FindAgentToolState;
  submitNudgeSent: boolean;
  firstTurn: boolean;
  featureRejections: AgentServFeatureRejection[];
}): AgentLoopCheckpoint {
  return {
    v: 1,
    product: "find",
    phase: input.phase,
    toolRounds: input.toolRounds,
    roundsCompleted: input.roundsCompleted,
    responsesInput: input.responsesInput,
    messages: input.messages,
    journal: input.journal as unknown as Array<Record<string, unknown>>,
    knownVins: [...input.state.knownVins],
    listingsByVin: serializeListingsByVin(input.state.listingsByVin),
    submitNudgeSent: input.submitNudgeSent,
    firstTurn: input.firstTurn,
    featureRejections: input.featureRejections as unknown as Array<Record<string, unknown>>,
  };
}

function restoreFindStateFromCheckpoint(
  checkpoint: AgentLoopCheckpoint | null | undefined,
  seedListings?: readonly Listing[],
): {
  state: FindAgentToolState;
  journal: FindAgentJournalEntry[];
  toolRounds: number;
  roundsCompleted: number;
  responsesInput: ResponsesInputItem[] | null;
  messages: ChatMessage[] | null;
  submitNudgeSent: boolean;
  firstTurn: boolean;
  featureRejections: AgentServFeatureRejection[];
  phase: "tools" | "next_action" | null;
} {
  if (!checkpoint || checkpoint.product !== "find") {
    return {
      state: createFindAgentToolState(seedListings),
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
  const state = createFindAgentToolState(seedListings);
  state.knownVins = new Set(checkpoint.knownVins.map((v) => v.toUpperCase()));
  state.listingsByVin = deserializeListingsByVin(checkpoint.listingsByVin);
  const journal = checkpoint.journal as unknown as FindAgentJournalEntry[];
  state.searchFingerprints = fingerprintsFromSearchJournal(searchesFromFindJournal(journal));
  return {
    state,
    journal,
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


function constraintsFromFormEdits(
  note: string,
  formEdits?: Record<string, unknown> | null,
): { intent: ReturnType<typeof buildUserIntentFromFlatForm>; constraints: Record<string, unknown> } {
  const form = formEdits ?? {};
  // Already provenance-tagged (orchestrator / job serialization)?
  const looksTagged = Object.values(form).some(
    (v) =>
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      "value" in (v as object) &&
      ("origin" in (v as object) || "provenance" in (v as object)),
  );
  if (looksTagged) {
    // Form-edits channel: only origin "user" (legacy "form") — note stays in the prompt as context.
    const intent = { note, fields: {} as import("@/domain/serv-boundary").UserIntent["fields"] };
    const constraints: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(form)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const row = raw as { value?: unknown; provenance?: unknown; origin?: unknown; quote?: unknown };
      const origin = typeof row.origin === "string" ? row.origin : row.provenance;
      if (origin !== "user" && origin !== "form") continue;
      // Revive wire-tagged user cells — do not invent user from bare values.
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

function systemPrompt(note: string, formEdits?: Record<string, unknown> | null): string {
  const { intent, constraints } = constraintsFromFormEdits(note, formEdits);
  const gate = assertNoNonUserSetConstraints(constraints, intent);
  if (!gate.ok) {
    throw new Error(
      `UserIntent boundary violation: ${gate.hits.map((h) => h.detail).join("; ")}`,
    );
  }
  const edits =
    Object.keys(constraints).length > 0
      ? `\nUser form constraints (origin=user only; note/serv/suggestion excluded): ${JSON.stringify(constraints)}`
      : "";
  return [
    "You are Lemonless Find's search agent on SERV (gpt-6.1-sol).",
    "You decide which listings to search. Prefer tight filters first.",
    "When results are empty or poor, read search_listings.funnel + relaxHints + constraintRoles: change a relaxable (SERV-chosen) filter at the step that hit zero (omit_body, widen_radius, raise_price, drop_transmission, next_model) and re-search. Prefer bodyFamily=car over Sedan. constraintRoles.hard are shopper origin=user filters — keep unless the shopper's note allows otherwise; never invent which keys are hard. Profit and sell-window are not inventory filters. Code never auto-relaxes or forces filter changes — you decide.",
    "search_listings returns unfiltered provider rows plus an observational funnel — code does not drop rows for product decisions. If duplicateSearch is set, prefer changing a relaxable filter; a reasoned pass with journaled searches is still valid.",
    "Explain every relaxation in relaxedConditions when you finish (real text; never redacted).",
    "A pass/nothing-fits must include passReason that states what you tried and why nothing fit — never pass silently without a written reason and journaled searches.",
    "Finish by calling submit_picks with the find_agent_result fields. Code validates VINs against tool results, offer ≤ budget, and offer ≤ asking — on failure you get issues back and must fix via another submit_picks. Code never substitutes a pick.",
    "Never invent cars, prices, or VINs. Parallel tool calls are fine.",
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
  applicationTools: ReturnType<typeof findAgentResponsesTools>;
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

function pushServJournal(input: {
  journal: FindAgentJournalEntry[];
  rejections: AgentServFeatureRejection[];
  bundle: AgentServFeatureBundle;
  responseId: string | null;
  latencyMs: number;
  mode: FindAgentModeResolved;
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
  state: FindAgentToolState,
): Map<string, { vin: string; priceUsd: number | null; miles: number | null }> {
  const out = new Map<string, { vin: string; priceUsd: number | null; miles: number | null }>();
  for (const [vin, listing] of state.listingsByVin) {
    out.set(vin, { vin, priceUsd: listing.priceUsd ?? null, miles: listing.miles ?? null });
  }
  return out;
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
  budgetProvenance?: string | null;
  bundle: AgentServFeatureBundle;
  rejections: AgentServFeatureRejection[];
}): Promise<
  | { ok: true; verdict: FindAgentVerdict; dropped: Array<{ vin: string; reason: string }> }
  | { ok: false; error: string; message: string }
> {
  const vinList = [...input.state.knownVins].slice(0, 40);
  const budgetLine =
    input.budgetUsd != null
      ? `Budget USD ceiling (${input.budgetProvenance === "user" || input.budgetProvenance === "form" ? "user" : input.budgetProvenance === "note" ? "note" : "labeled"}): ${input.budgetUsd}`
      : "Budget unknown (no user/note-labeled ceiling).";
  const finishUser = [
    "Return the final find_agent_result JSON now.",
    "picks[].vin must be copied exactly from tool listing results.",
    `Known VINs from tools: ${vinList.length ? vinList.join(", ") : "(none — pass with passReason)"}`,
    budgetLine,
  ].join("\n");

  const messages: ChatMessage[] = [
    ...input.priorMessages,
    { role: "user", content: finishUser },
  ];

  // Chat finish is schema-only with a supported reasoning_effort (never "none").
  // Extensions (Prompt Guard / Shadow) stay on /v1/responses tools mode.
  const withExtensions = chatBody({
    messages,
    model: input.bundle.model,
    jsonSchema: { name: "find_agent_result", schema: FIND_AGENT_RESULT_SCHEMA as unknown as Record<string, unknown> },
    reasoningEffort: "low",
  });
  let turn = await postChat({
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    fetch: input.fetch,
    body: withExtensions,
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

  // If chat rejects guard/shadow beside json_schema, keep requesting them on Responses;
  // for this chat finish only, retry schema-only WITH the feature model suffix still set,
  // and flag the exact error (never silent).
  if (!turn.ok) {
    const flagged = classifyAgentFeatureRejection({
      status: turn.status,
      payload: turn.payload,
      error: turn.error,
      endpoint: "chat",
      requestedFeatures: input.bundle.features,
    });
    if (flagged.length > 0) {
      const schemaOnly = chatBody({
        messages,
        model: input.bundle.model,
        jsonSchema: {
          name: "find_agent_result",
          schema: FIND_AGENT_RESULT_SCHEMA as unknown as Record<string, unknown>,
        },
      });
      turn = await postChat({
        apiKey: input.apiKey,
        baseUrl: input.baseUrl,
        fetch: input.fetch,
        body: schemaOnly,
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
      input.journal.push({
        kind: "tool",
        name: "_feature_flag",
        args: { phase: "chat_finish_schema_only_retry", flagged },
        summary: formatFeatureRejectionFlags(flagged).join(" | "),
        ok: false,
      });
    }
  }

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
      model: input.bundle.model,
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
    validated = validateFindAgentVerdict(parseJsonObject(repairText));
    if (!validated.ok) {
      return {
        ok: false,
        error: "verdict_validation_failed",
        message: validated.issues.map((i) => i.message).join("; "),
      };
    }
  }

  const gated = validateFindSubmitPicks(validated.verdict, {
    listingsByVin: listingFactsFromState(input.state),
    budgetUsd: input.budgetUsd,
    searches: searchesFromFindJournal(input.journal),
  });
  if (!gated.ok) {
    return {
      ok: false,
      error: "verdict_incomplete",
      message: gated.issues.map((i) => i.message).join("; "),
    };
  }
  const guarded = applyFindAgentGuardrails(gated.verdict, {
    allowedVins: input.state.knownVins,
    budgetUsd: input.budgetUsd,
  });
  return {
    ok: true,
    verdict: enrichFindRelaxed(guarded.verdict, input.journal),
    dropped: guarded.dropped,
  };
}

function findLoopMeta(bundle: AgentServFeatureBundle, rejections: AgentServFeatureRejection[]) {
  return {
    featureRejections: [...rejections],
    featureFlags: formatFeatureRejectionFlags(rejections),
    servFeatures: journalFromBundle(bundle, { featureRejections: rejections, endpoint: "responses" }),
  };
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
}): Promise<FindAgentLoopResult> {
  const requestedMode = resolveFindAgentMode(process.env);
  const bundle = findAgentServFeatureBundle();
  const rejections: AgentServFeatureRejection[] = [...(input.resume?.featureRejections ?? [])];
  const instructions = systemPrompt(input.note, input.formEdits);
  const seedUser =
    "Search for cars that fit the shopper. Call tools as needed (parallel OK). When ready, call submit_picks with the final verdict — do not invent VINs.";
  // Chat transcript kept only as a safety-net finish path if submit_picks never lands.
  const finishMessages: ChatMessage[] = input.resume?.messages?.length
    ? [...input.resume.messages]
    : [
        { role: "system", content: instructions },
        { role: "user", content: seedUser },
      ];
  const applicationTools = findAgentResponsesTools();
  let responsesInput: ResponsesInputItem[] = input.resume?.responsesInput?.length
    ? [...input.resume.responsesInput]
    : [responsesUserMessage(seedUser)];
  let toolRounds = input.resume?.toolRounds ?? 0;
  let firstTurn = input.resume?.firstTurn ?? true;
  let submitNudgeSent = input.resume?.submitNudgeSent ?? false;
  const startRound = input.resume?.roundsCompleted ?? 0;

  for (let round = startRound; round < input.maxRounds; round += 1) {
    if (!agentLoopMayStartRound(input.deadline)) {
      const checkpoint = buildFindCheckpoint({
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
          "Agentic Find loop paused under the request time budget; continue on the next decide call.",
        agentMode: "tools",
        requestedMode,
        toolRounds,
        verdictReached: false,
        journal: input.journal,
        knownVins: [...input.state.knownVins],
        checkpoint,
        ...findLoopMeta(bundle, rejections),
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
        ...findLoopMeta(bundle, rejections),
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
        ...findLoopMeta(bundle, rejections),
      };
    }
    firstTurn = false;

    if (calls.length === 0) {
      if (!submitNudgeSent) {
        submitNudgeSent = true;
        responsesInput = [
          ...responsesInput,
          responsesUserMessage(
            "No tool calls received. Call submit_picks now with summary/confidence/picks/relaxedConditions/passReason using only VINs from prior tool results.",
          ),
        ];
        continue;
      }
      // Safety net: chat json_schema finish if SERV stopped without submit_picks.
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
        budgetProvenance: input.deps.budgetProvenance ?? null,
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
          ...findLoopMeta(bundle, rejections),
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
        ...findLoopMeta(bundle, rejections),
      };
    }

    // Parallel tool execution; every call_id must get a function_call_output.
    const settled = await Promise.all(
      calls.map(async (call) => {
        let args: unknown = {};
        try {
          args = JSON.parse(call.arguments || "{}") as unknown;
        } catch {
          args = {};
        }

        if (call.name === "submit_picks") {
          const checked = validateFindSubmitPicks(args, {
            listingsByVin: listingFactsFromState(input.state),
            budgetUsd: input.deps.budgetUsd ?? null,
            searches: searchesFromFindJournal(input.journal),
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
          const enriched = enrichFindRelaxed(checked.verdict, input.journal);
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

        const executed = await executeFindAgentTool(call.name, args, input.toolDeps, input.state);
        input.journal.push(journalSearchListingsEntry(executed, args));
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
      | { callId: string; name: "submit_picks"; accepted: true; verdict: FindAgentVerdict; output: unknown }
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
        droppedPicks: [],
        ...findLoopMeta(bundle, rejections),
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
    ...findLoopMeta(bundle, rejections),
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
}): Promise<FindAgentLoopResult> {
  const requestedMode = resolveFindAgentMode(process.env);
  const bundle = findAgentServFeatureBundle();
  const rejections: AgentServFeatureRejection[] = [...(input.resume?.featureRejections ?? [])];
  const messages: ChatMessage[] = input.resume?.messages?.length
    ? [...input.resume.messages]
    : [
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
  let toolRounds = input.resume?.toolRounds ?? 0;
  const startRound = input.resume?.roundsCompleted ?? 0;

  const nextActionBody = (msgs: ChatMessage[]) =>
    chatBody({
      messages: msgs,
      model: bundle.model,
      // Schema-only chat; never function tools + never reasoning_effort "none".
      jsonSchema: {
        name: "find_agent_next_action",
        schema: FIND_AGENT_NEXT_ACTION_SCHEMA as unknown as Record<string, unknown>,
      },
      reasoningEffort: "low",
    });

  for (let round = startRound; round < input.maxRounds; round += 1) {
    if (!agentLoopMayStartRound(input.deadline)) {
      const checkpoint = buildFindCheckpoint({
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
          "Agentic Find loop paused under the request time budget; continue on the next decide call.",
        agentMode: "next_action",
        requestedMode,
        toolRounds,
        verdictReached: false,
        journal: input.journal,
        knownVins: [...input.state.knownVins],
        checkpoint,
        ...findLoopMeta(bundle, rejections),
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
            name: "find_agent_next_action",
            schema: FIND_AGENT_NEXT_ACTION_SCHEMA as unknown as Record<string, unknown>,
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
        ...findLoopMeta(bundle, rejections),
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
        model: bundle.model,
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
          ...findLoopMeta(bundle, rejections),
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
        ...findLoopMeta(bundle, rejections),
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
      input.journal.push(journalSearchListingsEntry(executed, argsValue));
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
          model: bundle.model,
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
            ...findLoopMeta(bundle, rejections),
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
            ...findLoopMeta(bundle, rejections),
          };
        }
      }

      const gated = validateFindSubmitPicks(validated.verdict, {
        listingsByVin: listingFactsFromState(input.state),
        budgetUsd: input.deps.budgetUsd ?? null,
        searches: searchesFromFindJournal(input.journal),
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
      const guarded = applyFindAgentGuardrails(gated.verdict, {
        allowedVins: input.state.knownVins,
        budgetUsd: input.deps.budgetUsd ?? null,
      });
      const enriched = enrichFindRelaxed(guarded.verdict, input.journal);
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
        droppedPicks: guarded.dropped,
        ...findLoopMeta(bundle, rejections),
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
    ...findLoopMeta(bundle, rejections),
  };
}

/**
 * Run the Find agentic SERV loop.
 * maxRounds is a runaway guard only — not a wall-clock timeout.
 * Pass `deadline` + prior `checkpoint` to step across Hobby 300s requests.
 */
export async function runFindAgentLoop(input: {
  note: string;
  mode?: FindAgentMode;
  formEdits?: Record<string, unknown> | null;
  deps: FindAgentLoopDeps;
  maxRounds?: number;
  /** Per-request wall budget. When nearly spent, returns continue + checkpoint. */
  deadline?: AgentLoopDeadline | null;
  /** Resume mid-loop state from a prior request. */
  checkpoint?: AgentLoopCheckpoint | null;
  /** When true, create a fresh deadline for this request (default). */
  budgetMs?: number;
}): Promise<FindAgentLoopResult> {
  const requestedMode = input.mode ?? resolveFindAgentMode(process.env);
  const maxRounds = input.maxRounds ?? 40;
  const fetchImpl = input.deps.fetch ?? fetch;
  const baseUrl = servApiBase(input.deps.servBaseUrl);
  const restored = restoreFindStateFromCheckpoint(input.checkpoint, input.deps.seedListings);
  const journal = restored.journal;
  const state = restored.state;
  // Provenance → constraintRoles: origin=user form keys are hard; SERV-chosen are relaxable.
  const { constraints: userFormConstraints } = constraintsFromFormEdits(
    input.note,
    input.formEdits,
  );
  state.userHardKeys = hardSearchKeysFromUserBag(userFormConstraints);
  const deadline =
    input.deadline === undefined
      ? makeAgentLoopDeadline(input.budgetMs)
      : input.deadline;
  const toolDeps: FindAgentToolDeps = {
    fetch: fetchImpl,
    autodevKey: input.deps.autodevKey,
    autodev: input.deps.autodev ?? {
      cache: new TtlCache<unknown>(),
      counter: new MemoryCounter(),
    },
    seedListings: input.deps.seedListings,
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
    formEdits: input.formEdits,
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

  // Resume sticks to the checkpoint phase when present.
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

  // auto: /v1/responses tools first. Fall back to schema-only chat only when the
  // Responses tools path is unsupported/empty — not on transient serv_http (keep
  // tools ownership; chat is a last resort without function tools).
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
    // Fresh message transcript for next_action; keep tool state + journal.
    resume: null,
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
