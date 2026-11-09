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
