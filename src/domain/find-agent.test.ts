import { describe, expect, it } from "vitest";
import { clipBuyerText } from "@/domain/normalized-vehicle";
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

  it("stores SERV why untruncated (>400 chars); clipBuyerText only at display", () => {
    const longWhy =
      "This Camry fits budget and radius with clean title history, fair ask versus local comps, " +
      "and low complaint volume for the year — ".repeat(8) +
      "final decision: buy near asking after a short inspection for open recalls and service records.";
    expect(longWhy.length).toBeGreaterThan(400);
    const ok = validateFindAgentVerdict({
      summary: "Camry fits.",
      confidence: "high",
      picks: [
        {
          vin: "1HGCM82633A004352",
          label: "Camry",
          action: "buy",
          offerUsd: 11_500,
          why: longWhy,
        },
      ],
      relaxedConditions: [],
      passReason: null,
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.verdict.picks[0]?.why).toBe(longWhy);
    expect(ok.verdict.picks[0]?.why.length).toBeGreaterThan(400);
    const clipped = clipBuyerText(ok.verdict.picks[0]!.why, 400);
    expect(clipped.length).toBeLessThan(longWhy.length);
    expect(clipped.endsWith("…") || /[.!?]$/.test(clipped)).toBe(true);
    // Word-boundary clip — never a hard mid-word cut like "failure r."
    expect(clipped).not.toMatch(/\b\w\.$/);
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

  it("submit_picks rejects pass-only picks, but submit_nothing_fits accepts reasoned rejections", () => {
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

    const reasonedNothingFits = validateFindSubmitPicks(
      {
        summary: "No candidate met all hard requirements.",
        confidence: "low",
        picks: [{ vin, label: "Camry", action: "pass", offerUsd: null, why: "FWD; the brief requires AWD." }],
        relaxedConditions: [],
        passReason: "The only returned candidate is FWD, while AWD is mandatory.",
      },
      {
        listingsByVin: listings,
        budgetUsd: 15_000,
        searches: [{ params: { zip: "80202", radiusMi: 75 }, resultCount: 1 }],
        allowPassOnly: true,
      },
    );
    expect(reasonedNothingFits.ok).toBe(true);

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
