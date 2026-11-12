/**
 * One HTTP eval-live hop = one Find/Resale chat turn (same as the real site).
 * Chat session is persisted on the batch between requests.
 */
import type { Kv } from "@/io/kv";
import { runFindChatTurn } from "@/server/find-chat";
import { runResaleChatTurn } from "@/server/resale-chat";
import {
  LIVE_EVAL_CHAT_MAX_HOPS,
  planNextEvalChatTurn,
  type ChatTurnFn,
} from "./drive-chat";
import { ESTIMATED_USD_PER_QUERY } from "./spend";
import { settleFindChatCaseResult, settleResaleChatCaseResult } from "./settle-chat-result";
import type { GeneratedQuery, LiveEvalCaseResult } from "./types";

export type EvalLiveActiveChat = {
  queryIndex: number;
  sessionId: string | null;
  /** Prior turn status; null means the first message has not been sent yet. */
  lastStatus: string | null;
  asked: boolean;
  briefConfirmed: boolean;
  hops: number;
  startedAtMs: number;
};

export type EvalChatHopDeps = {
  kv: Kv;
  userId: string;
  servKey: string;
  autodevKey: string;
  servBaseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Test seam: inject one-turn chat fn instead of Find/Resale servers. */
  turn?: ChatTurnFn;
};

export type EvalChatHopOutcome =
  | {
      kind: "in_progress";
      active: EvalLiveActiveChat;
      turnStatus: string;
      turnOk: boolean;
      httpStatus: number;
      body: Record<string, unknown>;
    }
  | {
      kind: "query_done";
      result: LiveEvalCaseResult;
      turnStatus: string;
      turnOk: boolean;
      httpStatus: number;
      body: Record<string, unknown>;
      asked: boolean;
      briefConfirmed: boolean;
      hops: number;
    };

function chatTurnForProduct(product: GeneratedQuery["product"], deps: EvalChatHopDeps): ChatTurnFn {
  if (deps.turn) return deps.turn;
  if (product === "resale") {
    return (turn) =>
      runResaleChatTurn({
        kv: deps.kv,
        userId: deps.userId,
        sessionId: turn.sessionId,
        message: turn.message,
        continue: turn.continue,
        confirmBrief: turn.confirmBrief,
        skipCredit: true,
        servKey: deps.servKey,
        autodevKey: deps.autodevKey,
        servBaseUrl: deps.servBaseUrl,
        fetchImpl: deps.fetchImpl,
      });
  }
  return (turn) =>
    runFindChatTurn({
      kv: deps.kv,
      userId: deps.userId,
      sessionId: turn.sessionId,
      message: turn.message,
      continue: turn.continue,
      confirmBrief: turn.confirmBrief,
      skipCredit: true,
      servKey: deps.servKey,
      autodevKey: deps.autodevKey,
      servBaseUrl: deps.servBaseUrl,
      fetchImpl: deps.fetchImpl,
    });
}

export function beginEvalActiveChat(queryIndex: number, nowMs = Date.now()): EvalLiveActiveChat {
  return {
    queryIndex,
    sessionId: null,
    lastStatus: null,
    asked: false,
    briefConfirmed: false,
    hops: 0,
    startedAtMs: nowMs,
  };
}

