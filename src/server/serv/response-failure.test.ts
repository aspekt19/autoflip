import { describe, expect, it } from "vitest";
import {
  classifyServPlannerFailure,
  extractUsageFromPayload,
  inspectServMessageFields,
} from "./response-failure";
import { messageText } from "./run";
import { normalizeCompareUsageLoose } from "@/server/scout/plan-parse-diagnostics";

describe("Gemini-safe response failure diagnostics (t317)", () => {
  const geminiStylePayload = {
    id: "synthetic-test-gemini",
    choices: [
      {
        finish_reason: "stop",
        message: {
          content: null,
          refusal: "I won't help.", // 12 chars trimmed — parent saw ~19; length only matters
        },
      },
    ],
    usage: {
      promptTokenCount: 1200,
      candidatesTokenCount: 40,
      totalTokenCount: 1240,
    },
  };

  it("inspects content-null + refusal field without storing prose", () => {
    const fields = inspectServMessageFields(geminiStylePayload);
    expect(fields.contentIsNull).toBe(true);
    expect(fields.refusalFieldPresent).toBe(true);
    expect(fields.refusalFieldBytes).toBe(Buffer.byteLength("I won't help.", "utf8"));
    expect(fields.finishReason).toBe("stop");
    expect(fields.hasUsageObject).toBe(true);
    expect(JSON.stringify(fields)).not.toContain("won't help");
  });

  it("classifies as content_null_refusal_field — no format/safety RCA", () => {
    const diag = classifyServPlannerFailure({
      payload: geminiStylePayload,
      httpOk: true,
      status: 200,
      text: messageText(geminiStylePayload, "structured"),
      parseKind: "invalid_json",
    });
    expect(diag.category).toBe("content_null_refusal_field");
    expect(diag.reasonCode).toBe("message_content_null_refusal_field");
    expect(diag.honesty).toMatch(/not assert format-failure or safety-cause/i);
    expect(JSON.stringify(diag)).not.toContain("won't help");
    expect(diag.usage).toEqual({
      prompt_tokens: 1200,
      completion_tokens: 40,
      total_tokens: 1240,
    });
  });

  it("repairs Gemini camelCase usage that previously became tokens null", () => {
    expect(normalizeCompareUsageLoose(geminiStylePayload.usage)).toEqual({
      prompt_tokens: 1200,
      completion_tokens: 40,
      total_tokens: 1240,
    });
    expect(extractUsageFromPayload(geminiStylePayload)).toEqual({
      prompt_tokens: 1200,
      completion_tokens: 40,
      total_tokens: 1240,
    });
  });

  it("does not weaken: empty content without refusal stays empty_content", () => {
    const diag = classifyServPlannerFailure({
      payload: { choices: [{ finish_reason: "stop", message: { content: null } }] },
      httpOk: true,
      status: 200,
      text: "",
      parseKind: null,
    });
    expect(diag.category).toBe("empty_content");
  });
});
