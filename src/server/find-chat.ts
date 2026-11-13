/**
 * Find chat intake — one SERV conversation (ask_shopper + search tools).
 * Chat turns without a delivered verdict do not charge report credits.
 */
import { findDeliveryChargesCredit } from "@/domain/find-delivery";
import { emptyNeed, type StructuredNeed } from "@/domain/need";
import { formatServChatTranscript, type ServChatMessage } from "@/domain/serv-chat";
import { chargeOutcomeFromAgentSettlement } from "@/domain/serv-boundary";
import { chatLimitViolation, type ShopperBrief } from "@/domain/shopper-brief";
import { makeAgentLoopDeadline } from "@/domain/agent-loop-deadline";
import { FIND_DECIDE_ROUTE_MS } from "@/domain/route-budget";
import { TtlCache } from "@/io/cache";
import { creditBalance, creditEventSeen, creditSpend } from "@/io/credit-book";
import type { Kv } from "@/io/kv";
import { MemoryCounter } from "@/io/quota";
import {
  runFindAgentLoop,
  searchesFromFindJournal,
  summarizeFindAgentJournal,
  type FindAgentLoopResult,
} from "@/server/find-agent/loop";
import { mapFindAgentLoopToDecide } from "@/server/find-agent/map-to-decide";
import {
  findSearchIdempotencyKey,
  findSearchSpendKey,
  storeFindSearchDelivery,
} from "@/server/find-search-credit";
import { listingsFromBestDeal, proofsFromRecords, syncRunSafely } from "@/server/run-sync";
import type { AgentLoopCheckpoint } from "@/server/serv/agent-loop-checkpoint";
import { formatShopperBriefCard } from "@/domain/shopper-brief";
import { sourceAttemptsFromEvidenceRows } from "@/domain/normalized-vehicle";
import { clipBuyerText } from "@/domain/normalized-vehicle";

export type FindChatSession = {
  sessionId: string;
  userId: string;
  messages: ServChatMessage[];
  checkpoint: AgentLoopCheckpoint | null;
  status: "open" | "awaiting_user" | "searching" | "done" | "failed";
  pendingQuestion: string | null;
  pendingBrief: ShopperBrief | null;
  /** Set once the shopper confirms the card; kept after pendingBrief is cleared. */
  confirmedBrief: ShopperBrief | null;
  spendKey: string;
  charged: boolean;
  result: Record<string, unknown> | null;
  error: string | null;
  updatedAt: string;
};

function sessionKey(sessionId: string): string {
  return `find:chat:v1:${sessionId}`;
}

