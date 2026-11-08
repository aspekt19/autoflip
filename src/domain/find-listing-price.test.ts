import { describe, expect, it } from "vitest";
import { admitFindListingForBudget, assessFindListingPrice, askingPriceSafeToState } from "./find-listing-price";

/** Owner t303/t306 RAV4 — feed $587 matched Joe Machens Admin Fee, not the $32,823 ask. */
const RAV4_FEE_CARD = {
  vin: "2T3N1RFV6MC246998",
  year: 2021,
  make: "Toyota",
  model: "RAV4",
  priceUsd: 587,
  askingPriceKind: "unknown" as const,
  askingPriceProvenance: "feed_only" as const,
};

describe("find listing price semantics (failure-first)", () => {
  it("does not treat the RAV4 $587 feed figure as a verified ask or budget match", () => {
    const view = assessFindListingPrice(RAV4_FEE_CARD);
    expect(view.usableForBudget).toBe(false);
    expect(view.trust).toBe("suspect");
    expect(view.displayPrimary).toMatch(/unclear/i);
    expect(view.displayPrimary).not.toMatch(/\$587/);
    expect(view.displayDetail).toMatch(/587/);
    expect(view.displayDetail).toMatch(/unproven/i);
    expect(view.displayDetail).not.toMatch(/\bis a (monthly )?payment\b/i);
    // Never invent the real dealer ask.
    expect(view.displayDetail).not.toMatch(/32,?823|33,?410/);
    expect(askingPriceSafeToState(587, 2021)).toBe(false);

    const admission = admitFindListingForBudget(RAV4_FEE_CARD, 20_000, true);
    expect(admission.admit).toBe(false);
    if (admission.admit) return;
    expect(admission.reason).toBe("untrusted_price");
  });

  it("does not invent dealer_fee kind from magnitude alone", () => {
    const view = assessFindListingPrice(RAV4_FEE_CARD);
    expect(view.assessment.kind).toBe("unknown");
    expect(view.assessment.ambiguity === "fee_vs_purchase" || view.assessment.ambiguity === "source_unverified").toBe(
      true,
    );
  });

  it("keeps a credible seller-claim ask usable for budget without calling it verified sold", () => {
    const view = assessFindListingPrice({
      year: 2019,
      priceUsd: 18_500,
      askingPriceKind: "unknown",
      askingPriceProvenance: "feed_only",
    });
    expect(view.usableForBudget).toBe(true);
    expect(view.trust).toBe("usable_seller_claim");
    expect(view.displayPrimary).toBe("$18,500");
    const admission = admitFindListingForBudget(
      { year: 2019, priceUsd: 18_500 },
      20_000,
      true,
    );
    expect(admission.admit).toBe(true);
    if (!admission.admit) return;
    expect(admission.overBudget).toBe(false);
  });

  it("still rejects a real over-budget ask when the figure is usable", () => {
    const admission = admitFindListingForBudget(
      { year: 2021, priceUsd: 32_823 },
      20_000,
      true,
    );
    expect(admission.admit).toBe(false);
    if (admission.admit) return;
    expect(admission.reason).toBe("over_budget");
  });

  it("honors an explicit seller-page fee label even above year floors", () => {
    const view = assessFindListingPrice({
      year: 2024,
      priceUsd: 8_000,
      askingPriceKind: "dealer_fee",
      askingPriceProvenance: "seller_page_labeled",
      askingPriceLabel: "Admin Fee",
    });
    expect(view.usableForBudget).toBe(false);
    expect(view.assessment.status).toBe("known_non_purchase");
    expect(view.displayDetail).toMatch(/Admin Fee/);
  });
});
