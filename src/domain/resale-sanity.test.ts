import { describe, expect, it } from "vitest";
import { rankFlipCandidates } from "./flip-rank";
import { buildResaleCandidatePnl } from "./resale-pnl";
import { parseResaleSearchInput } from "./resale-search-input";
import { resaleSpecHash } from "@/server/resale-spec-cache";
import type { Listing } from "./types";

function car(partial: Partial<Listing> & Pick<Listing, "vin" | "priceUsd" | "year" | "miles">): Listing {
  return {
    make: "Honda",
    model: "Civic",
    trim: null,
    city: "Miami",
    state: "FL",
    zip: "33101",
    dealer: null,
    vdp: null,
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: false,
    accidentCount: 0,
    oneOwner: null,
    ownerCount: null,
    usageType: null,
    fuel: null,
    engine: null,
    drivetrain: null,
    bodyStyle: null,
    latitude: null,
    longitude: null,
    removedAt: null,
    source: "autodev",
    ...partial,
  };
}

const now = new Date("2026-11-12T00:00:00Z");

describe("resale sanity gates", () => {
  it("parses as-is and a 30-day sell window from the note without a profit target", () => {
    const parsed = parseResaleSearchInput({
      budgetUsd: 15_000,
      freeText: "buy as-is, sell within 30 days",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.input.asIs).toBe(true);
    expect(parsed.input.sellWithinDays).toBe(30);
    expect(parsed.input.targetProfitUsd).toBeNull();
    expect(resaleSpecHash(parsed.input)).toBe(resaleSpecHash({ ...parsed.input }));
  });

  it("keeps recon at 0 when as-is and flags days to sell past 30", () => {
    const peers = [70_000, 74_000, 78_000, 80_000, 82_000].map((miles, index) =>
      car({
        vin: `PEER000000000000${index}`,
        priceUsd: 11_000 + index * 200,
        year: 2016,
        miles,
        createdAt: "2026-09-01 00:00:00",
      }),
    );
    const slow = car({
      vin: "SLOW0000000000001",
      priceUsd: 9_400,
      year: 2016,
      miles: 76_000,
      createdAt: "2026-08-01 00:00:00",
    });
    const ranked = rankFlipCandidates([slow, ...peers], now, {
      asIs: true,
      sellWithinDays: 30,
      enforceSanity: true,
    });
    const pick = ranked.find((item) => item.vin === slow.vin);
    expect(pick?.excluded).toBe(false);
    expect((pick?.listing.miles ?? 0) <= 180_000).toBe(true);
    const pnl = pick ? buildResaleCandidatePnl(pick, { asIs: true, sellWithinDays: 30 }) : null;
    expect(pnl?.reconUsd).toBe(0);
    expect(pnl?.reconBasis).toMatch(/As-is/);
    expect(pnl?.sellWindowExceeded).toBe(true);
    expect(pnl?.sellWindowNote).toMatch(/past the 30-day window/);
    expect(pnl?.targetProfitUsd).toBeNull();
  });
});
