import { describe, expect, it } from "vitest";
import {
  applyResaleAgentGuardrails,
  resaleAgentLoopEnabled,
  resolveResaleAgentMode,
  validateResaleAgentVerdict,
} from "./resale-agent";

const VIN = "1HGCM82633A004352";

describe("resaleAgentLoopEnabled", () => {
  it("is on whenever a SERV key is present", () => {
    expect(resaleAgentLoopEnabled({ RESALE_AGENT_LOOP: "auto" }, { servKey: "sk" })).toBe(true);
    expect(resaleAgentLoopEnabled({}, { servKey: "sk" })).toBe(true);
    expect(resaleAgentLoopEnabled({ RESALE_AGENT_LOOP: "0" }, { servKey: "sk" })).toBe(true);
    // E2E stub must not disable the agent loop — stub upstreams instead.
    expect(resaleAgentLoopEnabled({ LEMONLESS_E2E_STUB: "1" }, { servKey: "sk" })).toBe(true);
  });

  it("requires a serv key", () => {
    expect(resaleAgentLoopEnabled({ RESALE_AGENT_LOOP: "1" }, { servKey: "" })).toBe(false);
    expect(resaleAgentLoopEnabled({ LEMONLESS_E2E_STUB: "1" }, { servKey: "" })).toBe(false);
  });
});

describe("resolveResaleAgentMode", () => {
  it("defaults to tools", () => {
    expect(resolveResaleAgentMode({})).toBe("tools");
    expect(resolveResaleAgentMode({ RESALE_AGENT_MODE: "tools" })).toBe("tools");
    expect(resolveResaleAgentMode({ RESALE_AGENT_MODE: "next_action" })).toBe("next_action");
  });
});

describe("validateResaleAgentVerdict + guardrails", () => {
  it("drops invented VIN", () => {
    const ok = validateResaleAgentVerdict({
      summary: "ok",
      confidence: "low",
      picks: [
        {
          vin: VIN,
          action: "buy",
          offerUsd: 12_000,
          why: "real",
        },
        {
          vin: "INVENTEDVIN000001",
          action: "buy",
          offerUsd: 10_000,
          why: "fake",
        },
      ],
      relaxedConditions: [],
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    const guarded = applyResaleAgentGuardrails(ok.verdict, {
      allowedVins: new Set([VIN]),
      budgetUsd: 15_000,
    });
    expect(guarded.verdict.picks).toHaveLength(1);
    expect(guarded.dropped[0]?.reason).toBe("invented_vin_not_in_tool_results");
  });

  it("clamps negative mid-profit buy to pass", () => {
    const ok = validateResaleAgentVerdict({
      summary: "would buy",
      confidence: "medium",
      picks: [
        {
          vin: VIN,
          action: "buy",
          offerUsd: 14_000,
          why: "Looks cheap.",
        },
      ],
      relaxedConditions: [],
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    const guarded = applyResaleAgentGuardrails(ok.verdict, {
      allowedVins: new Set([VIN]),
      budgetUsd: 20_000,
      pnlByVin: new Map([
        [
          VIN,
          {
            vin: VIN,
            profitMidUsd: -800,
            rankingProfitMidUsd: -900,
          },
        ],
      ]),
    });
    expect(guarded.verdict.picks).toHaveLength(1);
    expect(guarded.verdict.picks[0]?.action).toBe("pass");
    expect(guarded.verdict.picks[0]?.why).toMatch(/negative/);
  });

  it("clamps offer to budget", () => {
    const ok = validateResaleAgentVerdict({
      summary: "ok",
      confidence: "high",
      picks: [{ vin: VIN, action: "negotiate", offerUsd: 25_000, why: "x" }],
      relaxedConditions: [],
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    const guarded = applyResaleAgentGuardrails(ok.verdict, {
      allowedVins: new Set([VIN]),
      budgetUsd: 18_000,
      pnlByVin: new Map([[VIN, { vin: VIN, profitMidUsd: 1200, rankingProfitMidUsd: 1100 }]]),
    });
    expect(guarded.verdict.picks[0]?.offerUsd).toBe(18_000);
    expect(guarded.verdict.picks[0]?.action).toBe("negotiate");
  });
});
