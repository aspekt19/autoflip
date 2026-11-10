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
    expect(result.result.agentVerdict.no_serv_step).toBe(true);
    expect(result.result.servTrace).toBeNull();
  });

  it("routes listing Check through SERV decide + challenge when a key is present", async () => {
    const html = readFileSync(join(FIXTURES, "dealer-jsonld.html"), "utf8");
    let servCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("serv-mock.test")) {
        servCalls += 1;
        const body =
          servCalls === 1
            ? { verdict: "negotiate", note: "Ask is near the fair value from similar listings." }
            : { agrees: true, action: "negotiate", objection: null, evidenceIds: ["ev_fair_value"] };
        return new Response(
          JSON.stringify({
            id: `chatcmpl-check-${servCalls}`,
            model: "gpt-5.4-mini",
            choices: [{ message: { content: JSON.stringify(body) } }],
          }),
          { status: 200 },
        );
      }
      if (url.includes("api.auto.dev") || url.includes("auto.dev")) {
        return new Response(
          JSON.stringify({
            data: [
              camryComp("4T1KZ1AK4MU060011", 24500, 30000, 2021),
              camryComp("4T1KZ1AK4MU060012", 23500, 34000, 2021),
              camryComp("4T1KZ1AK4MU060013", 25000, 28000, 2020),
              camryComp("4T1KZ1AK4MU060014", 22990, 36000, 2020),
            ],
          }),
          { status: 200 },
        );
      }
      return govFetch(url);
    });

    const result = await runCheck(
      { kind: "paste", text: html, url: "https://dealer.example/camry" },
      {
        fetch: fetchImpl as unknown as typeof fetch,
        servKey: "test-serv-key",
        servModel: "gpt-5.4-mini",
        servBaseUrl: "https://serv-mock.test/v1",
        autodevKey: "test-autodev",
        autodev: { cache: new TtlCache(), counter: new MemoryCounter() },
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(servCalls).toBe(2);
    expect(result.result.agentVerdict.no_serv_step).toBe(false);
    expect(result.result.agentVerdict.verdict).toBe("negotiate");
    expect(result.result.agentVerdict.serv_steps.some((step) => /Lemonless AI chose negotiate/i.test(step.decided))).toBe(true);
    expect(result.result.agentVerdict.serv_steps.some((step) => Boolean(step.responseId || step.model))).toBe(true);
    expect(result.result.servTrace?.calls).toHaveLength(2);
    expect(result.result.servTrace?.calls[0]?.responseId).toBe("chatcmpl-check-1");
    expect(result.result.servTrace?.calls[0]?.rawResponse).toMatch(/negotiate/);
    expect(result.result.servTrace?.calls[1]?.profile).toBe("verdict_challenge");
    expect(result.result.servTrace?.recordedAt).toMatch(/^\d{4}-/);
    expect(result.result.servTrace?.model).toBe("gpt-5.4-mini");
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
    expect(result.result.confidence).not.toBe("High");
    expect(result.result.confidenceWhy).toMatch(/not a buy\/negotiate\/pass|no asking price/i);
    expect(result.result.summary).toMatch(/not price-rated/i);
    expect(result.result.agentVerdict.serv_steps.some((s) => /no asking price/i.test(s.decided))).toBe(true);
    expect(result.result.agentVerdict.serv_spend.costNote).not.toMatch(/Ordered gates withheld/i);
  });

  it("uses the current Autodev listing ask/miles to price-rate a VIN check", async () => {
    const vin = "2HGFC3B33KH356212";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(`api.auto.dev/listings/${vin}`) || url.includes(`/listings/${vin}`)) {
        return new Response(
          JSON.stringify({
            data: [
              {
                vin,
                vehicle: { year: 2019, make: "Honda", model: "Civic", trim: "EX" },
                retailListing: {
                  price: 15_189,
                  miles: 17_480,
                  used: true,
                  city: "Omaha",
                  state: "NE",
                  zip: "68114",
                  dealer: "Optimus Auto",
                  vdp: `https://dealer.example/vdp/${vin}`,
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("api.auto.dev/listings?")) {
        // Local zip search intentionally thin; nationwide fallback should still rate.
        const nationwide = !url.includes("zip=");
        const rows = nationwide
          ? [
              { vin: "2HGFC3B33KH356201", year: 2019, price: 14_900, miles: 18_000 },
              { vin: "2HGFC3B33KH356202", year: 2018, price: 13_800, miles: 22_000 },
              { vin: "2HGFC3B33KH356203", year: 2020, price: 16_200, miles: 15_000 },
              { vin: "2HGFC3B33KH356204", year: 2019, price: 15_500, miles: 16_500 },
              { vin: "2HGFC3B33KH356205", year: 2018, price: 14_200, miles: 24_000 },
            ]
          : [{ vin: "2HGFC3B33KH356206", year: 2019, price: 15_000, miles: 17_000 }];
        return new Response(
          JSON.stringify({
            data: rows.map((row) => ({
              vin: row.vin,
              vehicle: { year: row.year, make: "Honda", model: "Civic", trim: "EX" },
              retailListing: {
                price: row.price,
                miles: row.miles,
                used: true,
                city: "Omaha",
                state: "NE",
                zip: "68114",
                vdp: `https://dealer.example/vdp/${row.vin}`,
              },
            })),
          }),
          { status: 200 },
        );
      }
      return govFetch(url, {
        ModelYear: "2019",
        Make: "HONDA",
        Model: "Civic",
        Trim: "EX",
        FuelTypePrimary: "Gasoline",
      });
    });

    const result = await runCheck(
      { kind: "vin", vin, optionalZip: "68114" },
      {
        fetch: fetchImpl as unknown as typeof fetch,
        autodevKey: "test-autodev",
        autodev: { cache: new TtlCache(), counter: new MemoryCounter() },
        kv: new MemoryKv(),
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.kind).toBe("vin_dossier");
    expect(result.result.summary).toMatch(/\$15,189/);
    expect(result.result.summary).toMatch(/Optimus Auto/);
    expect(result.result.summary).not.toMatch(/no asking price on a VIN-only check/i);
    expect(result.result.badge).not.toBeNull();
    expect(result.result.badge?.tone).not.toBe("unknown");
    expect(result.result.compCount).toBeGreaterThanOrEqual(3);
    expect(result.result.compScope).toMatch(/nationwide|Honda Civic/i);
    expect(result.result.provenance.some((row) => row.field === "priceUsd" && row.value === 15_189)).toBe(true);
    expect(result.result.unknown.some((line) => /asking price/i.test(line))).toBe(false);
    // Widened search should hit Autodev with normalized make + used + year window.
    const searchUrls = fetchImpl.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("api.auto.dev/listings?"));
    expect(searchUrls.some((u) => u.includes("vehicle.make=Honda"))).toBe(true);
    expect(searchUrls.some((u) => u.includes("retailListing.used=true"))).toBe(true);
    expect(searchUrls.some((u) => /vehicle\.year=2016-202[0-2]/.test(u))).toBe(true);
  });

  it("runs SERV decide + challenge on a priced VIN check when a key is present", async () => {
    const vin = "2HGFC3B33KH356212";
    let servCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("serv-mock.test")) {
        servCalls += 1;
        const body =
          servCalls === 1
            ? { verdict: "negotiate", note: "Ask is near similar Civic listings." }
            : { agrees: true, action: "negotiate", objection: null, evidenceIds: ["ev_fair_value"] };
        return new Response(
          JSON.stringify({
            id: `chatcmpl-vin-${servCalls}`,
            model: "gpt-5.4-mini",
            choices: [{ message: { content: JSON.stringify(body) } }],
          }),
          { status: 200 },
        );
      }
      if (url.includes(`api.auto.dev/listings/${vin}`) || url.includes(`/listings/${vin}`)) {
        return new Response(
          JSON.stringify({
            data: [
              {
                vin,
                vehicle: { year: 2019, make: "Honda", model: "Civic", trim: "EX" },
                retailListing: {
                  price: 15_189,
                  miles: 17_480,
                  used: true,
                  city: "Omaha",
                  state: "NE",
                  zip: "68114",
                  dealer: "Optimus Auto",
                  vdp: `https://dealer.example/vdp/${vin}`,
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("api.auto.dev/listings?")) {
        return new Response(
          JSON.stringify({
            data: [
              camryComp("2HGFC3B33KH356201", 14_900, 18_000, 2019),
              camryComp("2HGFC3B33KH356202", 13_800, 22_000, 2018),
              camryComp("2HGFC3B33KH356203", 16_200, 15_000, 2020),
              camryComp("2HGFC3B33KH356204", 15_500, 16_500, 2019),
            ].map((row) => ({
              ...row,
              vehicle: { ...row.vehicle, make: "Honda", model: "Civic", trim: "EX" },
            })),
          }),
          { status: 200 },
        );
      }
      return govFetch(url, {
        ModelYear: "2019",
        Make: "HONDA",
        Model: "Civic",
        Trim: "EX",
      });
    });

    const result = await runCheck(
      { kind: "vin", vin, optionalZip: "68114" },
      {
        fetch: fetchImpl as unknown as typeof fetch,
        servKey: "test-serv-key",
        servModel: "gpt-5.4-mini",
        servBaseUrl: "https://serv-mock.test/v1",
        autodevKey: "test-autodev",
        autodev: { cache: new TtlCache(), counter: new MemoryCounter() },
        kv: new MemoryKv(),
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(servCalls).toBe(2);
    expect(result.result.agentVerdict.no_serv_step).toBe(false);
    expect(result.result.agentVerdict.verdict).toBe("negotiate");
    expect(result.result.servTrace?.calls).toHaveLength(2);
    expect(result.result.agentVerdict.serv_spend.costNote).not.toMatch(/Ordered gates withheld/i);
    expect(result.result.confidenceWhy).toMatch(/similar listings/i);
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