export async function runEvalChatHop(input: {
  query: GeneratedQuery;
  active: EvalLiveActiveChat;
  deps: EvalChatHopDeps;
  maxHops?: number;
}): Promise<EvalChatHopOutcome> {
  const maxHops = input.maxHops ?? LIVE_EVAL_CHAT_MAX_HOPS;
  const active = { ...input.active };

  if (active.hops >= maxHops) {
    const elapsedMs = Date.now() - active.startedAtMs;
    const settle =
      input.query.product === "resale" ? settleResaleChatCaseResult : settleFindChatCaseResult;
    return {
      kind: "query_done",
      result: settle({
        query: input.query,
        drivenOk: false,
        body: {
          error: "chat_hop_limit",
          message: "Chat eval hit the hop limit before a verdict.",
          sessionId: active.sessionId,
        },
        elapsedMs,
      }),
      turnStatus: "error",
      turnOk: false,
      httpStatus: 504,
      body: {
        ok: false,
        error: "chat_hop_limit",
        message: "Chat eval hit the hop limit before a verdict.",
        sessionId: active.sessionId,
      },
      asked: active.asked,
      briefConfirmed: active.briefConfirmed,
      hops: active.hops,
    };
  }

  const plan = planNextEvalChatTurn({
    firstMessage: input.query.note,
    lastStatus: active.lastStatus,
    sessionId: active.sessionId,
  });

  if (plan.kind === "done") {
    const elapsedMs = Date.now() - active.startedAtMs;
    const settle =
      input.query.product === "resale" ? settleResaleChatCaseResult : settleFindChatCaseResult;
    return {
      kind: "query_done",
      result: settle({
        query: input.query,
        drivenOk: false,
        body: {
          error: "chat_already_done",
          message: "Chat hop planner reported done without a settled result.",
          sessionId: active.sessionId,
        },
        elapsedMs,
      }),
      turnStatus: "error",
      turnOk: false,
      httpStatus: 500,
      body: {
        ok: false,
        error: "chat_already_done",
        sessionId: active.sessionId,
      },
      asked: active.asked,
      briefConfirmed: active.briefConfirmed,
      hops: active.hops,
    };
  }

  if (plan.kind === "stop") {
    const elapsedMs = Date.now() - active.startedAtMs;
    const settle =
      input.query.product === "resale" ? settleResaleChatCaseResult : settleFindChatCaseResult;
    return {
      kind: "query_done",
      result: settle({
        query: input.query,
        drivenOk: false,
        body: {
          error: plan.reason,
          message: "Chat eval stopped before a verdict.",
          sessionId: active.sessionId,
        },
        elapsedMs,
      }),
      turnStatus: "error",
      turnOk: false,
      httpStatus: 400,
      body: {
        ok: false,
        error: plan.reason,
        message: "Chat eval stopped before a verdict.",
        sessionId: active.sessionId,
      },
      asked: active.asked,
      briefConfirmed: active.briefConfirmed,
      hops: active.hops,
    };
  }

  if (plan.asked) active.asked = true;
  if (plan.briefConfirmed) active.briefConfirmed = true;

  const turn = chatTurnForProduct(input.query.product, input.deps);
  const response = await turn(plan.input);
  active.hops += 1;
  if (typeof response.body.sessionId === "string") {
    active.sessionId = response.body.sessionId;
  }
  const turnStatus = typeof response.body.status === "string" ? response.body.status : "";
  active.lastStatus = turnStatus || null;

  if (turnStatus === "done") {
    const elapsedMs = Date.now() - active.startedAtMs;
    const settle =
      input.query.product === "resale" ? settleResaleChatCaseResult : settleFindChatCaseResult;
    return {
      kind: "query_done",
      result: settle({
        query: input.query,
        drivenOk: response.ok,
        body: response.body,
        elapsedMs,
      }),
      turnStatus,
      turnOk: response.ok,
      httpStatus: response.status,
      body: response.body,
      asked: active.asked,
      briefConfirmed: active.briefConfirmed,
      hops: active.hops,
    };
  }

  if (
    turnStatus === "ask" ||
    turnStatus === "brief" ||
    turnStatus === "continue" ||
    turnStatus === "searching" ||
    turnStatus === "progress"
  ) {
    return {
      kind: "in_progress",
      active,
      turnStatus,
      turnOk: response.ok,
      httpStatus: response.status,
      body: response.body,
    };
  }

  const elapsedMs = Date.now() - active.startedAtMs;
  const settle =
    input.query.product === "resale" ? settleResaleChatCaseResult : settleFindChatCaseResult;
  return {
    kind: "query_done",
    result: settle({
      query: input.query,
      drivenOk: false,
      body: response.body,
      elapsedMs,
    }),
    turnStatus: turnStatus || "error",
    turnOk: false,
    httpStatus: response.status,
    body: response.body,
    asked: active.asked,
    briefConfirmed: active.briefConfirmed,
    hops: active.hops,
  };
}

/** Cheap guard for reports that still estimate spend per completed query. */
export function estimatedUsdForCompletedQueries(count: number): number {
  return count * ESTIMATED_USD_PER_QUERY;
}
