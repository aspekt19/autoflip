/**
 * Drive Find/Resale SERV chat for live eval:
 * user message → answer questions → confirm brief → continue until verdict.
 * Replies come from the query note/persona (budget, zip, use); otherwise
 * "no preference". Code does not invent shopper facts beyond the query.
 *
 * HTTP eval-live uses planNextEvalChatTurn for one hop per request.
 * Local CLI may still loop hops in-process via driveServChatEval.
 */
import { LIVE_EVAL_GENERIC_SHOPPER_REPLY } from "@/domain/serv-chat";
import type { GeneratedQuery } from "./types";

export const LIVE_EVAL_CHAT_MAX_HOPS = 40;

export type ChatTurnFn = (input: {
  sessionId?: string | null;
  message?: string | null;
  continue?: boolean;
  confirmBrief?: boolean;
}) => Promise<{ ok: boolean; status: number; body: Record<string, unknown> }>;

export type DriveServChatResult = {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
  hops: number;
  asked: boolean;
  briefConfirmed: boolean;
};

export type EvalChatTurnPlan =
  | { kind: "turn"; input: Parameters<ChatTurnFn>[0]; asked?: boolean; briefConfirmed?: boolean }
  | { kind: "done" }
  | { kind: "stop"; reason: string };

const USE_LABEL: Record<string, string> = {
  cargo: "weekend cargo / gear space",
  commute: "daily commuting",
  truck_flip: "flipping trucks or SUVs that turn faster",
  family: "family use",
  road_trip: "road trips",
};

/**
 * Build a shopper reply from the generated query note/persona.
 * Answers budget, zip, and use when present; otherwise "no preference".
 */
export function evalShopperReplyFromQuery(
  query: Pick<GeneratedQuery, "note" | "zip" | "tags"> | null | undefined,
): string {
  if (!query) return LIVE_EVAL_GENERIC_SHOPPER_REPLY;
  const parts: string[] = [];
  const budgetTag = query.tags?.budget?.trim();
  if (budgetTag) {
    const k = /^(\d+)\s*k$/i.exec(budgetTag);
    const dollars = k ? `$${Number(k[1]) * 1000}` : /^\d+$/.test(budgetTag) ? `$${budgetTag}` : budgetTag;
    parts.push(`Budget is about ${dollars}.`);
  } else {
    const budgetFromNote = /\$\s*[\d,]+|\bunder\s+[\d,]+\b|\bup to\s+(?:forty|fifteen|eight|twelve)\b/i.exec(
      query.note,
    );
    if (budgetFromNote) parts.push(`Budget as in my note (${budgetFromNote[0]}).`);
    else parts.push("No budget preference beyond what I already wrote.");
  }
  if (query.zip?.trim()) {
    parts.push(`ZIP ${query.zip.trim()} is fine.`);
  } else {
    parts.push("No ZIP preference — nationwide is fine.");
  }
  const need = query.tags?.need?.trim();
  if (need && USE_LABEL[need]) {
    parts.push(`Use: ${USE_LABEL[need]}.`);
  } else if (need) {
    parts.push(`Use: ${need.replace(/_/g, " ")}.`);
  } else {
    parts.push("No other use preference.");
  }
  parts.push("No other preferences — go ahead with what you have. Please submit the brief card when ready.");
  return parts.join(" ");
}

/**
 * Decide the next single chat turn from the prior response status.
 * Mirrors the real site: one HTTP request per ask / reply / confirm / continue.
 */
export function planNextEvalChatTurn(input: {
  firstMessage: string;
  lastStatus: string | null;
  sessionId: string | null;
  genericReply?: string;
}): EvalChatTurnPlan {
  const reply = input.genericReply ?? LIVE_EVAL_GENERIC_SHOPPER_REPLY;
  const status = input.lastStatus ?? "";

  if (!status) {
    return { kind: "turn", input: { message: input.firstMessage } };
  }
  if (status === "done") {
    return { kind: "done" };
  }
  if (status === "ask") {
    if (!input.sessionId) return { kind: "stop", reason: "missing_session" };
    return { kind: "turn", input: { sessionId: input.sessionId, message: reply }, asked: true };
  }
  if (status === "brief") {
    if (!input.sessionId) return { kind: "stop", reason: "missing_session" };
    return {
      kind: "turn",
      input: { sessionId: input.sessionId, confirmBrief: true },
      briefConfirmed: true,
    };
  }
  if (status === "continue" || status === "searching" || status === "progress") {
    if (!input.sessionId) return { kind: "stop", reason: "missing_session" };
    return { kind: "turn", input: { sessionId: input.sessionId, continue: true } };
  }
  return { kind: "stop", reason: `unexpected_status:${status || "empty"}` };
}

export async function driveServChatEval(input: {
  firstMessage: string;
  turn: ChatTurnFn;
  genericReply?: string;
  maxHops?: number;
}): Promise<DriveServChatResult> {
  const maxHops = input.maxHops ?? LIVE_EVAL_CHAT_MAX_HOPS;

  let asked = false;
  let briefConfirmed = false;
  let lastStatus: string | null = null;
  let sessionId: string | null = null;
  let result: { ok: boolean; status: number; body: Record<string, unknown> } | null = null;

  for (let hop = 0; hop < maxHops; hop += 1) {
    const plan = planNextEvalChatTurn({
      firstMessage: input.firstMessage,
      lastStatus,
      sessionId,
      genericReply: input.genericReply,
    });
    if (plan.kind === "done") {
      return {
        ok: result?.ok ?? false,
        status: result?.status ?? 500,
        body: result?.body ?? {},
        hops: hop,
        asked,
        briefConfirmed,
      };
    }
    if (plan.kind === "stop") {
      return {
        ok: false,
        status: result?.status ?? 400,
        body: result?.body ?? {
          ok: false,
          error: plan.reason,
          message: "Chat eval stopped before a verdict.",
          sessionId,
        },
        hops: hop + (result ? 1 : 0),
        asked,
        briefConfirmed,
      };
    }

    if (plan.asked) asked = true;
    if (plan.briefConfirmed) briefConfirmed = true;
    result = await input.turn(plan.input);
    if (typeof result.body.sessionId === "string") sessionId = result.body.sessionId;
    lastStatus = typeof result.body.status === "string" ? result.body.status : "";

    if (lastStatus === "done") {
      return {
        ok: result.ok,
        status: result.status,
        body: result.body,
        hops: hop + 1,
        asked,
        briefConfirmed,
      };
    }
    if (lastStatus !== "ask" && lastStatus !== "brief" && lastStatus !== "continue" && lastStatus !== "searching" && lastStatus !== "progress") {
      return {
        ok: false,
        status: result.status,
        body: result.body,
        hops: hop + 1,
        asked,
        briefConfirmed,
      };
    }
  }

  return {
    ok: false,
    status: 504,
    body: {
      ok: false,
      error: "chat_hop_limit",
      message: "Chat eval hit the hop limit before a verdict.",
      sessionId,
    },
    hops: maxHops,
    asked,
    briefConfirmed,
  };
}
