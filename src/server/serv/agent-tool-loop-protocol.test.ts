import { describe, expect, it } from "vitest";
import {
  appendResponsesToolRound,
  extractResponsesFunctionCalls,
  keepResponsesLoopItems,
  responsesUserMessage,
} from "./agent-tool-loop-protocol";

describe("agent-tool-loop-protocol", () => {
  it("prefers call_id over id for function_call_output matching", () => {
    const calls = extractResponsesFunctionCalls([
      {
        type: "function_call",
        id: "fc_wrong",
        call_id: "call_search_1",
        name: "search_listings",
        arguments: "{}",
      },
      {
        type: "function_call",
        id: "fc_2",
        call_id: "call_search_2",
        name: "search_listings",
        arguments: "{}",
      },
    ]);
    expect(calls.map((c) => c.callId)).toEqual(["call_search_1", "call_search_2"]);
  });

  it("keeps reasoning + function_call items and emits one output per call_id", () => {
    const prior = [responsesUserMessage("Search sedans.")];
    const output = [
      { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Try three makes." }] },
      {
        type: "function_call",
        id: "fc_a",
        call_id: "call_a",
        name: "search_listings",
        arguments: JSON.stringify({ make: "Toyota" }),
      },
      {
        type: "function_call",
        id: "fc_b",
        call_id: "call_b",
        name: "search_listings",
        arguments: JSON.stringify({ make: "Honda" }),
      },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Searching." }] },
    ];
    expect(keepResponsesLoopItems(output)).toHaveLength(3);

    const next = appendResponsesToolRound({
      priorInput: prior,
      responseOutput: output,
      outputs: [
        { callId: "call_a", output: { totalReturned: 2 } },
        { callId: "call_b", output: { totalReturned: 1 } },
      ],
    });

    expect(next[0]).toMatchObject({ type: "message", role: "user" });
    expect(next.some((item) => item.type === "reasoning")).toBe(true);
    const outs = next.filter((item) => item.type === "function_call_output");
    expect(outs).toHaveLength(2);
    expect(outs.map((o) => o.call_id).sort()).toEqual(["call_a", "call_b"]);
    expect(typeof outs[0]?.output).toBe("string");
  });
});
