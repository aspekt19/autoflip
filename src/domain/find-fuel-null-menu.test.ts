/**
 * Regression: FuelEconomy.gov returns JSON literal `null` for empty option menus
 * (e.g. model=CR-V). That must be treated as empty+available so alias resolution runs.
 * Fixtures recorded from the live public API on the agent VM (see fixtures/fueleconomy/*).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lookupFindFuelEvidence } from "./find-fuel-match";

const FIX = join(process.cwd(), "fixtures/fueleconomy");

function loadRaw(name: string): string {
  return readFileSync(join(FIX, name), "utf8");
}

function loadJson(name: string): unknown {
  return JSON.parse(loadRaw(name));
}

function fixtureFetch(routes: Array<{ match: (url: string) => boolean; body: string }>): typeof fetch {
  return async (input) => {
    const url = String(input);
    for (const route of routes) {
      if (route.match(url)) {
        return new Response(route.body, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response("null", { status: 200, headers: { "Content-Type": "application/json" } });
  };
}

describe("FuelEconomy.gov null menu → alias match (recorded live responses)", () => {
  const prices = loadRaw("fuelprices.json");

  it("CR-V 2018: exact options null, then CR-V AWD/FWD match", async () => {
    const modelParam = (u: string) => {
      try {
        return new URL(u).searchParams.get("model");
      } catch {
        return null;
      }
    };
    const fetchImpl = fixtureFetch([
      {
        match: (u) => u.includes("/menu/options") && modelParam(u) === "CR-V",
        body: loadRaw("crv-2018-options-exact.json"), // literal null
      },
      {
        match: (u) => u.includes("/menu/model") && u.includes("make=Honda"),
        body: loadRaw("crv-2018-models.json"),
      },
      {
        match: (u) => u.includes("/menu/options") && modelParam(u) === "CR-V AWD",
        body: loadRaw("crv-2018-options-CR-V-AWD.json"),
      },
      {
        match: (u) => u.includes("/menu/options") && modelParam(u) === "CR-V FWD",
        body: loadRaw("crv-2018-options-CR-V-FWD.json"),
      },
      { match: (u) => u.endsWith("/39628"), body: loadRaw("crv-2018-vehicle-39628.json") },
      { match: (u) => u.endsWith("/39629"), body: loadRaw("crv-2018-vehicle-39629.json") },
      { match: (u) => u.endsWith("/39624"), body: loadRaw("crv-2018-vehicle-39624.json") },
      { match: (u) => u.endsWith("/39625"), body: loadRaw("crv-2018-vehicle-39625.json") },
      { match: (u) => u.includes("/fuelprices"), body: prices },
    ]);
    const evidence = await lookupFindFuelEvidence(
      { year: 2018, make: "Honda", model: "CR-V" },
      { deps: { fetch: fetchImpl }, note: "Mostly city driving" },
    );
    expect(evidence.match).not.toBe("unavailable");
    expect(evidence.match).not.toBe("no_match");
    expect(evidence.annualFuelUsdLow).toBeGreaterThan(0);
    expect(evidence.modelNamesTried.some((n) => /CR-V/i.test(n))).toBe(true);
  });

  it("Tucson / Sportage / CX-5 / Camry recorded fixtures match (not unavailable)", async () => {
    const cases: Array<{
      year: number;
      make: string;
      model: string;
      slug: string;
      exactNull: boolean;
    }> = [
      { year: 2018, make: "Hyundai", model: "Tucson", slug: "tucson-2018", exactNull: true },
      { year: 2015, make: "Kia", model: "Sportage", slug: "sportage-2015", exactNull: true },
      { year: 2014, make: "Mazda", model: "CX-5", slug: "cx5-2014", exactNull: true },
      { year: 2012, make: "Toyota", model: "Camry", slug: "camry-2012", exactNull: false },
    ];

    for (const c of cases) {
      const manifest = loadJson("live-match-manifest.json") as Array<{
        slug: string;
        aliases: string[];
        vehicleIds: number[];
      }>;
      const row = manifest.find((m) => m.slug === c.slug)!;
      expect(row).toBeTruthy();

      const modelParam = (u: string) => {
        try {
          return new URL(u).searchParams.get("model");
        } catch {
          return null;
        }
      };
      const fetchImpl = fixtureFetch([
        {
          match: (u) => u.includes("/menu/options") && modelParam(u) === c.model,
          body: c.exactNull ? "null" : loadRaw(`${c.slug}-options-exact.json`),
        },
        {
          match: (u) => u.includes("/menu/model") && u.includes(`make=${c.make}`),
          body: loadRaw(`${c.slug}-models.json`),
        },
        ...row.aliases
          .filter((alias) => alias !== c.model)
          .flatMap((alias) => {
            const safe = alias.replace(/ /g, "-").replace(/\//g, "-");
            return [
              {
                match: (u: string) => u.includes("/menu/options") && modelParam(u) === alias,
                body: loadRaw(`${c.slug}-options-${safe}.json`),
              },
            ];
          }),
        ...row.vehicleIds.map((id) => ({
          match: (u: string) => u.endsWith(`/${id}`),
          body: loadRaw(`${c.slug}-vehicle-${id}.json`),
        })),
        { match: (u: string) => u.includes("/fuelprices"), body: prices },
      ]);

      const evidence = await lookupFindFuelEvidence(
        { year: c.year, make: c.make, model: c.model },
        { deps: { fetch: fetchImpl }, note: "Mostly city driving" },
      );
      expect(evidence.match, `${c.make} ${c.model}`).not.toBe("unavailable");
      expect(evidence.match, `${c.make} ${c.model}`).not.toBe("no_match");
      expect(evidence.annualFuelUsdLow, `${c.make} ${c.model}`).toBeGreaterThan(0);
    }
  });

  it("does NOT claim unavailable when options body is JSON null (empty menu)", async () => {
    // Minimal path: null options → model menu empty → no_match (not unavailable).
    const fetchImpl = fixtureFetch([
      { match: (u) => u.includes("/menu/options"), body: "null" },
      {
        match: (u) => u.includes("/menu/model"),
        body: JSON.stringify({ menuItem: [{ text: "Other", value: "Other" }] }),
      },
      { match: (u) => u.includes("/fuelprices"), body: prices },
    ]);
    const evidence = await lookupFindFuelEvidence(
      { year: 2018, make: "Honda", model: "CR-V" },
      { deps: { fetch: fetchImpl } },
    );
    expect(evidence.match).toBe("no_match");
    expect(evidence.honesty).not.toMatch(/did not respond|timed out/i);
  });
});
