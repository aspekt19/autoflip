import { describe, expect, it } from "vitest";
import { dispositionFor } from "./known-failures";
import { buyerHtmlForScan, I6_FORBIDDEN, priceCeil, sharedHardFields, yearWindow } from "./invariants";
import type { ObservedSpec } from "./types";

function spec(budget: number, note: string): ObservedSpec {
  const hard = { priceMaxUsd: { value: budget, source: "form" as const } };
  return {
    v: 1,
    hash: "h",
    mode: "personal",
    note,
    hard,
    enforced: { yearMin: null, yearMax: null, milesMax: null, priceMaxUsd: budget, zip: null, radiusMi: null },
  };
}

describe("golden invariants", () => {
  it("uses the documented 5% price ceiling", () => {
    expect(priceCeil(8000)).toBe(8400);
    expect(priceCeil(15000)).toBe(15750);
    expect(yearWindow("1990-2027")).toEqual({ lo: 1990, hi: 2027 });
    expect(yearWindow("2018")).toEqual({ lo: 2018, hi: 2018 });
  });

  it("treats a shared budget that is not in the new note as stale", () => {
    const shared = sharedHardFields(spec(20000, "SUV under $20,000"), spec(20000, "reliable first car about $8,000"), "reliable first car about $8,000", new Set(["zip", "radiusMi"]));
    expect(shared).toContain("priceMaxUsd");
  });

  it("keeps response ids out of the buyer scan", () => {
    const html = `<p>Pass</p><details class="technical-details"><p>chatcmpl-abc</p></details>`;
    expect(buyerHtmlForScan(html)).not.toMatch(I6_FORBIDDEN);
    expect(`<p>Pool empty</p>`).toMatch(I6_FORBIDDEN);
  });

  it("allowlists only the remaining recorded-inventory gap", () => {
    expect(dispositionFor("G1", [])).toBe("pass");
    expect(dispositionFor("G2", [])).toBe("pass");
    expect(dispositionFor("G4", ["G4.recon", "G4.days"])).toBe("known_failure");
    expect(dispositionFor("G4", ["G4.miles"])).toBe("unexpected");
    expect(dispositionFor("G3", ["I5"])).toBe("unexpected");
    expect(dispositionFor("G6", [])).toBe("pass");
    expect(dispositionFor("G8", [])).toBe("pass");
    expect(dispositionFor("G9", [])).toBe("pass");
  });
});
