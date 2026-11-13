import { describe, expect, it } from "vitest";
import {
  applyFindAgentGuardrails,
  findAgentLoopEnabled,
  resolveFindAgentMode,
  validateFindAgentVerdict,
  validateFindSubmitPicks,
} from "./find-agent";

describe("findAgentLoopEnabled", () => {
  it("is on whenever a SERV key is present", () => {
    expect(findAgentLoopEnabled({ FIND_AGENT_LOOP: "auto" }, { servKey: "sk" })).toBe(true);
    expect(findAgentLoopEnabled({}, { servKey: "sk" })).toBe(true);
    expect(findAgentLoopEnabled({ FIND_AGENT_LOOP: "0" }, { servKey: "sk" })).toBe(true);
    // E2E stub must not disable the agent loop — stub upstreams instead.
    expect(findAgentLoopEnabled({ LEMONLESS_E2E_STUB: "1" }, { servKey: "sk" })).toBe(true);
  });

  it("requires a serv key", () => {
    expect(findAgentLoopEnabled({ FIND_AGENT_LOOP: "1" }, { servKey: "" })).toBe(false);
    expect(findAgentLoopEnabled({ LEMONLESS_E2E_STUB: "1" }, { servKey: "" })).toBe(false);
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

  it("submit_picks rejects pass-only picks (chosen must be buy|negotiate|inspect_first)", () => {
    const vin = "1HGCM82633A004352";
    const listings = new Map([[vin, { vin, priceUsd: 12_000, miles: 40_000, distanceMiles: 20 }]]);
    const passOnly = validateFindSubmitPicks(
      {
        summary: "Passing on this Camry.",
        confidence: "medium",
        picks: [{ vin, label: "Camry", action: "pass", offerUsd: null, why: "Too many miles." }],
        relaxedConditions: [],
        passReason: "Too many miles.",
      },
      { listingsByVin: listings, budgetUsd: 15_000 },
    );
    expect(passOnly.ok).toBe(false);
    if (!passOnly.ok) {
      expect(passOnly.issues.some((i) => i.field === "picks" && /submit_nothing_fits|inspect_first/.test(i.message))).toBe(
        true,
      );
    }

    const buyOk = validateFindSubmitPicks(
      {
        summary: "Camry fits.",
        confidence: "high",
        picks: [{ vin, label: "Camry", action: "buy", offerUsd: 11_500, why: "Clean ask." }],
        relaxedConditions: [],
        passReason: null,
      },
      { listingsByVin: listings, budgetUsd: 15_000 },
    );
    expect(buyOk.ok).toBe(true);
  });
});
