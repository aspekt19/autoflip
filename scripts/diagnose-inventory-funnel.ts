/**
 * Reproduce Auto.dev inventory queries for published zero-result runs and count
 * listings after each filter step.
 *
 * Usage:
 *   AUTODEV_API_KEY=… npx tsx scripts/diagnose-inventory-funnel.ts
 *
 * Never prints the API key. When the key is missing, prints reconstructed URLs
 * and a fixture-backed Sedan-vs-Car funnel only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listingsSearchUrl, autodevSearch } from "../src/io/autodev";
import { TtlCache } from "../src/io/cache";
import { MemoryCounter } from "../src/io/quota";
import { providerBodyStyleParam } from "../src/domain/body-style";
import { isPassengerOrLightTruck } from "../src/domain/passenger-vehicle";
import { postFilterFlipInventory } from "../src/domain/resale-sanity";
import { buildSearchSpec, enforceHard } from "../src/domain/search-spec";
import { admitFindListingForBudget } from "../src/domain/find-listing-price";
import type { Listing } from "../src/domain/types";
import type { ListingQuery } from "../src/io/marketcheck";

type Step = { name: string; count: number; note?: string };

function loadEnvFile(path: string): void {
  try {
    const text = readFileSync(path, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (!(key in process.env) || !process.env[key]) process.env[key] = value;
    }
  } catch {
    /* optional */
  }
}

function funnelFind(listings: readonly Listing[], budgetUsd: number, radiusMi: number): Step[] {
  const steps: Step[] = [{ name: "provider_normalized", count: listings.length }];
  const passenger = listings.filter((row) => isPassengerOrLightTruck(row));
  steps.push({ name: "passenger_or_light_truck", count: passenger.length });
  const spec = buildSearchSpec({
    note: "",
    mode: "personal",
    formEdits: {
      priceMaxUsd: { value: budgetUsd, dirty: true },
      radiusMi: { value: radiusMi, dirty: true },
    },
  });
  const hard = enforceHard(spec, passenger);
  steps.push({
    name: "enforceHard",
    count: hard.kept.length,
    note: hard.dropped.length
      ? [...new Set(hard.dropped.map((d) => d.rule))].join(",")
      : undefined,
  });
  const budgeted = hard.kept.filter((item) => admitFindListingForBudget(item, budgetUsd, true).admit);
  steps.push({ name: "admitFindListingForBudget(+5%)", count: budgeted.length });
  return steps;
}

function funnelFlip(listings: readonly Listing[], budgetUsd: number, radiusMi: number): Step[] {
  const steps: Step[] = [{ name: "provider_normalized", count: listings.length }];
  const post = postFilterFlipInventory(listings, {
    priceMax: budgetUsd,
    milesMax: null,
    distanceMiles: radiusMi,
  });
  steps.push({ name: "postFilterFlipInventory", count: post.length });
  return steps;
}

function printSteps(label: string, url: string, steps: Step[]): void {
  console.log(`\n## ${label}`);
  console.log(`url: ${url}`);
  for (const step of steps) {
    const note = step.note ? ` (${step.note})` : "";
    console.log(`  ${step.count}\t${step.name}${note}`);
  }
}

async function liveQuery(query: ListingQuery, apiKey: string): Promise<Listing[]> {
  const result = await autodevSearch(query, {
    fetch,
    cache: new TtlCache(),
    counter: new MemoryCounter(),
    apiKey,
    bypassCache: true,
    timeoutMs: 20_000,
  });
  if (!result.ok) {
    console.error(`upstream ${result.error}: ${result.message}`);
    return [];
  }
  return result.listings;
}

function fixtureSedanFunnel(): void {
  const raw = JSON.parse(readFileSync(join(process.cwd(), "fixtures/autodev-camry.json"), "utf8")) as {
    data: Array<{ vehicle: { bodyStyle?: string; style?: string; transmission?: string } }>;
  };
  const rows = raw.data;
  const asSedan = rows.filter((row) => String(row.vehicle.bodyStyle).toLowerCase() === "sedan");
  const asCar = rows.filter((row) => String(row.vehicle.bodyStyle).toLowerCase() === "car");
  console.log("\n## Fixture funnel (autodev-camry.json) — proves Sedan provider filter");
  console.log(`  ${rows.length}\traw_rows`);
  console.log(`  ${asSedan.length}\tafter vehicle.bodyStyle===Sedan`);
  console.log(`  ${asCar.length}\tafter vehicle.bodyStyle===Car`);
  console.log(`  providerBodyStyleParam(Sedan)=${String(providerBodyStyleParam("Sedan"))}`);
  console.log(`  sample transmission=${rows[0]?.vehicle.transmission ?? "missing"}`);
}

