import { describe, expect, it } from "vitest";
import { radarVerdictFacts } from "./radar-serv";
import type { Listing } from "@/domain/types";
import type { AlertNumbers } from "@/domain/radar-watch";
import type { PriceBadge } from "@/domain/price-badge";

const listing = {
  vin: "4T1KZ1AK4MU060006",
  year: 2016,
  make: "Toyota",
  model: "RAV4",
  trim: null,
  priceUsd: 14_900,
  miles: 40_000,
  city: "Miami",
  state: "FL",
  zip: "33101",
  dealer: null,
  vdp: null,
  primaryImage: null,
  carfaxUrl: null,
  used: true,
  cpo: null,
  accidentCount: null,
  oneOwner: null,
  ownerCount: null,
  usageType: null,
  fuel: null,
  engine: null,
  drivetrain: null,
  bodyStyle: "SUV",
  latitude: null,
  longitude: null,
  removedAt: null,
  source: "autodev",
} satisfies Listing;

const numbers: AlertNumbers = {
  priceUsd: 14_900,
  fairValueUsd: 17_000,
  priceLabel: "Good price",
  medianUsd: 17_000,
  lowUsd: 16_000,
  highUsd: 18_000,
  gapUsd: 2_100,
  miles: 40_000,
  expectedMiles: 90_000,
  roughMarginUsd: null,
};

const badge: PriceBadge = {
  label: "Good price",
  tone: "good",
  deltaUsd: -2_100,
  deltaLabel: "$2,100 below the fair value of $17,000",
  fairValueUsd: 17_000,
  sampleSize: 3,
  sampleNote: "Compared with 3 similar RAV4 listings.",
};

describe("radarVerdictFacts", () => {
  it("exposes code-computed fair value and allows buy for good tone", () => {
    const facts = radarVerdictFacts({ listing, numbers, badge, budgetUsd: 18_000 });
    expect(facts.fairValueUsd).toBe(17_000);
    expect(facts.priceTone).toBe("good");
    expect(facts.allowedActions).toContain("buy");
    expect(facts.codeBaselineAction).toBe("buy");
  });

  it("does not allow buy for fair tone", () => {
    const fairBadge: PriceBadge = { ...badge, tone: "fair", label: "Fair price" };
    const facts = radarVerdictFacts({ listing, numbers, badge: fairBadge, budgetUsd: null });
    expect(facts.allowedActions).not.toContain("buy");
    expect(facts.allowedActions).toContain("negotiate");
  });
});
