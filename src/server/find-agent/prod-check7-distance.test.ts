import { describe, expect, it } from "vitest";
import { TtlCache } from "@/io/cache";
import { MemoryCounter } from "@/io/quota";
import { buyerDistanceText } from "@/domain/geo";
import { centroidForZip } from "@/domain/data/zip-centroids";
import { mapFindAgentLoopToDecide } from "./map-to-decide";
import { createFindAgentToolState, executeFindAgentTool } from "./tools";

/**
 * Prod check 7 (run be89768a, 2026-11-28 12:53 Europe/Kirov) still showed
 * "distance unknown" on three shortlisted Sentras after the Census ZCTA fix
 * in PR #243. Evidence from the persisted sessions (not a guess):
 *
 * - Check 6 session 77e4760f… (12:17) offerPool[39] for VIN 3N1AB8CV1SY362757
 *   already had zip 75042, city Garland, lat 32.90977, lon -96.688515, but
 *   distanceMiles was null and radiusCheck was missing. So the listing was
 *   stored without going through enrich+stamp.
 * - Check 7 session e4b5d6d3… (12:53) ranked the same three cars with city/state
 *   only, distanceMiles null, radiusCheck unverified. None of the three were
 *   in the 40-row offerPool, so the UI could not recover a pool distance.
 * - Prod logs for that run show a late 75201 zip lookup plus a Sentra 2025
 *   search count=15 and Elantra 2025 count=5 — the get_market_comps path
 *   (autodevSearch, one call), which remembered raw provider rows and skipped
 *   enrichFindListingDistances. search_listings already enriched; this path
 *   did not, which is why the ZCTA table never reached these cards.
 */

const CENTER = centroidForZip("75201")!;
const WINNER = "3N1AB8CVXSY210038";
const GARLAND_20791 = "3N1AB8CV1SY362757";
const GARLAND_48119 = "3N1AB8CV5SY312167";
const RICHARDSON_9354 = "3N1AB8CV7SY400105";

