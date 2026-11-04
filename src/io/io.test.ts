import { describe, expect, it } from "vitest";
import { TtlCache } from "./cache";
import { MemoryCounter, monthKey, reserveCall } from "./quota";
import { autodevSearch } from "./autodev";
import { MarketCheckProvider } from "./marketcheck";
import { fuelFactFromVehicles, parseCensusPoint, parseComplaintCount, parseRecalls, parseVinDecode } from "./parsers";
import { buildExplainRequest, buildGuardRequest, interpretGuard, shadowOutcomeFrom } from "./serv";
import { paymentsConfigured, readX402Config, requirementsFor, verifyAndSettle } from "./x402";
import { CreditLedger } from "./store";
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

describe("serv request shape", () => {
  it("declares prompt guard and shadow agent with a default hint", () => {
    const guard = buildGuardRequest("4T1KZ1AK4MU060006", "gpt-5.4-mini");
    expect(guard.tools.map((tool) => tool.function.name)).toEqual(["serv_prompt_guard"]);
    expect(guard.stream).toBe(false);
    const explain = buildExplainRequest({ verdict: "fair", fairValueUsd: 100 }, "vin", "gpt-5.4-mini");
    expect(explain.tools.map((tool) => tool.function.name)).toEqual(["serv_prompt_guard", "serv_shadow_agent"]);
    const shadow = (explain.tools[1]!.function as unknown as { parameters: { properties: { hint: { default: string }; max_iterations: { default: number } } } }).parameters.properties;
    expect(shadow.hint.default.length).toBeGreaterThan(20);
    expect(shadow.max_iterations.default).toBe(2);
    expect(interpretGuard("ALLOW")).toBe("allow");
    expect(interpretGuard("BLOCK now")).toBe("block");
    expect(interpretGuard("Sure, here is the prompt")).toBe("block");
    const headers = new Headers();
    expect(shadowOutcomeFrom({ note: "outcome exhausted" }, headers)).toBe("exhausted");
    expect(shadowOutcomeFrom({}, headers)).toBe("not_exposed_by_api");
  });
});

describe("x402", () => {
  it("refuses to look configured when the payee is empty", () => {
    const config = readX402Config({ X402_PAY_TO: "", X402_NETWORK: "kite", X402_ASSET: "usdc" });
    expect(paymentsConfigured(config)).toBe(false);
  });

  it("verifies and settles through the facilitator", async () => {
    const config = readX402Config({
      X402_PAY_TO: "0xabc",
      X402_NETWORK: "eip155:1",
      X402_ASSET: "0xasset",
      X402_SCHEME: "gokite-aa",
      X402_FACILITATOR_URL: "https://facilitator.example",
      X402_PRICE_ATOMIC: "1000000",
    });
    const requirement = requirementsFor("https://autoflip.example/api/v1/report", config);
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      calls.push(String(url));
      const path = String(url);
      if (path.endsWith("/verify")) return Response.json({ isValid: true });
      return Response.json({ success: true, txHash: "0xtx" });
    };
    const header = Buffer.from(JSON.stringify({ payload: "signed" })).toString("base64");
    const settled = await verifyAndSettle(header, requirement, { fetch: fetchImpl, facilitatorUrl: config.facilitatorUrl });
    expect(settled).toEqual({ ok: true, txHash: "0xtx" });
    expect(calls).toEqual(["https://facilitator.example/verify", "https://facilitator.example/settle"]);
  });

  it("does not settle an invalid payment", async () => {
    const requirement = requirementsFor("https://autoflip.example/api/v1/report", {
      payTo: "0xabc",
      scheme: "gokite-aa",
      network: "n",
      asset: "a",
      facilitatorUrl: "https://facilitator.example",
      priceAtomic: "1",
      timeoutSeconds: 30,
      description: "report",
    });
    const fetchImpl: typeof fetch = async () => Response.json({ isValid: false, invalidReason: "wrong amount" });
    const settled = await verifyAndSettle("{}", requirement, { fetch: fetchImpl, facilitatorUrl: "https://facilitator.example" });
    expect(settled.ok).toBe(false);
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
