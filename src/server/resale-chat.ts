/**
 * Resale chat intake — one SERV conversation (ask_shopper + search tools).
 * Credit only when a verdict is delivered.
 */
import { formatServChatTranscript, type ServChatMessage } from "@/domain/serv-chat";
import { chatLimitViolation, type ShopperBrief } from "@/domain/shopper-brief";
import { makeAgentLoopDeadline } from "@/domain/agent-loop-deadline";
import { RESALE_INTERNAL_BUDGET_MS } from "@/domain/resale-deadline";
import { TtlCache } from "@/io/cache";
import { creditBalance, creditEventSeen, creditSpend } from "@/io/credit-book";
import type { Kv } from "@/io/kv";
import { MemoryCounter } from "@/io/quota";
import { runResaleAgentLoop, summarizeResaleAgentJournal } from "@/server/resale-agent/loop";
import {
  findSearchIdempotencyKey,
  resaleSearchSpendKey,
  storeResaleSearchDelivery,
} from "@/server/resale-search-credit";
import type { AgentLoopCheckpoint } from "@/server/serv/agent-loop-checkpoint";

type Session = {
  sessionId: string;
  userId: string;
  messages: ServChatMessage[];
  checkpoint: AgentLoopCheckpoint | null;
  status: "open" | "awaiting_user" | "searching" | "done" | "failed";
  pendingQuestion: string | null;
  pendingBrief: ShopperBrief | null;
  confirmedBrief: ShopperBrief | null;
  spendKey: string;
  charged: boolean;
  result: Record<string, unknown> | null;
  updatedAt: string;
};

const key = (id: string) => `resale:chat:v1:${id}`;

async function load(kv: Kv, id: string): Promise<Session | null> {
  const raw = await kv.get(key(id));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Session;
    parsed.confirmedBrief = parsed.confirmedBrief ?? null;
    parsed.pendingBrief = parsed.pendingBrief ?? null;
    return parsed;
  } catch {
    return null;
  }
}

async function save(kv: Kv, s: Session) {
  await kv.set(key(s.sessionId), JSON.stringify(s));
}

