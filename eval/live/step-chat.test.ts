import { describe, expect, it, vi } from "vitest";
import type { ChatTurnFn } from "./drive-chat";
import type { GeneratedQuery } from "./types";
import { beginEvalActiveChat, runEvalChatHop } from "./step-chat";

const query: GeneratedQuery = {
  id: "find_01",
  product: "find",
  note: "Need a Camry under 15k",
  zip: null,
  distanceMiles: null,
  tags: {
    product: "find",
    city: "custom",
    budget: "custom",
    body: "custom",
    need: "custom",
    messy: false,
  },
};

const kv = { get: async () => null, set: async () => undefined } as never;

describe("runEvalChatHop", () => {
  it("runs exactly one chat turn per call and keeps the session across hops", async () => {
    const turn: ChatTurnFn = vi.fn(async (input) => {
      if (!input.sessionId) {
        return { ok: true, status: 200, body: { ok: true, status: "ask", sessionId: "s1", question: "Budget?" } };
      }
      if (input.message) {
        return {
          ok: true,
          status: 200,
          body: { ok: true, status: "brief", sessionId: "s1", brief: { summary: "card" } },
        };
      }
      if (input.confirmBrief) {
        return { ok: true, status: 200, body: { ok: true, status: "continue", sessionId: "s1" } };
      }
      return {
        ok: true,
        status: 200,
        body: {
          ok: true,
          status: "done",
          sessionId: "s1",
          result: {
            ok: true,
            offerPool: [],
            agentLoop: {
              toolRounds: 1,
              verdictReached: true,
              passReason: "none",
              relaxedConditions: [{ name: "price", why: "empty" }],
              carsFound: 0,
            },
          },
        },
      };
    });

    const deps = { kv, userId: "eval", servKey: "s", autodevKey: "a", turn };

    let active = beginEvalActiveChat(0);
    const first = await runEvalChatHop({ query, active, deps });
    expect(first.kind).toBe("in_progress");
    if (first.kind !== "in_progress") return;
    expect(first.turnStatus).toBe("ask");
    expect(turn).toHaveBeenCalledTimes(1);
    active = first.active;

    const second = await runEvalChatHop({ query, active, deps });
    expect(second.kind).toBe("in_progress");
    if (second.kind !== "in_progress") return;
    expect(second.turnStatus).toBe("brief");
    expect(second.active.asked).toBe(true);
    expect(turn).toHaveBeenCalledTimes(2);
    active = second.active;

    const third = await runEvalChatHop({ query, active, deps });
    expect(third.kind).toBe("in_progress");
    if (third.kind !== "in_progress") return;
    expect(third.turnStatus).toBe("continue");
    expect(third.active.briefConfirmed).toBe(true);
    expect(turn).toHaveBeenCalledTimes(3);
    active = third.active;

    const fourth = await runEvalChatHop({ query, active, deps });
    expect(fourth.kind).toBe("query_done");
    expect(turn).toHaveBeenCalledTimes(4);
    if (fourth.kind !== "query_done") return;
    expect(fourth.hops).toBe(4);
    expect(fourth.result.ok).toBe(true);
  });

  it("beginEvalActiveChat starts with no session and zero hops", () => {
    const active = beginEvalActiveChat(2, 1_000);
    expect(active).toEqual({
      queryIndex: 2,
      sessionId: null,
      lastStatus: null,
      asked: false,
      briefConfirmed: false,
      hops: 0,
      startedAtMs: 1_000,
    });
  });
});