async function main(): Promise<void> {
  loadEnvFile(join(process.cwd(), ".env"));
  loadEnvFile(join(process.cwd(), ".env.local"));
  const apiKey = process.env.AUTODEV_API_KEY?.trim() ?? "";
  console.log("Inventory funnel diagnosis");
  console.log(`AUTODEV_API_KEY: ${apiKey ? "set" : "missing"}`);
  fixtureSedanFunnel();

  const columbusModels = [
    { make: "Toyota", model: "Corolla" },
    { make: "Honda", model: "Civic" },
    { make: "Toyota", model: "Camry" },
    { make: "Honda", model: "Accord" },
    { make: "Toyota", model: "Prius" },
  ];
  const dallasModels = [
    { make: "Honda", model: "Civic" },
    { make: "Toyota", model: "Corolla" },
    { make: "Nissan", model: "Sentra" },
    { make: "Mazda", model: "Mazda3" },
  ];

  console.log("\n## Reconstructed provider URLs (Sedan was the pre-fix plan body)");
  for (const m of columbusModels.slice(0, 2)) {
    const bad = new URL("https://api.auto.dev/listings");
    bad.searchParams.set("vehicle.make", m.make);
    bad.searchParams.set("vehicle.model", m.model);
    bad.searchParams.set("vehicle.bodyStyle", "Sedan");
    bad.searchParams.set("retailListing.price", "1-11550");
    bad.searchParams.set("zip", "43215");
    bad.searchParams.set("distance", "100");
    bad.searchParams.set("limit", "20");
    console.log(" Columbus raw Sedan:", bad.toString());
    console.log(
      " Columbus after map:",
      listingsSearchUrl({
        make: m.make,
        model: m.model,
        bodyStyle: "Sedan",
        priceRange: "1-11550",
        zip: "43215",
        distanceMiles: 100,
        limit: 20,
      }),
    );
  }

  if (!apiKey) {
    console.log("\nLive Auto.dev calls skipped — set AUTODEV_API_KEY to count remaining after each filter.");
    return;
  }

  for (const m of columbusModels) {
    const query: ListingQuery = {
      make: m.make,
      model: m.model,
      priceRange: "1-11550",
      zip: "43215",
      distanceMiles: 100,
      limit: 20,
    };
    const withSedanRaw = { ...query, bodyStyle: "Sedan" as const };
    // Bypass mapper by calling API with raw Sedan for A/B (manual URL).
    const badUrl = `${process.env.AUTODEV_BASE_URL?.replace(/\/$/, "") || "https://api.auto.dev"}/listings?${new URLSearchParams({
      "vehicle.make": m.make,
      "vehicle.model": m.model,
      "vehicle.bodyStyle": "Sedan",
      "retailListing.price": "1-11550",
      zip: "43215",
      distance: "100",
      limit: "20",
    }).toString()}`;
    const badRes = await fetch(badUrl, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    const badJson = badRes.ok ? ((await badRes.json()) as { data?: unknown[] }) : { data: [] };
    const badCount = Array.isArray(badJson.data) ? badJson.data.length : 0;
    const listings = await liveQuery(withSedanRaw, apiKey);
    printSteps(
      `Columbus ${m.make} ${m.model}`,
      listingsSearchUrl(withSedanRaw),
      [
        { name: "provider_raw_bodyStyle=Sedan", count: badCount },
        ...funnelFind(listings, 11_000, 100),
      ],
    );
  }

  for (const m of dallasModels) {
    const query: ListingQuery = {
      make: m.make,
      model: m.model,
      priceRange: "1-8400",
      milesRange: "0-180000",
      zip: "75201",
      distanceMiles: 100,
      sort: "price.asc",
      limit: 20,
    };
    const listings = await liveQuery(query, apiKey);
    printSteps(`Dallas flip ${m.make} ${m.model}`, listingsSearchUrl(query), funnelFlip(listings, 8_000, 100));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
