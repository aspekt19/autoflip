import { describe, expect, it, vi } from "vitest";
import { MemoryKv } from "@/io/kv";
import { TtlCache } from "@/io/cache";
import { MemoryCounter } from "@/io/quota";
import { creditBalance, creditGrant } from "@/io/credit-book";
import { explicitNeedFromText } from "@/domain/need";
import { debitFindDelivery } from "./find-search-credit";
import { runFindMatch } from "./find-match";
import { understandNeed } from "./understand-need";

const CASE_A = "First car for my daughter, safe and cheap to run, max 12k, near Chicago, newer than 2019";
const CASE_B = "Used compact SUV with AWD under $25,000 near Denver, 2018 or newer, under 80k miles";

function row(input: {
  vin: string;
  make: string;
  model: string;
  bodyStyle?: string | null;
  price?: number;
  miles?: number;
  distance?: number | null;
  drivetrain?: string | null;
  year?: number;
}) {
  return {
    vin: input.vin,
    vehicle: {
      year: input.year ?? 2021,
      make: input.make,
      model: input.model,
      bodyStyle: input.bodyStyle ?? null,
      drivetrain: input.drivetrain ?? null,
      trim: null,
    },
    retailListing: {
      price: input.price ?? 11_000,
      miles: input.miles ?? 40_000,
      used: true,
      city: "Chicago",
      state: "IL",
      zip: "60601",
      distance: input.distance ?? null,
      vdpURL: "https://dealer.example/car",
      primaryImage: null,
    },
  };
}

function deps(fetchImpl: typeof fetch) {
  return {
    autodevKey: "test-key",
    servKey: "",
    fetch: fetchImpl,
    autodev: { cache: new TtlCache<unknown>(), counter: new MemoryCounter() },
    kv: new MemoryKv(),
    env: {},
  };
}

