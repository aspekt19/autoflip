import type { SavedSearch } from "./radar-watch";
import { canonicalCriteria, DEMO_USER_ID } from "./radar-watch";

/**
 * Two shared preview searches around Miami.
 * The ranges are wide enough that one price-sorted page of 20 includes both ordinary asking
 * prices and cheaper cars. A tight cap (2014–2019 RAV4 ≤ $18k, or a Civic ≤ $12k) came back
 * full and then failed every row: the SUV body string was not exactly "SUV", and a Civic page
 * clustered under $12k cannot clear a $1,500 margin after fees.
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
        yearMin: 2012,
        yearMax: 2020,
        priceMax: 24_000,
        zip: "33101",
        radiusMiles: 100,
        milesMax: 150_000,
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
        yearMin: 2008,
        yearMax: 2018,
        priceMax: 16_000,
        zip: "33101",
        radiusMiles: 100,
        milesMax: 180_000,
        minProfitUsd: 1_500,
        priorities: ["local resale", "minor repairs"],
      },
    },
  ];
}

/** Replace stored preset criteria when this file changes. Custom searches are left alone. */
export function syncPresetSearches(existing: SavedSearch[], nowIso: string): { searches: SavedSearch[]; changed: boolean } {
  const presets = demoPresets(nowIso);
  let changed = false;
  const searches = existing.map((item) => {
    const preset = presets.find((candidate) => candidate.id === item.id);
    if (!preset || !item.preset) return item;
    const same =
      item.mode === preset.mode &&
      item.name === preset.name &&
      canonicalCriteria(item.criteria) === canonicalCriteria(preset.criteria);
    if (same) return item;
    changed = true;
    return { ...item, name: preset.name, mode: preset.mode, criteria: preset.criteria, lastCheckedAt: null };
  });
  for (const preset of presets) {
    if (!searches.some((item) => item.id === preset.id)) {
      searches.push(preset);
      changed = true;
    }
  }
  return { searches, changed };
}
