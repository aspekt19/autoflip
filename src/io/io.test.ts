import { describe, expect, it } from "vitest";
import { TtlCache } from "./cache";
import { MemoryCounter, monthKey, reserveCall } from "./quota";
import { autodevSearch } from "./autodev";
import { MarketCheckProvider } from "./marketcheck";
import { fuelFactFromVehicles, parseCensusPoint, parseComplaintCount, parseRecalls, parseVinDecode } from "./parsers";
import { interpretGuard, shadowOutcomeFrom } from "@/server/serv";
import { CreditLedger } from "./store";
import { recallsFor } from "./gov";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import fixture from "../../fixtures/autodev-camry.json";

describe("quota and cache", () => {
  it("stops at 900 and does not call the network", async () => {
    const counter = new MemoryCounter();
    const month = monthKey(new Date("2026-11-04T00:00:00Z"));
    for (let i = 0; i < 900; i += 1) counter.increment(month);
    let calls = 0;
    const result = await autodevSearch(
      { make: "Toyota", model: "Camry" },
      {
        fetch: async () => {
          calls += 1;
          return new Response("no", { status: 500 });
        },
        cache: new TtlCache(),
        counter,
        apiKey: "test-key",
        now: new Date("2026-11-04T00:00:00Z"),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("demo_limit");
    expect(calls).toBe(0);
    expect(counter.get(month)).toBe(900);
  });

  it("serves a second search from cache without another counted call", async () => {
    const counter = new MemoryCounter();
    const cache = new TtlCache<unknown>();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify(fixture), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const deps = {
      fetch: fetchImpl,
      cache,
      counter,
      apiKey: "test-key",
      now: new Date("2026-11-04T00:00:00Z"),
    };
    const first = await autodevSearch({ make: "Toyota", model: "Camry" }, deps);
    const second = await autodevSearch({ make: "Toyota", model: "Camry" }, deps);
    expect(first.ok && second.ok).toBe(true);
    expect(calls).toBe(1);
    expect(counter.get(monthKey(deps.now))).toBe(1);
    if (second.ok) expect(second.cached).toBe(true);
    if (second.ok) expect(second.listings).toHaveLength(5);
  });

  it("reserveCall increments only when under the cap", () => {
    const counter = new MemoryCounter();
    const now = new Date("2026-05-01T00:00:00Z");
    expect(reserveCall(counter, now, 1).ok).toBe(true);
    const blocked = reserveCall(counter, now, 1);
    expect(blocked.ok).toBe(false);
  });
});

describe("marketcheck", () => {
  it("stays disabled", async () => {
    const provider = new MarketCheckProvider();
    expect(provider.enabled).toBe(false);
    await expect(provider.search({ make: "Toyota" })).rejects.toThrow(/Disabled/);
    await expect(provider.getByVin("1M8GDM9AXKP042788")).rejects.toThrow(/Disabled/);
  });
});

describe("government parsers", () => {
  it("reads recalls, complaints, decode, fuel, and census", () => {
    const recalls = parseRecalls({
      results: [
        { NHTSACampaignNumber: "24V123", Component: "Airbags", Summary: "May deploy.", Conequence: "Injury.", Remedy: "Replace.", parkIt: "True", parkOutSide: "False" },
      ],
    });
    expect(recalls[0]?.parkIt).toBe(true);
    expect(recalls[0]?.consequence).toBe("Injury.");
    expect(parseComplaintCount({ count: 42 })).toBe(42);
    expect(parseVinDecode({ Results: [{ Make: "TOYOTA", Model: "Camry", ModelYear: "2021", ErrorCode: "0" }] })?.make).toBe("TOYOTA");
    const fuel = fuelFactFromVehicles(
      [
        { combMpg: 28, annualFuelCostUsd: 2100, vehicleClass: "Midsize", engine: "2.5L I4" },
        { combMpg: 22, annualFuelCostUsd: 2800, vehicleClass: "Midsize", engine: "3.5L V6" },
      ],
      "3.5L 6Cyl Gasoline",
    );
    expect(fuel?.match).toBe("closest_config");
    expect(fuel?.annualFuelCostUsd).toBe(2800);
    expect(parseCensusPoint({ result: { addressMatches: [{ coordinates: { x: -94.1, y: 36.3 } }] } })).toEqual({
      latitude: 36.3,
      longitude: -94.1,
    });
    expect(parseCensusPoint({ result: { addressMatches: [] } })).toBeNull();
  });
});

describe("recall lookup availability", () => {
  it("distinguishes a successful empty result from an unavailable upstream", async () => {
    let emptyCalls = 0;
    const empty = await recallsFor("Toyota", "Camry", 2021, {
      fetch: async () => {
        emptyCalls += 1;
        return Response.json({ results: [] });
      },
    });
    expect(empty).toEqual({ records: [], available: true });
    expect(emptyCalls).toBe(1);

    let unavailableCalls = 0;
    const unavailable = await recallsFor("Toyota", "Camry", 2021, {
      fetch: async () => {
        unavailableCalls += 1;
        return new Response("upstream unavailable", { status: 503 });
      },
    });
    expect(unavailable).toEqual({ records: [], available: false });
    expect(unavailableCalls).toBe(2);

    let malformedCalls = 0;
    const malformed = await recallsFor("Toyota", "Camry", 2021, {
      fetch: async () => {
        malformedCalls += 1;
        return Response.json({ message: "unexpected response" });
      },
    });
    expect(malformed).toEqual({ records: [], available: false });
    expect(malformedCalls).toBe(1);
  });

  it("retries one fast 504 and does not retry a timeout or a 400", async () => {
    let gatewayCalls = 0;
    const recovered = await recallsFor("Hyundai", "Tucson", 2016, {
      fetch: async () => {
        gatewayCalls += 1;
        if (gatewayCalls === 1) return new Response("gateway timeout", { status: 504 });
        return Response.json({ Count: 0, results: [] });
      },
    });
    expect(recovered).toEqual({ records: [], available: true });
    expect(gatewayCalls).toBe(2);

    let timeoutCalls = 0;
    const timedOut = await recallsFor("Hyundai", "Tucson", 2016, {
      fetch: async () => {
        timeoutCalls += 1;
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      },
    });
    expect(timedOut.available).toBe(false);
    expect(timeoutCalls).toBe(1);

    let clientCalls = 0;
    const rejected = await recallsFor("Hyundai", "Tucson", 2016, {
      fetch: async () => {
        clientCalls += 1;
        return new Response("bad model", { status: 400 });
      },
    });
    expect(rejected.available).toBe(false);
    expect(clientCalls).toBe(1);
  });
});

describe("serv outcome words", () => {
  it("reads the documented exhausted outcome and does not invent a header name", () => {
    expect(interpretGuard("ALLOW")).toBe("allow");
    expect(interpretGuard("BLOCK now")).toBe("block");
    const headers = new Headers();
    expect(shadowOutcomeFrom({ note: "outcome exhausted" }, headers)).toBe("exhausted");
    expect(shadowOutcomeFrom({}, headers)).toBe("not_exposed");
    expect(shadowOutcomeFrom({}, new Headers({ "x-any-shadow-result": "passed" }))).toBe("passed");
  });
});

describe("credits", () => {
  it("grants once per idempotency key and will not spend below zero", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "autoflip-credits-"));
    const ledger = new CreditLedger(path.join(dir, "credits.json"));
    expect(ledger.grant("user", 2, "stripe:1")).toBe(2);
    expect(ledger.grant("user", 2, "stripe:1")).toBe(2);
    expect(ledger.spend("user", "report:a")).toEqual({ ok: true, balance: 1 });
    expect(ledger.spend("user", "report:a")).toEqual({ ok: true, balance: 1 });
    expect(ledger.spend("user", "report:b").ok).toBe(true);
    expect(ledger.spend("user", "report:c").ok).toBe(false);
  });
});
