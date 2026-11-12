import { describe, expect, it } from "vitest";
import {
  buildServChatTurnBody,
  buildServResponsesTurnBody,
  normalizeServAgentReasoningEffort,
} from "./agent-chat-turn";

describe("agent chat/responses reasoning_effort", () => {
  it("never normalizes to none", () => {
    expect(normalizeServAgentReasoningEffort("none")).toBe("low");
    expect(normalizeServAgentReasoningEffort(null)).toBe("low");
    expect(normalizeServAgentReasoningEffort("high")).toBe("high");
  });

  it("chat body never sends reasoning_effort none", () => {
    const body = buildServChatTurnBody({
      messages: [{ role: "user", content: "hi" }],
      reasoningEffort: "none",
      jsonSchema: { name: "x", schema: { type: "object", properties: {} } },
    });
    expect(body.reasoning_effort).toBe("low");
    expect(body.reasoning_effort).not.toBe("none");
    expect(body).not.toHaveProperty("max_completion_tokens");
  });

  it("responses body prefers tools with supported effort and no token caps", () => {
    const body = buildServResponsesTurnBody({
      instructions: "Find a car.",
      input: "Begin.",
      tools: [
        {
          type: "function",
          name: "search_listings",
          description: "Search",
          parameters: { type: "object", properties: {} },
        },
      ],
      reasoning: { effort: "none", summary: "auto" },
    });
    expect((body.reasoning as { effort: string }).effort).toBe("low");
    expect(body.tools).toHaveLength(1);
    expect(body).not.toHaveProperty("max_output_tokens");
  });
});