function autodevZip(zip: string, city: string, state: string, latitude: number, longitude: number): Response {
  return new Response(
    JSON.stringify({ success: true, payload: { zip, city, state, latitude, longitude } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function censusPoint(latitude: number, longitude: number): Response {
  return new Response(
    JSON.stringify({ result: { addressMatches: [{ coordinates: { x: longitude, y: latitude } }] } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("prod check 7 distance path", () => {
  it("enriches the exact shortlist rows when they arrive through get_market_comps", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/zip/75201")) {
        return autodevZip("75201", "Dallas", "TX", CENTER.latitude, CENTER.longitude);
      }
      if (url.includes("geocoding.geo.census.gov")) {
        if (/Garland/i.test(url)) {
          const point = centroidForZip("75042")!;
          return censusPoint(point.latitude, point.longitude);
        }
        if (/Richardson/i.test(url)) {
          const point = centroidForZip("75081")!;
          return censusPoint(point.latitude, point.longitude);
        }
        return new Response(JSON.stringify({ result: { addressMatches: [] } }), { status: 200 });
      }
      if (url.includes("listings")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                vin: GARLAND_20791,
                vehicle: { year: 2025, make: "Nissan", model: "Sentra", vin: GARLAND_20791, drivetrain: "FWD" },
                retailListing: {
                  price: 13995,
                  miles: 20791,
                  city: "Garland",
                  state: "TX",
                  zip: "75042",
                  dealer: "Auto One Motors LLC",
                  vdp: "https://www.txcarcredit.com/details/used-2025-nissan-sentra/133475389",
                },
                // Check-6 persisted listing had these coordinates, not [0,0].
                location: [-96.688515, 32.90977],
              },
              {
                vin: GARLAND_48119,
                vehicle: { year: 2025, make: "Nissan", model: "Sentra", vin: GARLAND_48119, drivetrain: "FWD" },
                retailListing: {
                  price: 13995,
                  miles: 48119,
                  city: "Garland",
                  state: "TX",
                  dealer: "Stars Auto Sale LLC",
                  vdp: "https://www.txcarcredit.com/details/used-2025-nissan-sentra/132906487",
                },
              },
              {
                vin: RICHARDSON_9354,
                vehicle: { year: 2025, make: "Nissan", model: "Sentra", vin: RICHARDSON_9354, drivetrain: "FWD" },
                retailListing: {
                  price: 14750,
                  miles: 9354,
                  city: "Richardson",
                  state: "TX",
                  dealer: "KW Auto Sales",
                  vdp: "https://kwautosales.net/vdp/24521814/Used-2025-Nissan-Sentra-SV-for-sale-in-Richardson-TX-75081",
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    };

    const state = createFindAgentToolState();
    state.shopperFacts = { budgetUsd: 15_000, zip: "75201", radiusMi: 50 };
    state.briefConfirmed = true;
    const executed = await executeFindAgentTool(
      "get_market_comps",
      { make: "Nissan", model: "Sentra", yearMin: 2025, yearMax: 2025, priceMaxUsd: 15_000, zip: "75201", radiusMi: 50 },
      {
        fetch: fetchImpl,
        autodevKey: "test",
        autodev: { cache: new TtlCache<unknown>(), counter: new MemoryCounter() },
      },
      state,
    );
    expect(executed.ok).toBe(true);

    for (const vin of [GARLAND_20791, GARLAND_48119, RICHARDSON_9354]) {
      const listing = state.listingsByVin.get(vin);
      expect(listing, vin).toBeTruthy();
      expect(listing!.distanceMiles, vin).toEqual(expect.any(Number));
      expect(listing!.distanceMiles!, vin).toBeGreaterThan(0);
      expect(listing!.distanceMiles!, vin).toBeLessThan(50);
      expect(listing!.radiusCheck, vin).toBe("known");
      expect(
        buyerDistanceText({ distanceMiles: listing!.distanceMiles, radiusCheck: listing!.radiusCheck }),
        vin,
      ).toMatch(/mi away/);
      expect(
        buyerDistanceText({ distanceMiles: listing!.distanceMiles, radiusCheck: listing!.radiusCheck }),
        vin,
      ).not.toBe("distance unknown");
    }

    // The 20791 row already had usable coords+ZIP in the check-6 pool; miles
    // should match a buyer-center computation, ~10 mi like the Garland Elantra.
    const garland = state.listingsByVin.get(GARLAND_20791)!;
    expect(garland.distanceMiles).toBeGreaterThanOrEqual(8);
    expect(garland.distanceMiles).toBeLessThanOrEqual(14);

    const mapped = mapFindAgentLoopToDecide({
      agent: {
        ok: true,
        agentMode: "live",
        toolRounds: 13,
        verdictReached: true,
        relaxedConditions: [],
        journal: [],
        journalServCalls: 0,
        journalToolCalls: 0,
        servUsageTotal: null,
        carsFound: 3,
        passReason: null,
        featuresActive: [],
        featuresActivePerCall: [],
        featureRejections: [],
        servResponseIds: [],
        listingsByVin: state.listingsByVin,
        verdict: {
          picks: [],
          confidence: "medium",
          summary: "shortlist only",
          passReason: null,
          relaxedConditions: [],
        },
      } as never,
    });
    for (const vin of [GARLAND_20791, GARLAND_48119, RICHARDSON_9354]) {
      const card = mapped.bestDeal.allRanked.find((row) => row.key === vin);
      expect(card, vin).toBeTruthy();
      expect(card!.radiusCheck).toBe("known");
      expect(card!.distanceMiles).toEqual(expect.any(Number));
      expect(buyerDistanceText({ distanceMiles: card!.distanceMiles, radiusCheck: card!.radiusCheck })).not.toBe(
        "distance unknown",
      );
    }
  });
});
