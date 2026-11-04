import type { SavedSearch } from "./radar-watch";
import { DEMO_USER_ID } from "./radar-watch";

/**
 * Two shared preview searches.
 * Chosen as high-volume used models in a large metro so one Auto.dev page can return rows.
 * Live matches still depend on the listings key and whatever is actually listed.
 */
export function demoPresets(now = "2026-11-04T00:00:00.000Z"): SavedSearch[] {
  return [
    {
      id: "preset-personal-rav4",
      ownerId: DEMO_USER_ID,
      name: "Family SUV near Miami",
      mode: "personal",
      preset: true,
      enabled: true,
      createdAt: now,
      lastCheckedAt: null,
      criteria: {
        make: "Toyota",
        model: "RAV4",
        bodyStyle: "SUV",
        yearMin: 2014,
        yearMax: 2019,
        priceMax: 18_000,
        zip: "33101",
        radiusMiles: 50,
        milesMax: 120_000,
        priorities: ["reliability", "low cost of ownership"],
      },
    },
    {
      id: "preset-flip-civic",
      ownerId: DEMO_USER_ID,
      name: "Local Civic buy box",
      mode: "flip",
      preset: true,
      enabled: true,
      createdAt: now,
      lastCheckedAt: null,
      criteria: {
        make: "Honda",
        model: "Civic",
        yearMin: 2012,
        yearMax: 2018,
        priceMax: 12_000,
        zip: "33101",
        radiusMiles: 50,
        milesMax: 140_000,
        minProfitUsd: 1_500,
        priorities: ["local resale", "minor repairs"],
      },
    },
  ];
}
