import { describe, expect, it } from "vitest";
import { settleFindChatCaseResult, settleResaleChatCaseResult } from "./settle-chat-result";
import type { GeneratedQuery } from "./types";

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

const usage = {
  calls: 3,
  input_tokens: 1000,
  output_tokens: 200,
  total_tokens: 1200,
  reasoning_tokens: 50,
  cached_tokens: 800,
  cost: 0.42,
};

describe("settle chat result copies journal SERV usage", () => {
  it("find: from agentLoop.servUsageTotal", () => {
    const settled = settleFindChatCaseResult({
      query,
      drivenOk: true,
      body: {
        ok: true,
        result: {
          ok: true,
          bestDeal: null,
          offerPool: [],
          agentLoop: {
            journalServCalls: 3,
            journalToolCalls: 2,
            servUsageTotal: usage,
            verdictReached: true,
            carsFound: 0,
            passReason: "Nothing fit.",
          },
          honesty: "SERV searched live inventory and explained why nothing fit.",
        },
      },
      elapsedMs: 1000,
    });
    expect(settled.servUsageTotal).toEqual(usage);
  });

  it("resale: from journalMeta.servUsageTotal when agentLoop omits it", () => {
    const settled = settleResaleChatCaseResult({
      query: { ...query, id: "resale_01", product: "resale" },
      drivenOk: true,
      body: {
        ok: true,
        result: {
          ok: true,
          best: null,
          alternatives: [],
          journalMeta: { servCalls: 2, toolCalls: 1, servUsageTotal: usage },
          agentLoop: {
            journalServCalls: 2,
            journalToolCalls: 1,
            verdictReached: true,
            carsFound: 0,
            passReason: "None",
          },
          message: "Nothing fit.",
        },
      },
      elapsedMs: 1000,
    });
    expect(settled.servUsageTotal).toEqual(usage);
  });

  it("find: includes runId, full confirmedBrief, and per-call featuresActive", () => {
    const brief = {
      summary: "Camry under 15k near 43215",
      budget: { maxUsd: 15_000, userQuote: "under 15k" },
      zip: "43215",
      radiusMi: 50,
    };
    const settled = settleFindChatCaseResult({
      query,
      drivenOk: true,
      body: {
        ok: true,
        result: {
          ok: true,
          runId: "run_abc123",
          confirmedBrief: brief,
          bestDeal: null,
          offerPool: [],
          agentLoop: {
            journalServCalls: 2,
            journalToolCalls: 1,
            servUsageTotal: usage,
            verdictReached: true,
            carsFound: 0,
            passReason: "Nothing fit.",
            featuresActive: ["serv_prompt_guard", "kronos", "multipath", "serv_shadow_agent"],
            featuresActivePerCall: [
              ["serv_prompt_guard"],
              ["kronos", "multipath", "serv_shadow_agent"],
            ],
            featureRejections: [],
            servResponseIds: ["resp_1", "resp_2"],
          },
          honesty: "SERV searched live inventory and explained why nothing fit.",
        },
      },
      elapsedMs: 1000,
    });
    expect(settled.runId).toBe("run_abc123");
    expect(settled.confirmedBrief).toEqual(brief);
    expect(settled.featuresActive).toEqual(
      expect.arrayContaining(["serv_prompt_guard", "kronos", "multipath", "serv_shadow_agent"]),
    );
    expect(settled.featuresActivePerCall).toEqual([
      ["serv_prompt_guard"],
      ["kronos", "multipath", "serv_shadow_agent"],
    ]);
  });

  it("resale: includes runId, confirmedBrief, and featuresActive from agentLoop", () => {
    const brief = {
      summary: "Flip Jeep under 10k",
      budget: { maxUsd: 10_000, userQuote: "under 10k" },
      zip: "48226",
      radiusMi: 75,
    };
    const settled = settleResaleChatCaseResult({
      query: { ...query, id: "resale_02", product: "resale" },
      drivenOk: true,
      body: {
        ok: true,
        result: {
          ok: true,
          runId: "run_resale_9",
          confirmedBrief: brief,
          best: null,
          alternatives: [],
          agentVerdict: { verdict: "pass" },
          agentLoop: {
            journalServCalls: 2,
            journalToolCalls: 1,
            servUsageTotal: usage,
            verdictReached: true,
            carsFound: 0,
            passReason: "Mid not positive.",
            featuresActive: ["serv_prompt_guard", "multipath", "serv_shadow_agent"],
            featuresActivePerCall: [["serv_prompt_guard"], ["multipath", "serv_shadow_agent"]],
          },
          message: "Nothing fit.",
        },
      },
      elapsedMs: 900,
    });
    expect(settled.runId).toBe("run_resale_9");
    expect(settled.confirmedBrief).toEqual(brief);
    expect(settled.featuresActivePerCall?.[1]).toEqual(
      expect.arrayContaining(["multipath", "serv_shadow_agent"]),
    );
    expect(settled.featuresActivePerCall?.[1]).not.toContain("serv_prompt_guard");
  });
});