describe("live Find defects — inventory, radius, and the credit ledger", () => {
  it("does not widen a Chicago search or return motorcycles, and does not debit when nothing matches", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const href = String(url);
      urls.push(href);
      if (href.includes("vpic.nhtsa")) {
        return Response.json({ Results: [{ DriveType: "", ErrorCode: "0" }] });
      }
      return Response.json({
        data: [
          row({ vin: "1HD1KRP14NB000001", make: "Harley-Davidson", model: "Nightster", bodyStyle: "Motorcycle", distance: 800 }),
          row({ vin: "ZDM1UB5W5NB000002", make: "Ducati", model: "Monster", bodyStyle: "Motorcycle", distance: 900 }),
          row({ vin: "JYARM06E5NA000003", make: "Yamaha", model: "MT-07", bodyStyle: "Motorcycle", distance: 700 }),
          row({ vin: "JKBVNKC15NA000004", make: "Kawasaki", model: "Vulcan", bodyStyle: "Motorcycle", distance: 650 }),
          row({ vin: "1C9CK15G5N1000005", make: "Coachman", model: "Clipper", bodyStyle: "RV", distance: 1200 }),
          row({ vin: "2HGFC2F79NH000006", make: "Honda", model: "Civic", bodyStyle: "Sedan", distance: 400, price: 11_500 }),
        ],
      });
    });
    const parsed = explicitNeedFromText(CASE_A, "personal");
    const need = { ...parsed, zip: "60601", distanceMiles: 50, budgetUsd: 12_000, budgetKnown: true };
    const result = await runFindMatch({ need }, deps(fetchImpl as typeof fetch));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const listings = result.body.directions.flatMap((group) => group.listings);
    expect(listings.map((car) => car.make)).not.toEqual(expect.arrayContaining(["Harley-Davidson", "Ducati", "Yamaha", "Kawasaki", "Coachman"]));
    expect(listings).toHaveLength(0);
    expect(result.body.scope).toMatch(/60601/);
    expect(result.body.scope).not.toMatch(/Nationwide/);
    expect(urls.some((url) => url.includes("distance=50") && url.includes("60601"))).toBe(true);
    expect(urls.some((url) => url.includes("api.auto.dev") && !url.includes("distance="))).toBe(false);
    const modelQueries = urls.filter((url) => /vehicle\.model=/i.test(url) && url.includes("api.auto.dev"));
    expect(modelQueries.length).toBeGreaterThan(0);
    expect(modelQueries.every((url) => !/vehicle\.bodyStyle=/i.test(url))).toBe(true);

    const kv = new MemoryKv();
    await creditGrant(kv, "shopper", 9, "grant-9");
    const debit = await debitFindDelivery(kv, "shopper", "find-empty", {
      ok: true,
      providerQueriesUsed: result.body.providerQueriesUsed,
      listingCount: listings.length,
      emptyReason: result.body.emptyReason,
    });
    expect(debit.charged).toBe(false);
    expect(debit.balance).toBe(9);
    expect(await creditBalance(kv, "shopper")).toBe(9);
  });

  it("keeps Denver ZIP 80202 and a 100 mile radius, and treats with AWD as a hard limit", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const href = String(url);
      urls.push(href);
      if (href.includes("DecodeVinValues")) {
        return Response.json({ Results: [{ DriveType: "FWD", ErrorCode: "0" }] });
      }
      return Response.json({
        data: [
          row({
            vin: "5N1AT2MT5LC000010",
            make: "Nissan",
            model: "Rogue",
            bodyStyle: "SUV",
            drivetrain: "FWD",
            distance: 20,
            price: 22_000,
            year: 2019,
          }),
          row({
            vin: "2T3R1RFV5NW000011",
            make: "Toyota",
            model: "RAV4",
            bodyStyle: "SUV",
            drivetrain: null,
            distance: 30,
            price: 23_000,
            year: 2020,
          }),
          row({
            vin: "1C4RJFBG5LC000012",
            make: "Jeep",
            model: "Grand Cherokee",
            bodyStyle: "SUV",
            drivetrain: "AWD",
            distance: 400,
            price: 24_000,
            year: 2019,
          }),
          row({
            vin: "5XYZU3LB5HG000013",
            make: "Hyundai",
            model: "Tucson",
            bodyStyle: "SUV",
            drivetrain: "AWD",
            distance: 40,
            price: 21_000,
            year: 2019,
          }),
        ],
      });
    });
    const understood = await understandNeed(
      {
        text: CASE_B,
        mode: "personal",
        zip: null,
        // Explicit dirty radius — defaults are not inventable as constraints.
        distanceMiles: 100,
        radiusDirty: true,
      },
      { servKey: "" },
    );
    expect(understood.ok).toBe(true);
    if (!understood.ok) return;
    expect(understood.need.zip).toBe("80202");
    expect(understood.need.distanceMiles).toBe(100);
    expect(understood.need.awdPreference).toBe(true);
    expect(understood.need.mustHaves).toContain("AWD");

    const result = await runFindMatch({ need: understood.need }, deps(fetchImpl as typeof fetch));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.scope).toBe("Within 100 miles of 80202");
    const listings = result.body.directions.flatMap((group) => group.listings);
    const vins = [...new Set(listings.map((car) => car.vin))];
    expect(vins).toEqual(["5XYZU3LB5HG000013"]);
    expect(listings.every((car) => car.drivetrain === "AWD" && (car.distanceMiles ?? 0) <= 100)).toBe(true);
    expect(urls.some((url) => url.includes("distance=100") && url.includes("80202"))).toBe(true);
    expect(urls.some((url) => url.includes("api.auto.dev") && !url.includes("distance="))).toBe(false);
  });

  it("debits the ledger only when a matching car is delivered", async () => {
    const kv = new MemoryKv();
    await creditGrant(kv, "shopper", 9, "grant-9b");
    const spent = await debitFindDelivery(kv, "shopper", "find-hit", {
      ok: true,
      providerQueriesUsed: 1,
      listingCount: 1,
      emptyReason: null,
    });
    expect(spent.charged).toBe(true);
    expect(spent.balance).toBe(8);
    expect(await creditBalance(kv, "shopper")).toBe(8);
  });
});
