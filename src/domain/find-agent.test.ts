import { describe, expect, it } from "vitest";
import {
  applyFindAgentGuardrails,
  findAgentLoopEnabled,
  resolveFindAgentMode,
  validateFindAgentVerdict,
} from "./find-agent";

describe("findAgentLoopEnabled", () => {
  it("defaults on when servKey present and not e2e stub", () => {
    expect(findAgentLoopEnabled({ FIND_AGENT_LOOP: "auto" }, { servKey: "sk" })).toBe(true);
    expect(findAgentLoopEnabled({}, { servKey: "sk" })).toBe(true);
  });

  it("stays off under the labelled e2e stub (classic path)", () => {
    expect(
      findAgentLoopEnabled({ LEMONLESS_E2E_STUB: "1", FIND_AGENT_LOOP: "auto" }, { servKey: "sk" }),
    ).toBe(false);
    expect(
      findAgentLoopEnabled({ LEMONLESS_E2E_STUB: "1", FIND_AGENT_LOOP: "1" }, { servKey: "sk" }),
    ).toBe(false);
  });

  it("ignores FIND_AGENT_LOOP=0 — agent loop always when keyed", () => {
    expect(findAgentLoopEnabled({ FIND_AGENT_LOOP: "0" }, { servKey: "sk" })).toBe(true);
  });

  it("requires a serv key", () => {
    expect(findAgentLoopEnabled({ FIND_AGENT_LOOP: "1" }, { servKey: "" })).toBe(false);
  });
});

describe("resolveFindAgentMode", () => {
  it("defaults to auto (Responses tools first, next_action fallback)", () => {
    expect(resolveFindAgentMode({})).toBe("auto");
    expect(resolveFindAgentMode({ FIND_AGENT_MODE: "tools" })).toBe("tools");
    expect(resolveFindAgentMode({ FIND_AGENT_MODE: "next_action" })).toBe("next_action");
    expect(resolveFindAgentMode({ FIND_AGENT_MODE: "auto" })).toBe("auto");
  });
});

describe("validateFindAgentVerdict + guardrails", () => {
  it("rejects missing summary", () => {
    const bad = validateFindAgentVerdict({ confidence: "low", picks: [], relaxedConditions: [], passReason: null });
    expect(bad.ok).toBe(false);
  });

  it("drops invented VIN", () => {
    const ok = validateFindAgentVerdict({
      summary: "ok",
      confidence: "low",
      picks: [
        {
          vin: "1HGCM82633A004352",
          label: "Honda",
          action: "pass",
          offerUsd: null,
          why: "x",
        },
      ],
      relaxedConditions: [],
      passReason: null,
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    const guarded = applyFindAgentGuardrails(ok.verdict, {
      allowedVins: new Set(),
      budgetUsd: null,
    });
    expect(guarded.verdict.picks).toHaveLength(0);
    expect(guarded.dropped[0]?.reason).toBe("invented_vin_not_in_tool_results");
  });
});
