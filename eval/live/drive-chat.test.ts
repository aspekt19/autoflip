import { describe, expect, it } from "vitest";
import {
  driveServChatEval,
  evalShopperReplyFromQuery,
  planNextEvalChatTurn,
  type ChatTurnFn,
} from "./drive-chat";

describe("planNextEvalChatTurn", () => {
  it("starts with the first message, then ask → reply → brief → confirm → continue", () => {
    expect(planNextEvalChatTurn({ firstMessage: "Need a Camry", lastStatus: null, sessionId: null })).toEqual({
      kind: "turn",
      input: { message: "Need a Camry" },
    });
    expect(
      planNextEvalChatTurn({ firstMessage: "Need a Camry", lastStatus: "ask", sessionId: "s1", genericReply: "ok" }),
    ).toEqual({
      kind: "turn",
      input: { sessionId: "s1", message: "ok" },
      asked: true,
    });
    expect(
      planNextEvalChatTurn({ firstMessage: "Need a Camry", lastStatus: "brief", sessionId: "s1" }),
    ).toEqual({
      kind: "turn",
      input: { sessionId: "s1", confirmBrief: true },
      briefConfirmed: true,
    });
    expect(
      planNextEvalChatTurn({ firstMessage: "Need a Camry", lastStatus: "continue", sessionId: "s1" }),
    ).toEqual({
      kind: "turn",
      input: { sessionId: "s1", continue: true },
    });
    expect(
      planNextEvalChatTurn({ firstMessage: "Need a Camry", lastStatus: "done", sessionId: "s1" }),
    ).toEqual({ kind: "done" });
  });
});

describe("evalShopperReplyFromQuery", () => {
  it("answers budget, zip, and use from the query persona", () => {
    const reply = evalShopperReplyFromQuery({
      note: "lookin for a hatchback under $12k near Denver",
      zip: "80202",
      tags: {
        product: "find",
        city: "denver",
        budget: "12k",
        body: "hatch",
        need: "cargo",
        messy: true,
      },
    });
    expect(reply).toMatch(/\$12000|\$12,000|12000/);
    expect(reply).toMatch(/80202/);
    expect(reply).toMatch(/cargo|gear/i);
    expect(reply).toMatch(/brief/i);
  });

  it("falls back to no preference when tags are thin", () => {
    const reply = evalShopperReplyFromQuery({
      note: "need a car",
      zip: null,
      tags: { product: "find", city: "x", budget: "", body: "", need: "", messy: false },
    });
    expect(reply.toLowerCase()).toMatch(/no (budget|zip|other)/);
  });

  it("does not regex the free-text note for a budget when tags omit one", () => {
    const reply = evalShopperReplyFromQuery({
      note: "up to forty five thousand near me",
      zip: null,
      tags: { product: "find", city: "x", budget: "", body: "", need: "", messy: false },
    });
    expect(reply.toLowerCase()).not.toMatch(/forty/);
    expect(reply.toLowerCase()).toMatch(/already wrote|no budget/);
  });
});

describe("driveServChatEval", () => {
  it("answers asks, confirms the brief, then records done", async () => {
    const calls: string[] = [];
    const turn: ChatTurnFn = async (input) => {
      if (input.message && !input.sessionId) {
        calls.push("start");
        return { ok: true, status: 200, body: { ok: true, status: "ask", sessionId: "s1", question: "Budget?" } };
      }
      if (input.message) {
        calls.push("reply");
        return { ok: true, status: 200, body: { ok: true, status: "brief", sessionId: "s1", brief: { summary: "card" } } };
      }
      if (input.confirmBrief) {
        calls.push("confirm");
        return { ok: true, status: 200, body: { ok: true, status: "continue", sessionId: "s1" } };
      }
      if (input.continue) {
        calls.push("continue");
        return {
          ok: true,
          status: 200,
          body: { ok: true, status: "done", sessionId: "s1", result: { ok: true } },
        };
      }
      throw new Error("unexpected");
    };
    const out = await driveServChatEval({ firstMessage: "Need a Camry under 15k", turn });
    expect(calls).toEqual(["start", "reply", "confirm", "continue"]);
    expect(out.ok).toBe(true);
    expect(out.asked).toBe(true);
    expect(out.briefConfirmed).toBe(true);
    expect(out.body.status).toBe("done");
  });
});