export async function runResaleChatTurn(input: {
  kv: Kv;
  userId: string;
  sessionId?: string | null;
  message?: string | null;
  continue?: boolean;
  confirmBrief?: boolean;
  skipCredit?: boolean;
  servKey: string;
  autodevKey: string;
  servBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let session = input.sessionId?.trim() ? await load(input.kv, input.sessionId.trim()) : null;
  if (session && session.userId !== input.userId) {
    return { ok: false, status: 403, body: { ok: false, error: "forbidden", message: "Wrong account." } };
  }
  const userText = typeof input.message === "string" ? input.message.trim() : "";
  const isContinue = input.continue === true;
  const confirmBrief = input.confirmBrief === true;

  if (!session) {
    if (!userText) {
      return { ok: false, status: 400, body: { ok: false, error: "message_required", message: "Send a message." } };
    }
    const idem = findSearchIdempotencyKey({ clientKey: null });
    session = {
      sessionId: crypto.randomUUID(),
      userId: input.userId,
      messages: [{ role: "user", content: userText, at: new Date().toISOString() }],
      checkpoint: null,
      status: "searching",
      pendingQuestion: null,
      pendingBrief: null,
      confirmedBrief: null,
      spendKey: resaleSearchSpendKey(input.userId, idem),
      charged: false,
      result: null,
      updatedAt: new Date().toISOString(),
    };
  } else if (session.status === "done" && session.result) {
    return {
      ok: true,
      status: 200,
      body: { ok: true, status: "done", sessionId: session.sessionId, messages: session.messages, result: session.result, charged: session.charged },
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
    session.status = "searching";
    session.pendingQuestion = null;
  } else if (userText) {
    session.messages.push({ role: "user", content: userText, at: new Date().toISOString() });
    session.status = "searching";
    session.pendingQuestion = null;
    session.pendingBrief = null;
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

  const limit = chatLimitViolation({
    message: userText,
    messages: session.messages,
    // Message already appended above when present — do not double-count.
    addingUserMessage: false,
  });
  if (!limit.ok) {
    return {
      ok: false,
      status: 400,
      body: {
        ok: false,
        error: "chat_limit",
        message: limit.message,
        sessionId: session.sessionId,
        messages: session.messages,
        charged: false,
      },
    };
  }

  const transcript = formatServChatTranscript(session.messages);
  const shopperReply = !confirmBrief && session.checkpoint?.pendingAskQuestion && userText ? userText : null;
  const agent = await runResaleAgentLoop({
    note: transcript,
    shopperContext: null,
    checkpoint: session.checkpoint,
    shopperReply,
    briefConfirmed: confirmBrief,
    requireBriefConfirm: true,
    budgetMs: RESALE_INTERNAL_BUDGET_MS,
    deadline: makeAgentLoopDeadline(RESALE_INTERNAL_BUDGET_MS),
    deps: {
      servKey: input.servKey,
      autodevKey: input.autodevKey,
      fetch: fetchImpl,
      servBaseUrl: input.servBaseUrl,
      autodev: { cache: new TtlCache<unknown>(), counter: new MemoryCounter() },
      budgetUsd: session.checkpoint?.shopperFacts?.budgetUsd ?? null,
    },
  });

  if ("awaitUser" in agent && agent.awaitUser) {
    const a = agent;
    session.checkpoint = a.checkpoint;
    session.pendingQuestion = a.question;
    session.pendingBrief = a.awaitKind === "brief" ? (a.brief ?? null) : null;
    session.status = "awaiting_user";
    session.messages.push({ role: "assistant", content: a.question, at: new Date().toISOString() });
    await save(input.kv, session);
    return {
      ok: true,
      status: 200,
      body: {
        ok: true,
        status: a.awaitKind === "brief" ? "brief" : "ask",
        sessionId: session.sessionId,
        messages: session.messages,
        question: a.question,
        brief: session.pendingBrief,
        charged: false,
      },
    };
  }
  if ("continue" in agent && agent.continue) {
    session.checkpoint = agent.checkpoint;
    session.status = "searching";
    session.messages.push({ role: "progress", content: agent.message || "Still searching…", at: new Date().toISOString() });
    await save(input.kv, session);
    return {
      ok: true,
      status: 200,
      body: { ok: true, status: "continue", sessionId: session.sessionId, messages: session.messages, detail: agent.message, charged: false },
    };
  }
  if (!agent.ok) {
    // Boundary / terminal failures never 502 — honest couldn't-finish after repairs.
    const honesty = agent.message?.trim() || "We couldn't finish this flip search.";
    session.status = "done";
    session.messages.push({ role: "assistant", content: honesty, at: new Date().toISOString() });
    const journalMeta = summarizeResaleAgentJournal(agent.journal ?? []);
    const result = {
      ok: false,
      best: null,
      alternatives: [],
      agentVerdict: null,
      message: honesty,
      charged: false,
      creditNote: "No report credit charged — incomplete chat stays free.",
      transcript: session.messages,
      journalMeta,
      passReason: null,
      confirmedBrief: session.confirmedBrief,
      agentLoop: {
        agentMode: "agentMode" in agent ? agent.agentMode : null,
        toolRounds: "toolRounds" in agent ? agent.toolRounds : 0,
        verdictReached: false,
        relaxedConditions: [],
        journalServCalls: journalMeta.servCalls,
        journalToolCalls: journalMeta.toolCalls,
        servUsageTotal: journalMeta.servUsageTotal,
        carsFound: "knownVins" in agent ? agent.knownVins.length : 0,
        passReason: null,
      },
      error: "error" in agent ? agent.error : "could_not_finish",
    };
    session.result = result;
    session.checkpoint = null;
    await save(input.kv, session);
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

  const alternatives = [...agent.pnlByVin.values()];
  const bestVin = agent.verdict.picks[0]?.vin?.toUpperCase() ?? null;
  const best = bestVin ? agent.pnlByVin.get(bestVin) ?? alternatives[0] ?? null : null;
  const shouldCharge = Boolean(best) || (agent.verdict.picks.length === 0 && Boolean(agent.verdict.summary?.trim()));
  let charged = session.charged;
  if (shouldCharge && !charged && !input.skipCredit) {
    if (await creditEventSeen(input.kv, session.spendKey)) charged = true;
    else charged = (await creditSpend(input.kv, input.userId, session.spendKey)).ok;
  }
  const balance = await creditBalance(input.kv, input.userId);
  const summary = agent.verdict.summary?.trim() || "Resale search finished.";
  session.messages.push({ role: "assistant", content: summary, at: new Date().toISOString() });
  const journalMeta = summarizeResaleAgentJournal(agent.journal);
  const passReason = agent.verdict.picks.length === 0 ? agent.verdict.summary : null;
  const result = {
    ok: true,
    best,
    alternatives: alternatives.filter((row) => row.vin !== best?.vin).slice(0, 8),
    agentVerdict: null,
    message: summary,
    charged,
    balance,
    creditNote: charged
      ? "1 report credit used for this delivered Resale verdict."
      : "No report credit charged — chat turns without a delivered verdict stay free.",
    transcript: session.messages,
    journalMeta,
    passReason,
    confirmedBrief: session.confirmedBrief,
    agentLoop: {
      agentMode: agent.agentMode,
      toolRounds: agent.toolRounds,
      verdictReached: true,
      relaxedConditions: agent.relaxedConditions,
      journalServCalls: journalMeta.servCalls,
      journalToolCalls: journalMeta.toolCalls,
      servUsageTotal: journalMeta.servUsageTotal,
      carsFound: agent.knownVins.length,
      passReason,
    },
  };
  session.result = result;
  session.charged = charged;
  session.status = "done";
  session.checkpoint = null;
  await save(input.kv, session);
  await storeResaleSearchDelivery(input.kv, session.spendKey, result);
  return {
    ok: true,
    status: 200,
    body: { ok: true, status: "done", sessionId: session.sessionId, messages: session.messages, result, charged, balance },
  };
}
