/**
 * Drive Find/Resale SERV chat for live eval:
 * user message → answer questions → confirm brief → continue until verdict.
 * Replies are generic; code does not parse or invent shopper facts.
 */
import { LIVE_EVAL_GENERIC_SHOPPER_REPLY } from "@/domain/serv-chat";

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

export async function driveServChatEval(input: {
  firstMessage: string;
  turn: ChatTurnFn;
  genericReply?: string;
  maxHops?: number;
}): Promise<DriveServChatResult> {
  const reply = input.genericReply ?? LIVE_EVAL_GENERIC_SHOPPER_REPLY;
  const maxHops = input.maxHops ?? LIVE_EVAL_CHAT_MAX_HOPS;

  let asked = false;
  let briefConfirmed = false;
  let result = await input.turn({ message: input.firstMessage });
  let sessionId = typeof result.body.sessionId === "string" ? result.body.sessionId : null;

  for (let hop = 0; hop < maxHops; hop += 1) {
    const status = typeof result.body.status === "string" ? result.body.status : "";
    if (status === "done") {
      return { ok: result.ok, status: result.status, body: result.body, hops: hop + 1, asked, briefConfirmed };
    }
    if (status === "ask") {
      if (!sessionId) break;
      asked = true;
      result = await input.turn({ sessionId, message: reply });
    } else if (status === "brief") {
      if (!sessionId) break;
      briefConfirmed = true;
      result = await input.turn({ sessionId, confirmBrief: true });
    } else if (status === "continue" || status === "searching" || status === "progress") {
      if (!sessionId) break;
      result = await input.turn({ sessionId, continue: true });
    } else {
      return {
        ok: false,
        status: result.status,
        body: result.body,
        hops: hop + 1,
        asked,
        briefConfirmed,
      };
    }
    if (typeof result.body.sessionId === "string") sessionId = result.body.sessionId;
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
