import { describe, expect, it } from "vitest";
import { decideAfFlowRestore } from "./af-flow-session";

describe("af-flow session restore (Stage2A)", () => {
  it("never forces sample:true → sample:false", () => {
    const d = decideAfFlowRestore({
      v: 2,
      sample: true,
      groups: [{ listings: [{ source: "sample" }] }],
    });
    expect(d.action).toBe("apply");
    if (d.action === "apply") expect(d.sample).toBe(true);
  });

  it("drops legacy phantom-live (sample:false + sample rows, no v)", () => {
    const d = decideAfFlowRestore({
      sample: false,
      groups: [{ listings: [{ source: "sample" }, { source: "autodev" }] }],
    });
    expect(d.action).toBe("drop_results");
    if (d.action === "drop_results") expect(d.clearPhantomLive).toBe(true);
  });

  it("keeps live autodev restore without sample flag", () => {
    const d = decideAfFlowRestore({
      v: 2,
      sample: false,
      groups: [{ listings: [{ source: "autodev" }] }],
    });
    expect(d.action).toBe("apply");
    if (d.action === "apply") {
      expect(d.sample).toBe(false);
      expect(d.warnUnknownSource).toBe(false);
    }
  });

  it("warns on unknown source without claiming live", () => {
    const d = decideAfFlowRestore({
      v: 2,
      sample: false,
      groups: [{ listings: [{ source: "mystery" }] }],
    });
    expect(d.action).toBe("apply");
    if (d.action === "apply") expect(d.warnUnknownSource).toBe(true);
  });
});
