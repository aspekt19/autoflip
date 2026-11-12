import { describe, expect, it } from "vitest";
import { driveServChatEval, type ChatTurnFn } from "./drive-chat";

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
