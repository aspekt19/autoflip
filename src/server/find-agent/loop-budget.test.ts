/**
 * Verify the Find agent loop pauses with a checkpoint under a tight request budget
 * instead of starting another SERV round (no clipped SERV timeouts).
 */
import { describe, expect, it } from "vitest";
import { makeAgentLoopDeadline } from "@/domain/agent-loop-deadline";
import { isServResponsesUrl } from "@/server/serv/agent-chat-turn";
import { runFindAgentLoop } from "./loop";

describe("runFindAgentLoop request budget", () => {
  it("returns continue + checkpoint when the deadline is already spent", async () => {
    let servCalls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (isServResponsesUrl(url)) {
        servCalls += 1;
        return new Response(JSON.stringify({ id: "resp_should_not_run", output: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("no", { status: 404 });
    };

    // Deadline already expired — first round must pause before any SERV call.
    const deadline = makeAgentLoopDeadline(1_000, Date.now() - 5_000);
    const result = await runFindAgentLoop({
      note: "SUV under 25k near Miami",
      mode: "tools",
      deadline,
      deps: {
        servKey: "test-serv",
        autodevKey: "test-autodev",
        fetch: fetchImpl,
      },
      maxRounds: 5,
    });

    expect(result.ok).toBe(false);
    expect("continue" in result && result.continue).toBe(true);
    if (!("continue" in result) || !result.continue) return;
    expect(result.error).toBe("request_budget");
    expect(result.checkpoint.product).toBe("find");
    expect(result.checkpoint.phase).toBe("tools");
    expect(servCalls).toBe(0);
  });
});
