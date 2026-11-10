import { describe, expect, it, vi } from "vitest";
import { journalFromRadarActivity } from "@/domain/radar-activity-journal";
import type { Listing } from "@/domain/types";
import type { AlertNumbers } from "@/domain/radar-watch";
import type { PriceBadge } from "@/domain/price-badge";
import { radarVerdictFacts, reviewPersonalCandidate } from "./radar-serv";

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

  it("records historyOnListing honestly when accident/owner are null", () => {
    const facts = radarVerdictFacts({ listing, numbers, badge, budgetUsd: 18_000 });
    expect(facts.historyOnListing).toBe(false);
    expect(facts.recallsAvailable).toBe(false);
  });
});

describe("reviewPersonalCandidate failures", () => {
  it("does not alert on code price alone when SERV key is missing", async () => {
    const review = await reviewPersonalCandidate(
      {
        listing,
        numbers,
        badge,
        baseWhy: "Good price vs similar RAV4s.",
        budgetUsd: 18_000,
      },
      {
        fetchImpl: fetch,
        servKey: undefined,
        servModel: "gpt-5.4-mini",
        timeoutMs: 8_000,
        searchId: "search-1",
        challenge: false,
        nowIso: "2026-11-10T06:00:00.000Z",
      },
      [],
    );
    expect(review.alertWorthy).toBe(false);
    expect(review.proofRecords.some((row) => row.purpose === "verdict_decide" && row.status === "skipped")).toBe(
      true,
    );
  });

  it("journals real HTTP error text and never shows chatcmpl-<uuid> as response id", async () => {
    // Provenance: UUID-shaped error-body id recorded in eval/results/latest.json.
    const synthetic = "chatcmpl-aefd285d-ecdb-4c2f-b0cf-92490257a39c";
    const fetchImpl = vi.fn(async () =>
      Response.json(
        { id: synthetic, error: { message: "Invalid schema for response_format", type: "invalid_request_error" } },
        { status: 400 },
      ),
    );
    const review = await reviewPersonalCandidate(
      {
        listing,
        numbers,
        badge,
        baseWhy: "Good price vs similar RAV4s.",
        budgetUsd: 18_000,
      },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        servKey: "test-key",
        servModel: "gpt-5.4-mini",
        timeoutMs: 8_000,
        searchId: "search-1",
        challenge: false,
        nowIso: "2026-11-10T06:00:00.000Z",
      },
      [],
    );
    expect(review.alertWorthy).toBe(false);
    expect(review.activity[0]?.ok).toBe(false);
    expect(review.activity[0]?.decision).toBe("http_error");
    expect(review.activity[0]?.note).toMatch(/SERV HTTP 400/i);
    expect(review.activity[0]?.responseId).toBeNull();
    const journal = journalFromRadarActivity(review.activity);
    expect(journal.steps[0]?.responseId).toBeNull();
    expect(journal.steps[0]?.why).toMatch(/SERV HTTP 400/i);
    expect(journal.steps[0]?.why).not.toMatch(/Agent call failed\.?$/);
  });
});
