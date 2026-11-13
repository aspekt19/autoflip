import { describe, expect, it } from "vitest";
import { criterionWinner, decisionRequestBody, parseSnapshotDecision } from "./live-decide";
import type { SearchSnapshot } from "./types";

const snapshot: SearchSnapshot = {
  id: "test",
  capturedAt: "2026-11-13T00:00:00.000Z",
  note: "AWD SUV near 80202",
  buyerZip: "80202",
  radiusMi: 75,
  budgetUsd: 22000,
  hardConstraints: [{ key: "history", value: "No accident or salvage history" }],
  candidates: [],
  evidence: [],
  criteria: [],
};

describe("snapshot decision request", () => {
  it("uses the bare model when features are off and the kronos-multipath model when they are on", () => {
    const off = decisionRequestBody({ snapshot, servVerdictFeatures: "off" });
    const on = decisionRequestBody({ snapshot, servVerdictFeatures: "on" });
    expect(String(off.model)).not.toMatch(/kronos|multipath/);
    expect(String(on.model)).toMatch(/kronos-multipath/);
    expect(JSON.stringify(off.input)).toContain("80202");
    expect(JSON.stringify(off.input)).not.toContain("no_accident_primary");
  });

  it("parses submit_picks and ignores serv_ marker tools", () => {
    const decision = parseSnapshotDecision(
      {
        id: "resp_test",
        output: [
          { type: "function_call", name: "serv_shadow_agent", call_id: "c0", arguments: "{}" },
          {
            type: "function_call",
            name: "submit_picks",
            call_id: "c1",
            arguments: JSON.stringify({
              primaryVin: "abc123",
              nothingFits: false,
              nearMissVins: ["zzz"],
              openingOffer: 18000,
              walkAway: 19000,
              why: "Opening offer $18,000.",
            }),
          },
        ],
      },
      "on",
    );
    expect(decision?.primaryVin).toBe("ABC123");
    expect(decision?.openingOffer).toBe(18000);
    expect(decision?.walkAway).toBe(19000);
    expect(criterionWinner(true, true)).toBe("tie");
    expect(criterionWinner(true, false)).toBe("features_off");
    expect(criterionWinner(false, false)).toBe("neither");
  });
});
