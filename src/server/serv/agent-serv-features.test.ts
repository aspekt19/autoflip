import { describe, expect, it } from "vitest";
import {
  classifyAgentFeatureRejection,
  findAgentServFeatureBundle,
  formatFeatureRejectionFlags,
  mergeResponsesTools,
  resaleAgentServFeatureBundle,
  servModelWithFeature,
} from "./agent-serv-features";

describe("agent-serv-features", () => {
  it("Find bundle requests kronos-multipath + prompt_guard + shadow", () => {
    const bundle = findAgentServFeatureBundle("gpt-6.1-sol");
    expect(bundle.model).toBe("gpt-6.1-sol-serv-kronos-multipath");
    expect(bundle.features).toEqual(
      expect.arrayContaining([
        "serv_prompt_guard",
        "serv_shadow_agent",
        "multipath",
        "kronos",
        "reasoning_effort",
        "content_filter",
        "prompt_cache",
        "responses_reasoning",
        "usage",
      ]),
    );
    expect(bundle.responsesExtensionTools.map((t) => t.name)).toEqual([
      "serv_prompt_guard",
      "serv_shadow_agent",
    ]);
    const merged = mergeResponsesTools(bundle.responsesExtensionTools, [
      { type: "function", name: "search_listings", description: "x", parameters: {} },
      { type: "function", name: "submit_picks", description: "x", parameters: {} },
    ]);
    expect(merged.map((t) => t.name)).toEqual([
      "serv_prompt_guard",
      "serv_shadow_agent",
      "search_listings",
      "submit_picks",
    ]);
  });

  it("Resale bundle matches flip_judge multipath + guard + shadow", () => {
    const bundle = resaleAgentServFeatureBundle("gpt-6.1-sol");
    expect(bundle.model).toBe("gpt-6.1-sol-serv-multipath");
    expect(bundle.features).toContain("multipath");
    expect(bundle.features).toContain("serv_shadow_agent");
    expect(bundle.features).not.toContain("kronos");
  });

  it("classifies feature rejections without implying silent drop", () => {
    const hits = classifyAgentFeatureRejection({
      status: 400,
      payload: {
        error: {
          message:
            "Function tools with reasoning_effort are not supported for gpt-6.1-sol in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.",
        },
      },
      endpoint: "chat",
      requestedFeatures: ["serv_prompt_guard", "serv_shadow_agent", "multipath", "responses_reasoning"],
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.keptRequesting === true)).toBe(true);
    expect(formatFeatureRejectionFlags(hits)[0]).toMatch(/^FEATURE_REJECTION /);
  });

  it("servModelWithFeature strips prior suffixes before re-appending", () => {
    expect(servModelWithFeature("gpt-6.1-sol-serv-multipath", "kronos-multipath")).toBe(
      "gpt-6.1-sol-serv-kronos-multipath",
    );
  });
});
