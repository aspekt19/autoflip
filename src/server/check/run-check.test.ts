import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TtlCache } from "@/io/cache";
import { MemoryKv } from "@/io/kv";
import { MemoryCounter } from "@/io/quota";
import { runCheck } from "./run-check";

const FIXTURES = join(process.cwd(), "fixtures/listing-pages");

function govFetch(url: string, over: Record<string, string> = {}): Response {
  if (url.includes("DecodeVinValues")) {
    return new Response(
      JSON.stringify({
        Results: [
          {
            ErrorCode: "0",
            ModelYear: over.ModelYear ?? "2021",
            Make: over.Make ?? "TOYOTA",
            Model: over.Model ?? "Camry",
            Trim: over.Trim ?? "SE",
            FuelTypePrimary: over.FuelTypePrimary ?? "Gasoline",
          },
        ],
      }),
      { status: 200 },
    );
  }
  if (url.includes("recallsByVehicle") || url.includes("complaintsByVehicle")) {
    return new Response(JSON.stringify({ results: [], count: 0 }), { status: 200 });
  }
  if (url.includes("SafetyRatings")) {
    return new Response(JSON.stringify({ Results: [] }), { status: 200 });
  }
  if (url.includes("fueleconomy") || url.includes("fuel")) {
    return new Response(JSON.stringify({ menuItem: [] }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}

function camryComp(vin: string, price: number, miles: number, year = 2014) {
  return {
    vin,
    vehicle: { year, make: "Toyota", model: "Camry", trim: "LE" },
    retailListing: {
      price,
      miles,
      used: true,
      city: "Dallas",
      state: "TX",
      zip: "75201",
      vdp: `https://dealer.example/vdp/${vin}`,
    },
    history: { accidentCount: 0, oneOwner: true, ownerCount: 1 },
  };
}

describe("runCheck listing paste (no paid Autodev/SERV)", () => {
  it("builds a listing verdict from the dealer fixture HTML text", async () => {
    const html = readFileSync(join(FIXTURES, "dealer-jsonld.html"), "utf8");
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.auto.dev") || url.includes("auto.dev")) {
        return new Response(JSON.stringify({ data: [] }), { status: 404 });
      }
      return govFetch(url);
    });

    const result = await runCheck(
      { kind: "paste", text: html, url: "https://dealer.example/camry" },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.kind).toBe("listing");
    expect(result.result.vin).toBe("4T1KZ1AK4MU060006");
    expect(result.result.title).toMatch(/2021 Toyota Camry/);
    expect(result.result.confidence).toMatch(/High|Medium|Low/);
    expect(result.result.provenance.some((row) => row.field === "priceUsd" && row.value === 23990)).toBe(true);
    expect(result.result.unknown.length).toBeGreaterThan(0);
    expect(result.result.summary).not.toMatch(/\.\./);
  });

  it("builds a VIN dossier without ask/miles/ZIP", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => govFetch(String(input)));
    const result = await runCheck(
      { kind: "vin", vin: "4T1KZ1AK4MU060006" },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.kind).toBe("vin_dossier");
    expect(result.result.verdict).toBe("dossier");
    expect(result.result.vin).toBe("4T1KZ1AK4MU060006");
    expect(result.result.unknown.some((line) => /asking price/i.test(line))).toBe(true);
    expect(result.result.otdNeedsZip).toBe(false);
  });

  it("flags SOLD listings, avoids soft no-red-flag summary, and prefers vPIC fuel over Hybrid claim", async () => {
    const html = readFileSync(join(FIXTURES, "sold-schema-camry.html"), "utf8");
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.auto.dev") || url.includes("auto.dev")) {
        return new Response(JSON.stringify({ data: [] }), { status: 404 });
      }
      return govFetch(url, {
        ModelYear: "2014",
        Make: "TOYOTA",
        Model: "Camry",
        Trim: "LE",
        FuelTypePrimary: "Gasoline",
      });
    });

    const result = await runCheck(
      {
        kind: "paste",
        text: html,
        url: "https://www.autoboutiquetexas.com/vehicle-details/used-2014-toyota-camry-le-4t1bf1fk0eu848445",
      },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.redFlags.some((flag) => flag.id === "sold" && flag.level === "stop")).toBe(true);
    expect(result.result.summary).toMatch(/SOLD/i);
    expect(result.result.summary).not.toMatch(/No stop-level red flags/i);
    expect(result.result.summary).not.toMatch(/\.\./);
    expect(result.result.verdict).toBe("walk_away");
    expect(result.result.fields?.drivetrain.value).toBe("FWD");
    expect(result.result.fields?.sellerName.value).toBeNull();
    expect(result.result.fuelConflict).toMatch(/conflicts/i);
    expect(result.result.fields?.fuel.value).toMatch(/Gasoline/i);
    expect(result.result.fields?.fuel.source).toBe("vin_decode");
    expect(result.result.questions[0]).toMatch(/still for sale/i);
  });

  it("returns walk-away and top comps with adjustment + source when Autodev comps are mocked", async () => {
    const html = readFileSync(join(FIXTURES, "dealer-jsonld.html"), "utf8");
    const subjectVin = "4T1KZ1AK4MU060006";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.auto.dev/listings/") && url.includes(subjectVin)) {
        return Response.json(camryComp(subjectVin, 23_990, 28_450, 2021));
      }
      if (url.includes("api.auto.dev/listings") && url.includes("make=")) {
        return Response.json({
          data: [
            camryComp(subjectVin, 23_990, 28_450, 2021),
            camryComp("4T1KZ1AK4MU060001", 22_500, 30_000, 2021),
            camryComp("4T1KZ1AK4MU060002", 24_200, 27_000, 2020),
            camryComp("4T1KZ1AK4MU060003", 23_100, 32_000, 2021),
            camryComp("4T1KZ1AK4MU060004", 25_000, 26_000, 2022),
            camryComp("4T1KZ1AK4MU060005", 21_800, 35_000, 2020),
          ],
        });
      }
      return govFetch(url, { ModelYear: "2021", Make: "TOYOTA", Model: "Camry", Trim: "SE" });
    });

    const result = await runCheck(
      { kind: "paste", text: html, url: "https://dealer.example/camry", optionalZip: "33101" },
      {
        fetch: fetchImpl as unknown as typeof fetch,
        autodevKey: "test-key",
        autodev: { cache: new TtlCache(), counter: new MemoryCounter() },
        kv: new MemoryKv(),
        env: {},
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.walkAwayUsd).not.toBeNull();
    expect(result.result.walkAwayLabel).toMatch(/walk-away|asking price/i);
    expect(result.result.similarCars.length).toBeGreaterThan(0);
    const first = result.result.similarCars[0]!;
    expect(first.year).toBeGreaterThan(2015);
    expect(first.askingUsd).toBeGreaterThan(0);
    expect(first.adjustedUsd).toBeGreaterThan(0);
    expect(first.sourceUrl).toMatch(/^https:\/\//);
    expect(result.result.summary).not.toMatch(/\.\./);
  });

  it("auto-continues VIN dossier when listing fetch is blocked but URL contains a VIN", async () => {
    const vin = "4T1KZ1AK4MU060006";
    const publicLookup = async () => ["93.184.216.34"];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("blocked.example")) {
        return new Response("Access Denied", { status: 403 });
      }
      return govFetch(url);
    });
    const result = await runCheck(
      { kind: "link", url: `https://blocked.example/cars/${vin}` },
      { fetch: fetchImpl as unknown as typeof fetch, lookup: publicLookup },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.kind).toBe("vin_dossier");
    expect(result.result.vin).toBe(vin);
  });

  it("returns paste_text|enter_vin alternatives when fetch is blocked and no VIN is in the URL", async () => {
    const publicLookup = async () => ["93.184.216.34"];
    const fetchImpl = vi.fn(async () => new Response("Please verify you are a human", { status: 403 }));
    const result = await runCheck(
      { kind: "link", url: "https://blocked.example/cars/camry-no-vin" },
      { fetch: fetchImpl as unknown as typeof fetch, lookup: publicLookup },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("listing_fetch_blocked");
    expect(result.blocked).toBe(true);
    expect(result.alternatives).toEqual(["paste_text", "enter_vin"]);
    expect(result.creditCharged).toBe(false);
    expect(result.focusVin).toBe(true);
    expect(result.message).toMatch(/paste the listing text or enter the VIN/i);
    expect(result.message).toMatch(/No credit or free check was used/i);
  });

  it("surfaces cars.com / Autotrader listing ids from the URL when the page is walled", async () => {
    const publicLookup = async () => ["93.184.216.34"];
    const fetchImpl = vi.fn(async () => new Response("Access Denied", { status: 403 }));
    const cars = await runCheck(
      {
        kind: "link",
        url: "https://www.cars.com/vehicledetail/39a91db4-14e9-4a6e-82f5-34589631ba2d/",
      },
      { fetch: fetchImpl as unknown as typeof fetch, lookup: publicLookup },
    );
    expect(cars.ok).toBe(false);
    if (cars.ok) return;
    expect(cars.error).toBe("listing_fetch_blocked");
    expect(cars.creditCharged).toBe(false);
    expect(cars.urlHints?.listingId).toBe("39a91db4-14e9-4a6e-82f5-34589631ba2d");
    expect(cars.message).toMatch(/listing id 39a91db4/i);
    expect(cars.message).toMatch(/No credit or free check was used/i);

    const autotrader = await runCheck(
      { kind: "link", url: "https://www.autotrader.com/cars-for-sale/vehicle/756212296" },
      { fetch: fetchImpl as unknown as typeof fetch, lookup: publicLookup },
    );
    expect(autotrader.ok).toBe(false);
    if (autotrader.ok) return;
    expect(autotrader.urlHints?.listingId).toBe("756212296");
    expect(autotrader.message).toMatch(/listing id 756212296/i);
  });

  it("continues via Auto.dev when an exact VDP match exists after a walled fetch", async () => {
    const vin = "1M8GDM9AXKP042788";
    const vdp = "https://www.autotrader.com/cars-for-sale/vehicle/756212296";
    const publicLookup = async () => ["93.184.216.34"];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      // Match Auto.dev before the VDP host — the filter query embeds the VDP URL.
      if (url.includes("api.auto.dev/listings?") && url.includes("retailListing.vdp")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                vin,
                vehicle: { year: 2018, make: "Honda", model: "Civic", trim: "EX" },
                retailListing: {
                  price: 14_500,
                  miles: 42_000,
                  city: "Miami",
                  state: "FL",
                  zip: "33101",
                  used: true,
                  vdp,
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("api.auto.dev")) {
        return new Response(JSON.stringify({ data: [] }), { status: 404 });
      }
      if (url.includes("autotrader.com")) {
        return new Response("Please verify you are a human", { status: 403 });
      }
      return govFetch(url, { ModelYear: "2018", Make: "HONDA", Model: "Civic", Trim: "EX" });
    });
    const result = await runCheck(
      { kind: "link", url: vdp },
      {
        fetch: fetchImpl as unknown as typeof fetch,
        lookup: publicLookup,
        autodevKey: "test-key",
        autodev: { cache: new TtlCache<unknown>(60_000), counter: new MemoryCounter() },
        kv: new MemoryKv(),
        env: { VERCEL: undefined },
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.vin).toBe(vin);
    expect(result.result.fields?.priceUsd.value).toBe(14_500);
    expect(result.result.provenance.some((row) => row.source === "listing_feed")).toBe(true);
  });

  it("returns clear next steps when the page is thin and has no VIN", async () => {
    const publicLookup = async () => ["93.184.216.34"];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("thin.example")) {
        return new Response("<!doctype html><html><body><p>Welcome to our inventory portal.</p></body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return govFetch(url);
    });
    const result = await runCheck(
      { kind: "link", url: "https://thin.example/listing/abc" },
      { fetch: fetchImpl as unknown as typeof fetch, lookup: publicLookup },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("listing_fetch_thin");
    expect(result.blocked).toBe(true);
    expect(result.alternatives).toEqual(["paste_text", "enter_vin"]);
    expect(result.creditCharged).toBe(false);
    expect(result.message).toMatch(/No credit or free check was used/i);
  });

  it("identifies cruz.com-style title/URL YMM without structured vehicle JSON-LD", async () => {
    const html = readFileSync(join(FIXTURES, "cruz-crv-title-only.html"), "utf8");
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.auto.dev") || url.includes("auto.dev")) {
        return new Response(JSON.stringify({ data: [] }), { status: 404 });
      }
      return govFetch(url, { ModelYear: "2015", Make: "HONDA", Model: "CR-V", Trim: "EX" });
    });

    const result = await runCheck(
      {
        kind: "paste",
        text: html,
        url: "https://www.cruz.com/inventory/used-2015-honda-cr-v-ex-awd-2hkrm4h75fh111111",
      },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.title).toMatch(/2015 Honda CR-?V/i);
  });
});
