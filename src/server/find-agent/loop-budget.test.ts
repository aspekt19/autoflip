/**
 * Verify the Find agent loop pauses with a checkpoint under a tight request budget
 * instead of starting another SERV / Auto.dev call (no clipped SERV timeouts).
 */
import { describe, expect, it } from "vitest";
import {
  AGENT_LOOP_AUTODEV_FULL_CALL_MS,
  AGENT_LOOP_REQUEST_BUDGET_MS,
  makeAgentLoopDeadline,
} from "@/domain/agent-loop-deadline";
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

  it("returns continue without Auto.dev when hop time cannot fit a full provider call", async () => {
    let servCalls = 0;
    let autodevCalls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (isServResponsesUrl(url)) {
        servCalls += 1;
        return new Response(
          JSON.stringify({
            id: "resp_tools",
            output: [
              {
                type: "function_call",
                call_id: "call_search",
                name: "search_listings",
                arguments: JSON.stringify({
                  make: "Honda",
                  bodyFamily: "car",
                  zip: "97201",
                  radiusMi: 60,
                  priceMaxUsd: 15_000,
                }),
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/zip/") || url.includes("/listings") || url.includes("api.auto.dev")) {
        autodevCalls += 1;
      }
      return new Response("no", { status: 404 });
    };

    // Synthetic deadline: allow SERV full-call floor (90s), deny Auto.dev full-call (60s).
    const now = Date.now();
    const deadline = {
      endsAtMs: now + AGENT_LOOP_REQUEST_BUDGET_MS,
      startedAtMs: now,
      remainingMs: () => AGENT_LOOP_REQUEST_BUDGET_MS,
      expired: () => false,
      elapsedMs: () => 0,
      // needMs > 60s → SERV (90s) starts; Auto.dev (60s) does not.
      allow: (needMs: number) => needMs > AGENT_LOOP_AUTODEV_FULL_CALL_MS,
    };

    const result = await runFindAgentLoop({
      note: "compact crossover under 15k near Portland 97201",
      mode: "tools",
      deadline,
      requireBriefConfirm: false,
      briefConfirmed: true,
      deps: {
        servKey: "test-serv",
        autodevKey: "test-autodev",
        fetch: fetchImpl,
      },
      maxRounds: 3,
    });

    expect(result.ok).toBe(false);
    expect("continue" in result && result.continue).toBe(true);
    if (!("continue" in result) || !result.continue) return;
    expect(result.error).toBe("request_budget");
    expect(servCalls).toBe(1);
    expect(autodevCalls).toBe(0);
  });
});
