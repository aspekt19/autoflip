/**
 * Resale chat intake — one SERV conversation (ask_shopper + search tools).
 * Briefing turns stay free. Confirming the brief reserves 1 credit BEFORE search SERV;
 * commit on a chosen flip; release on nothing-fits / error.
 */
import { formatServChatTranscript, type ServChatMessage } from "@/domain/serv-chat";
import {
  chatLimitViolation,
  formatShopperBriefCard,
  type ShopperBrief,
} from "@/domain/shopper-brief";
import { makeAgentLoopDeadline } from "@/domain/agent-loop-deadline";
import { RESALE_INTERNAL_BUDGET_MS } from "@/domain/resale-deadline";
import type { ResaleSearchInput } from "@/domain/resale-search-input";
import { TtlCache } from "@/io/cache";
import { creditBalance } from "@/io/credit-book";
import type { Kv } from "@/io/kv";
import { MemoryCounter } from "@/io/quota";
import { runResaleAgentLoop, summarizeResaleAgentJournal } from "@/server/resale-agent/loop";
import { mapResaleAgentLoopToSettle } from "@/server/resale-agent/map-to-settle";
import {
  findSearchIdempotencyKey,
  resaleSearchSpendKey,
  storeResaleSearchDelivery,
} from "@/server/resale-search-credit";
import {
  commitSearchCreditOnDelivery,
  creditsRequiredBody,
  releaseSearchCredit,
  reserveSearchCreditBeforeServ,
  reserveTrialSearchQuota,
  searchReservationFailureBody,
  searchReservationFailureStatus,
} from "@/server/search-billing-gate";
import { syncResaleRun } from "@/server/run-sync";
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
  idempotencyKey: string;
  reserved: boolean;
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
    parsed.reserved = parsed.reserved ?? false;
    parsed.idempotencyKey = parsed.idempotencyKey ?? parsed.sessionId;
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
    if (!input.skipCredit) {
      const bal = await creditBalance(input.kv, input.userId);
      if (bal < 1) {
        return {
          ok: false,
          status: 403,
          body: creditsRequiredBody({ balance: bal, surface: "resale" }),
        };
      }
    }
    const idem = findSearchIdempotencyKey({ clientKey: null });
    if (!input.skipCredit) {
      const quota = await reserveTrialSearchQuota(input.kv, input.userId, `resale:${idem}`);
      if (!quota.ok) {
        const reason = quota.reason === "limit" ? "trial_limit" : "quota_unavailable";
        return {
          ok: false,
          status: searchReservationFailureStatus(reason),
          body: searchReservationFailureBody({
            balance: await creditBalance(input.kv, input.userId),
            surface: "resale",
            reason,
          }),
        };
      }
    }
    session = {
      sessionId: crypto.randomUUID(),
      userId: input.userId,
      messages: [{ role: "user", content: userText, at: new Date().toISOString() }],
      checkpoint: null,
      status: "searching",
      pendingQuestion: null,
      pendingBrief: null,
      confirmedBrief: null,
      idempotencyKey: idem,
      spendKey: resaleSearchSpendKey(input.userId, idem),
      reserved: false,
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
    if (!input.skipCredit && !session.reserved && !session.charged) {
      const reserved = await reserveSearchCreditBeforeServ(
        input.kv,
        "resale",
        input.userId,
        session.idempotencyKey,
      );
      if (!reserved.ok) {
        return {
          ok: false,
          status: searchReservationFailureStatus(reserved.reason),
          body: {
            ...searchReservationFailureBody({
              balance: reserved.balance,
              surface: "resale",
              reason: reserved.reason,
            }),
            sessionId: session.sessionId,
            messages: session.messages,
          },
        };
      }
      session.reserved = true;
      session.spendKey = reserved.spendKey;
    }
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
    if (session.reserved && !session.charged && !input.skipCredit) {
      await releaseSearchCredit(input.kv, input.userId, session.spendKey);
      session.reserved = false;
    }
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
      creditNote: "No report credit charged — incomplete search released the reservation.",
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
        featuresActive: journalMeta.featuresActive,
        featuresActivePerCall: journalMeta.featuresActivePerCall,
        featureRejections: journalMeta.featureRejections,
        servResponseIds: journalMeta.servResponseIds,
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
  // Chosen flip must be non-pass — pass-only rows are rejects / nothing-fits, not a buy.
  const actionablePick =
    agent.verdict.picks.find((p) => p.action !== "pass") ?? null;
  const bestVin = actionablePick?.vin?.toUpperCase() ?? null;
  const best = bestVin ? agent.pnlByVin.get(bestVin) ?? null : null;
  // Commit only a chosen flip — nothing-fits releases.
  const shouldCharge = Boolean(best);
  let charged = session.charged;
  let balance = await creditBalance(input.kv, input.userId);
  if (!input.skipCredit && session.reserved) {
    if (shouldCharge && !charged) {
      const committed = await commitSearchCreditOnDelivery(input.kv, input.userId, session.spendKey);
      charged = committed.committed;
      balance = committed.balance;
    } else if (!shouldCharge) {
      balance = (await releaseSearchCredit(input.kv, input.userId, session.spendKey)).balance;
      session.reserved = false;
      charged = false;
    }
  }
  const summary = agent.verdict.summary?.trim() || "Resale search finished.";
  session.messages.push({ role: "assistant", content: summary, at: new Date().toISOString() });
  const journalMeta = summarizeResaleAgentJournal(agent.journal);
  const passReason = agent.verdict.picks.length === 0 ? agent.verdict.summary : null;
  const brief = session.confirmedBrief;
  const searchInput: ResaleSearchInput = {
    budgetUsd: brief?.budget.maxUsd ?? 1,
    zip: brief?.zip ?? null,
    distanceMiles: brief?.radiusMi ?? null,
    bodyStyle: null,
    preferredMakes: [],
    preferredModels: [],
    yearMin: null,
    yearMax: null,
    milesMax: null,
    repairAbility: "unknown",
    targetProfitUsd: null,
    asIs: false,
    sellWithinDays: null,
    timeToSell: "any",
    resaleChannel: "private_party",
    freeText: formatServChatTranscript(session.messages),
  };
  // Build journal steps so the result view / /run record are not empty.
  const settled = mapResaleAgentLoopToSettle({
    agent,
    searchInput,
  });
  const runId = await syncResaleRun(input.kv, {
    ownerId: input.userId,
    note: brief ? formatShopperBriefCard(brief) : searchInput.freeText || "",
    search: {
      budgetUsd: searchInput.budgetUsd,
      zip: searchInput.zip,
      distanceMiles: searchInput.distanceMiles,
      yearMin: null,
      yearMax: null,
      milesMax: null,
      sellWithinDays: null,
    },
    client: {
      ...settled.delivery,
      best: best ?? settled.delivery.best ?? null,
      alternatives: alternatives.filter((row) => row.vin !== best?.vin).slice(0, 8),
      chargedCredit: charged,
      done: true,
      message: summary,
      providerQueriesUsed: journalMeta.toolCalls,
    },
  });
  const result = {
    ok: true,
    best,
    alternatives: alternatives.filter((row) => row.vin !== best?.vin).slice(0, 8),
    agentVerdict: settled.delivery.agentVerdict ?? null,
    journal: settled.delivery.journal ?? null,
    sourcesCheckedByVin: settled.delivery.sourcesCheckedByVin ?? {},
    message: summary,
    charged,
    balance,
    creditNote: charged
      ? "1 report credit used for this delivered Resale verdict."
      : best
        ? "No report credit charged — reservation could not be committed."
        : "No report credit charged — nothing fit; the reserved credit was released.",
    transcript: session.messages,
    journalMeta,
    passReason,
    confirmedBrief: session.confirmedBrief,
    runId,
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
      featuresActive: journalMeta.featuresActive,
      featuresActivePerCall: journalMeta.featuresActivePerCall,
      featureRejections: journalMeta.featureRejections,
      servResponseIds: journalMeta.servResponseIds,
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
