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
});
