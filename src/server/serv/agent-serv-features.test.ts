import { describe, expect, it } from "vitest";
import {
  AGENT_STEP_MAX_OUTPUT_TOKENS,
  buildAgentServFeatureBundle,
  classifyAgentFeatureRejection,
  findAgentServFeatureBundle,
  formatFeatureRejectionFlags,
  mergeResponsesTools,
  resaleAgentServFeatureBundle,
  resolveAgentServStep,
  servModelWithFeature,
} from "./agent-serv-features";
import { BASE_MODEL } from "./profiles";

describe("agent-serv-features", () => {
  it("Find verdict bundle requests kronos-multipath + prompt_guard + shadow", () => {
    const bundle = findAgentServFeatureBundle(BASE_MODEL);
    expect(bundle.model).toBe(`${BASE_MODEL}-serv-kronos-multipath`);
    expect(bundle.step).toBe("verdict");
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

  it("Resale verdict bundle matches flip_judge multipath + guard + shadow", () => {
    const bundle = resaleAgentServFeatureBundle(BASE_MODEL);
    expect(bundle.model).toBe(`${BASE_MODEL}-serv-multipath`);
    expect(bundle.features).toContain("multipath");
    expect(bundle.features).toContain("serv_shadow_agent");
    expect(bundle.features).not.toContain("kronos");
  });

  it("intake/search hops use bare model; verdict adds quality features; guard is opt-in", () => {
    const intake = buildAgentServFeatureBundle({
      product: "find",
      step: "intake",
      includePromptGuard: true,
    });
    expect(intake.model).toBe(BASE_MODEL);
    expect(intake.responsesExtensionTools.map((t) => t.name)).toEqual(["serv_prompt_guard"]);
    expect(intake.maxOutputTokens).toBe(AGENT_STEP_MAX_OUTPUT_TOKENS.intake);

    const search = buildAgentServFeatureBundle({
      product: "find",
      step: "search",
      includePromptGuard: false,
    });
    expect(search.model).toBe(BASE_MODEL);
    expect(search.responsesExtensionTools).toEqual([]);
    expect(search.features).not.toContain("serv_prompt_guard");
    expect(search.features).not.toContain("serv_shadow_agent");
    expect(search.features).not.toContain("kronos");

    const verdict = buildAgentServFeatureBundle({
      product: "find",
      step: "verdict",
      includePromptGuard: false,
    });
    expect(verdict.model).toBe(`${BASE_MODEL}-serv-kronos-multipath`);
    expect(verdict.responsesExtensionTools.map((t) => t.name)).toEqual(["serv_shadow_agent"]);
    expect(verdict.maxOutputTokens).toBe(AGENT_STEP_MAX_OUTPUT_TOKENS.verdict);
  });

  it("resolveAgentServStep maps brief/search/verdict phases", () => {
    expect(
      resolveAgentServStep({
        requireBriefConfirm: true,
        briefConfirmed: false,
        searchCount: 0,
        submitNudgeSent: false,
      }),
    ).toBe("intake");
    expect(
      resolveAgentServStep({
        requireBriefConfirm: true,
        briefConfirmed: true,
        searchCount: 0,
        submitNudgeSent: false,
      }),
    ).toBe("search");
    expect(
      resolveAgentServStep({
        requireBriefConfirm: false,
        briefConfirmed: false,
        searchCount: 1,
        submitNudgeSent: false,
      }),
    ).toBe("verdict");
  });

  it("classifies feature rejections without implying silent drop", () => {
    const hits = classifyAgentFeatureRejection({
      status: 400,
      payload: {
        error: {
          message:
            `${BASE_MODEL} function tools with reasoning_effort are not supported in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.`,
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
    expect(servModelWithFeature(`${BASE_MODEL}-serv-multipath`, "kronos-multipath")).toBe(
      `${BASE_MODEL}-serv-kronos-multipath`,
    );
  });
});
