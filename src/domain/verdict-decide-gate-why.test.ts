import { describe, expect, it } from "vitest";
import { decideWhyWithGateResult } from "./verdict-decide";
import type { OrderedGateRun } from "./verdict-gates";

describe("decideWhyWithGateResult", () => {
  it("appends the real mandate gate reason when SERV only says mandate", () => {
    const gateRun: OrderedGateRun = {
      gates: [
        {
          id: "mandate_fit",
          status: "forbid",
          reason: "Conservative flip margin is below the profit target of $1,200. Buy is forbidden.",
          forbid: ["buy"],
        },
      ],
      withheld: false,
      withholdReason: null,
      forbid: ["buy"],
      forcePass: false,
    };
    const why = decideWhyWithGateResult({
      note: "Buy is forbidden by the mandate",
      gateRun,
    });
    expect(why).toContain("Buy is forbidden by the mandate");
    expect(why).toContain("Gate result:");
    expect(why).toContain("profit target of $1,200");
  });

  it("does not duplicate when the note already includes the gate reason", () => {
    const reason = "Conservative flip margin is below the profit target of $1,200. Buy is forbidden.";
    const gateRun: OrderedGateRun = {
      gates: [{ id: "mandate_fit", status: "forbid", reason, forbid: ["buy"] }],
      withheld: false,
      withholdReason: null,
      forbid: ["buy"],
      forcePass: false,
    };
    const why = decideWhyWithGateResult({ note: reason, gateRun });
    expect(why).toBe(reason);
  });
});