export async function loadFindChatSession(kv: Kv, sessionId: string): Promise<FindChatSession | null> {
  const raw = await kv.get(sessionKey(sessionId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as FindChatSession;
    if (!parsed || typeof parsed !== "object" || typeof parsed.sessionId !== "string") return null;
    if (!("pendingBrief" in parsed)) (parsed as FindChatSession).pendingBrief = null;
    if (!("confirmedBrief" in parsed)) (parsed as FindChatSession).confirmedBrief = null;
    return parsed;
  } catch {
    return null;
  }
}

export async function storeFindChatSession(kv: Kv, session: FindChatSession): Promise<void> {
  await kv.set(sessionKey(session.sessionId), JSON.stringify(session));
}

function progressFromJournal(agent: FindAgentLoopResult): string[] {
  const lines: string[] = [];
  for (const entry of agent.journal) {
    if (entry.kind !== "tool") continue;
    if (entry.name === "ask_shopper" || entry.name === "record_shopper_facts") continue;
    if (entry.name.startsWith("_")) continue;
    const summary = typeof entry.summary === "string" ? entry.summary.trim() : "";
    if (summary) lines.push(summary);
  }
  return lines.slice(-6);
}

function needFromChat(
  transcript: string,
  facts: { budgetUsd: number | null; zip: string | null; radiusMi: number | null },
): StructuredNeed {
  const need = emptyNeed("personal");
  return {
    ...need,
    note: transcript,
    budgetUsd: facts.budgetUsd,
    budgetKnown: facts.budgetUsd != null,
    zip: facts.zip,
    distanceMiles: facts.radiusMi,
  };
}

export async function runFindChatTurn(input: {
  kv: Kv;
  userId: string;
  sessionId?: string | null;
  message?: string | null;
  continue?: boolean;
  /** Shopper confirmed the pending submit_brief card. */
  confirmBrief?: boolean;
  /** Eval/internal: do not charge report credits. */
  skipCredit?: boolean;
  servKey: string;
  autodevKey: string;
  servBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let session: FindChatSession | null =
    input.sessionId && input.sessionId.trim()
      ? await loadFindChatSession(input.kv, input.sessionId.trim())
      : null;

  if (session && session.userId !== input.userId) {
    return {
      ok: false,
      status: 403,
      body: { ok: false, error: "forbidden", message: "This chat belongs to another account." },
    };
  }

  const userText = typeof input.message === "string" ? input.message.trim() : "";
  const isContinue = input.continue === true;
  const confirmBrief = input.confirmBrief === true;

  const limit = chatLimitViolation({
    message: userText,
    messages: session?.messages ?? [],
    addingUserMessage: Boolean(userText) && !confirmBrief,
  });
  if (!limit.ok) {
    return {
      ok: false,
      status: 400,
      body: {
        ok: false,
        error: "chat_limit",
        message: limit.message,
        sessionId: session?.sessionId ?? null,
        messages: session?.messages ?? [],
        charged: false,
      },
    };
  }

  if (!session) {
    if (!userText) {
      return {
        ok: false,
        status: 400,
        body: {
          ok: false,
          error: "message_required",
          message: "Send a message to start chatting with SERV.",
        },
      };
    }
    const sessionId = crypto.randomUUID();
    const idem = findSearchIdempotencyKey({ clientKey: null });
    session = {
      sessionId,
      userId: input.userId,
      messages: [{ role: "user", content: userText, at: new Date().toISOString() }],
      checkpoint: null,
      status: "searching",
      pendingQuestion: null,
      pendingBrief: null,
      confirmedBrief: null,
      spendKey: findSearchSpendKey(input.userId, idem),
      charged: false,
      result: null,
      error: null,
      updatedAt: new Date().toISOString(),
    };
  } else if (session.status === "done" && session.result) {
    return {
      ok: true,
      status: 200,
      body: {
        ok: true,
        status: "done",
        sessionId: session.sessionId,
        messages: session.messages,
        result: session.result,
        charged: session.charged,
      },
    };
  } else if (confirmBrief) {
    if (!session.pendingBrief) {
      return {
        ok: false,
        status: 400,
        body: {
          ok: false,
          error: "brief_required",
          message: "There is no search brief to confirm. Wait for SERV to propose one.",
          sessionId: session.sessionId,
          messages: session.messages,
        },
      };
    }
    session.confirmedBrief = session.pendingBrief;
    session.messages.push({
      role: "user",
      content: "Confirmed — go ahead with this brief.",
      at: new Date().toISOString(),
    });
    session.pendingQuestion = null;
    session.status = "searching";
  } else if (userText) {
    session.messages.push({ role: "user", content: userText, at: new Date().toISOString() });
    session.pendingQuestion = null;
    session.pendingBrief = null;
    session.status = "searching";
  } else if (!isContinue && session.status === "awaiting_user") {
    return {
      ok: false,
      status: 400,
      body: {
        ok: false,
        error: "reply_required",
        message: session.pendingQuestion || "SERV is waiting for your reply.",
        sessionId: session.sessionId,
        messages: session.messages,
        status: session.pendingBrief ? "brief" : "ask",
        question: session.pendingQuestion,
        brief: session.pendingBrief,
      },
    };
  }

  const transcript = formatServChatTranscript(session.messages);
  const shopperReply =
    !confirmBrief && session.checkpoint?.pendingAskQuestion && userText ? userText : null;

  const agent = await runFindAgentLoop({
    note: transcript,
    formEdits: null,
    checkpoint: session.checkpoint,
    shopperReply,
    briefConfirmed: confirmBrief,
    requireBriefConfirm: true,
    budgetMs: FIND_DECIDE_ROUTE_MS,
    deadline: makeAgentLoopDeadline(FIND_DECIDE_ROUTE_MS),
    deps: {
      servKey: input.servKey,
      autodevKey: input.autodevKey,
      fetch: fetchImpl,
      servBaseUrl: input.servBaseUrl,
      autodev: { cache: new TtlCache<unknown>(), counter: new MemoryCounter() },
      budgetUsd: null,
      budgetProvenance: null,
    },
  });

  for (const line of progressFromJournal(agent)) {
    const last = session.messages[session.messages.length - 1];
    if (last?.role === "progress" && last.content === line) continue;
    session.messages.push({ role: "progress", content: line, at: new Date().toISOString() });
  }

  if ("awaitUser" in agent && agent.awaitUser) {
    session.checkpoint = agent.checkpoint;
    session.pendingQuestion = agent.question;
    session.pendingBrief = agent.awaitKind === "brief" ? (agent.brief ?? null) : null;
    session.status = "awaiting_user";
    session.messages.push({ role: "assistant", content: agent.question, at: new Date().toISOString() });
    session.updatedAt = new Date().toISOString();
    await storeFindChatSession(input.kv, session);
    return {
      ok: true,
      status: 200,
      body: {
        ok: true,
        status: agent.awaitKind === "brief" ? "brief" : "ask",
        sessionId: session.sessionId,
        messages: session.messages,
        question: agent.question,
        brief: session.pendingBrief,
        charged: false,
      },
    };
  }

  if ("continue" in agent && agent.continue) {
    session.checkpoint = agent.checkpoint;
    session.status = "searching";
    session.messages.push({
      role: "progress",
      content: agent.message || "Still searching — continuing…",
      at: new Date().toISOString(),
    });
    session.updatedAt = new Date().toISOString();
    await storeFindChatSession(input.kv, session);
    return {
      ok: true,
      status: 200,
      body: {
        ok: true,
        status: "continue",
        sessionId: session.sessionId,
        messages: session.messages,
        detail: agent.message,
        charged: false,
      },
    };
  }

  if (!agent.ok) {
    // Boundary / terminal failures never 502 — honest couldn't-finish after repairs.
    const honesty =
      agent.message?.trim() ||
      "We couldn't finish this search.";
    session.status = "done";
    session.error = honesty;
    session.checkpoint = null;
    session.messages.push({
      role: "assistant",
      content: honesty,
      at: new Date().toISOString(),
    });
    session.updatedAt = new Date().toISOString();
    const journalMeta = summarizeFindAgentJournal(agent.journal ?? []);
    const searchRows = searchesFromFindJournal(agent.journal ?? []);
    const carsFoundFromJournal =
      searchRows.length > 0 ? Math.max(...searchRows.map((row) => row.resultCount)) : 0;
    const rawFacts =
      "shopperFacts" in agent && agent.shopperFacts && typeof agent.shopperFacts === "object"
        ? (agent.shopperFacts as {
            budgetUsd?: number | null;
            zip?: string | null;
            radiusMi?: number | null;
          })
        : null;
    const facts = {
      budgetUsd: rawFacts?.budgetUsd ?? null,
      zip: rawFacts?.zip ?? null,
      radiusMi: rawFacts?.radiusMi ?? null,
    };
    const result: Record<string, unknown> = {
      ok: false,
      need: needFromChat(transcript, facts),
      bestDeal: null,
      pickAgentVerdict: null,
      offerPool: [],
      shortlistKeys: [],
      agentLoop: {
        agentMode: "agentMode" in agent ? agent.agentMode : null,
        toolRounds: "toolRounds" in agent ? agent.toolRounds : 0,
        verdictReached: false,
        relaxedConditions: [],
        journalServCalls: journalMeta.servCalls,
        journalToolCalls: journalMeta.toolCalls,
        servUsageTotal: journalMeta.servUsageTotal,
        carsFound: carsFoundFromJournal,
        passReason: null,
        featuresActive: journalMeta.featuresActive,
        featuresActivePerCall: journalMeta.featuresActivePerCall,
        featureRejections: journalMeta.featureRejections,
        servResponseIds: journalMeta.servResponseIds,
      },
      honesty,
      creditNote: "No report credit charged — incomplete chat stays free.",
      charged: false,
      transcript: session.messages,
      confirmedBrief: session.confirmedBrief,
      error: "error" in agent ? agent.error : "could_not_finish",
      message: honesty,
    };
    session.result = result;
    await storeFindChatSession(input.kv, session);
    return {
      ok: true,
      status: 200,
      body: {
        ok: true,
        status: "done",
        sessionId: session.sessionId,
        messages: session.messages,
        result,
        charged: false,
        message: honesty,
      },
    };
  }

  const mapped = mapFindAgentLoopToDecide({ agent });
  const need = needFromChat(transcript, agent.shopperFacts);
  const journalMeta = summarizeFindAgentJournal(agent.journal);
  const chosenVin = mapped.bestDeal.pick?.vin ?? null;
  const nothingFits = !chosenVin && Boolean(agent.verdict.passReason?.trim());
  const outcome = chargeOutcomeFromAgentSettlement({
    chosenVin,
    nothingFitsDocumented: nothingFits,
    settled: true,
  });
  const shouldCharge = findDeliveryChargesCredit({
    ok: true,
    providerQueriesUsed: journalMeta.toolCalls,
    listingCount: mapped.offerPool.length,
    outcome,
    chosenVin,
    nothingFitsDocumented: nothingFits,
    agentSettled: true,
  });

  let charged = session.charged;
  if (shouldCharge && !charged && !input.skipCredit) {
    if (await creditEventSeen(input.kv, session.spendKey)) charged = true;
    else charged = (await creditSpend(input.kv, input.userId, session.spendKey)).ok;
  }
  const balance = await creditBalance(input.kv, input.userId);

  const assistantSummary = clipBuyerText(
    agent.verdict.summary?.trim() ||
      (nothingFits
        ? agent.verdict.passReason || "Nothing in live inventory fit this request."
        : "Here are the cars SERV chose from live listings."),
    1200,
  );
  session.messages.push({ role: "assistant", content: assistantSummary, at: new Date().toISOString() });

  const briefCard = session.confirmedBrief ? formatShopperBriefCard(session.confirmedBrief) : "";
  const pickWhyByVin = new Map(
    agent.verdict.picks.map((p) => [p.vin.toUpperCase(), p.why] as const),
  );
  const listings = listingsFromBestDeal(
    {
      ...mapped.bestDeal,
      ranked: mapped.bestDeal.ranked.map((car) => ({
        ...car,
        excludedReason: car.vin ? pickWhyByVin.get(car.vin.toUpperCase()) ?? car.excludedReason : car.excludedReason,
      })),
    },
    mapped.agentVerdict.verdict,
    mapped.offerPool,
  ).map((row) => {
    const listing = mapped.offerPool.find((l) => l.vin?.toUpperCase() === row.vin.toUpperCase());
    const evidenceRows = mapped.sourcesCheckedByVin[row.vin.toUpperCase()] ?? [];
    return {
      ...row,
      distanceMiles: listing?.distanceMiles ?? row.distanceMiles ?? null,
      bodyStyle: listing?.bodyStyle ?? row.bodyStyle ?? null,
      drivetrain: listing?.drivetrain ?? row.drivetrain ?? null,
      reason: pickWhyByVin.get(row.vin.toUpperCase()) ?? row.reason ?? null,
      dealerUrl: listing?.dealerUrl ?? null,
      sourcesChecked: sourceAttemptsFromEvidenceRows(evidenceRows),
    };
  });
  const runId = await syncRunSafely(input.kv, {
    ownerId: input.userId,
    kind: "find",
    note: briefCard || transcript,
    clarifications: session.confirmedBrief
      ? [
          session.confirmedBrief.budget.maxUsd != null
            ? `Budget $${session.confirmedBrief.budget.maxUsd.toLocaleString("en-US")}${
                session.confirmedBrief.budget.userQuote
                  ? ` (“${session.confirmedBrief.budget.userQuote}”)`
                  : ""
              }`
            : null,
          session.confirmedBrief.zip
            ? `Location ${session.confirmedBrief.zip}${
                session.confirmedBrief.radiusMi != null
                  ? ` · ${session.confirmedBrief.radiusMi} mi`
                  : ""
              }`
            : null,
          ...(session.confirmedBrief.hardConstraints ?? []).map((c) => `Hard ${c.key}=${c.value}`),
          ...(session.confirmedBrief.softConstraints ?? []).map((c) => `Soft ${c.key}=${c.value}`),
          ...(session.confirmedBrief.agreedRelaxations ?? []).map(
            (c) => `Agreed ${c.key}=${c.value}`,
          ),
        ].filter((line): line is string => Boolean(line))
      : [],
    listings,
    picks: chosenVin ? [chosenVin] : [],
    // Generic SourceId kept for legacy run store; per-VIN checklist is on each listing.
    sources: journalMeta.toolCalls > 0 ? ["cars_for_sale"] : [],
    queryCount: journalMeta.toolCalls,
    verdict: mapped.agentVerdict.verdict,
    confidence: mapped.agentVerdict.confidence,
    buyerMessage: assistantSummary,
    creditsCharged: charged ? 1 : 0,
    spendKey: session.spendKey,
    proofs: proofsFromRecords(
      mapped.agentVerdict.serv_steps?.map((step) => ({
        purpose: "find_chat",
        status: "ok",
        responseId: step.responseId,
        model: step.model,
        detail: step.why,
      })) ?? [],
    ),
    terminal: true,
  });

  const result: Record<string, unknown> = {
    ok: true,
    need,
    bestDeal: mapped.bestDeal,
    pickAgentVerdict: mapped.agentVerdict,
    offerPool: mapped.offerPool,
    shortlistKeys: mapped.shortlistKeys,
    sourcesCheckedByVin: mapped.sourcesCheckedByVin,
    agentLoop: {
      agentMode: agent.agentMode,
      toolRounds: agent.toolRounds,
      verdictReached: true,
      relaxedConditions: agent.relaxedConditions,
      journalServCalls: journalMeta.servCalls,
      journalToolCalls: journalMeta.toolCalls,
      servUsageTotal: journalMeta.servUsageTotal,
      carsFound: mapped.offerPool.length,
      passReason: agent.verdict.passReason,
      featuresActive: journalMeta.featuresActive,
      featuresActivePerCall: journalMeta.featuresActivePerCall,
      featureRejections: journalMeta.featureRejections,
      servResponseIds: journalMeta.servResponseIds,
    },
    honesty: nothingFits
      ? "SERV searched live inventory and explained why nothing fit."
      : "SERV searched live inventory and chose from returned listings.",
    creditNote: charged
      ? "1 report credit used for this delivered Find verdict."
      : "No report credit charged — chat turns without a delivered verdict stay free.",
    charged,
    balance,
    transcript: session.messages,
    confirmedBrief: session.confirmedBrief,
    runId,
  };

  session.result = result;
  session.charged = charged;
  session.status = "done";
  session.checkpoint = null;
  session.pendingQuestion = null;
  session.updatedAt = new Date().toISOString();
  await storeFindChatSession(input.kv, session);
  await storeFindSearchDelivery(input.kv, session.spendKey, result);

  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      status: "done",
      sessionId: session.sessionId,
      messages: session.messages,
      result,
      charged,
      balance,
    },
  };
}
