/**
 * End-to-end: selected listing → Autodev analysis re-fetch returns fee figure →
 * paid report stays honest unknown (no false profit / within-budget economics).
 * Mocks provider HTTP only — no real Autodev/SERV/credits.
 */
import { describe, expect, it, vi } from "vitest";
import { TtlCache } from "@/io/cache";
import { MemoryKv } from "@/io/kv";
import { MemoryCounter } from "@/io/quota";
import { assembleReport, previewListing } from "./assemble";
import { decideReportCharge } from "@/domain/report-chargeability";
import { runOrderedGates } from "@/domain/verdict-gates";

const RAV4_VIN = "2T3N1RFV6MC246998";
const VDP = "https://www.joemachenstoyota.com/auto/used-2021-toyota-rav4-limited/126661218/";

function feeListingPayload() {
  return {
    vin: RAV4_VIN,
    vehicle: { year: 2021, make: "Toyota", model: "RAV4", trim: "Limited" },
    retailListing: {
      price: 587,
      miles: 21_001,
      used: true,
      city: "Columbia",
      state: "MO",
      zip: "65202",
      vdp: VDP,
      primaryImage: null,
    },
    history: { accidentCount: 0, oneOwner: true, ownerCount: 1 },
  };
}

function compPayload(vin: string, price: number) {
  return {
    vin,
    vehicle: { year: 2021, make: "Toyota", model: "RAV4", trim: "XLE" },
    retailListing: {
      price,
      miles: 40_000,
      used: true,
      city: "Omaha",
      state: "NE",
      zip: "68114",
      vdp: `https://dealer.example/vdp/${vin}`,
    },
    history: { accidentCount: 0, oneOwner: true, ownerCount: 1 },
  };
}

function mockFetch(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const href = String(input);
    if (href.includes("api.auto.dev/listings/") && href.includes(RAV4_VIN)) {
      return Response.json(feeListingPayload());
    }
    if (href.includes("api.auto.dev/listings") && href.includes("make=")) {
      return Response.json({
        data: [
          feeListingPayload(),
          compPayload("COMPRAV40000000001", 18_500),
          compPayload("COMPRAV40000000002", 19_200),
          compPayload("COMPRAV40000000003", 17_900),
          compPayload("COMPRAV40000000004", 18_100),
        ],
      });
    }
    if (href.includes("vpic.nhtsa")) {
      return Response.json({
        Results: [{ ModelYear: 2021, Make: "TOYOTA", Model: "RAV4", ErrorCode: "0" }],
      });
    }
    if (href.includes("nhtsa.gov") || href.includes("fueleconomy") || href.includes("geocoding.geo.census")) {
      return Response.json({ results: [], Results: [], count: 0, result: { addressMatches: [] } });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("assembleReport Autodev fee re-fetch (selected listing handoff)", () => {
  it("does not treat $587 fee as verified ask, budget claim, or profit economics", async () => {
    const result = await assembleReport(
      {
        mode: "personal",
        vin: RAV4_VIN,
        url: VDP,
        zip: "68114",
        miles: 21_001,
        budgetUsd: 20_000,
        budgetKnown: true,
      },
      {
        autodevKey: "test-key",
        fetch: mockFetch(),
        autodev: { cache: new TtlCache(), counter: new MemoryCounter() },
        kv: new MemoryKv(),
        env: {},
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const computed = result.report.computed;
    expect(computed.subject.priceUsd).toBeNull();
    expect(computed.fairValueUsd).toBeNull();
    expect(computed.priceGap).toBeNull();
    expect(computed.flip).toBeNull();
    // Ordered gates withhold buy/negotiate/pass when purchase ask is unknown.
    expect(computed.verdict).toBe("withheld");
    expect(computed.dataNotes.some((n) => /587/.test(n) && /not treated as a verified vehicle purchase ask/i.test(n))).toBe(
      true,
    );
    // No fabricated replacement purchase ask.
    expect(JSON.stringify(computed.subject)).not.toMatch(/32823/);
    expect(JSON.stringify(computed.reasons).toLowerCase()).not.toMatch(/good deal|within budget|profit/);

    const gates = runOrderedGates(computed, { budgetUsd: 20_000, budgetKnown: true });
    expect(gates.withheld).toBe(true);
    expect(gates.withholdReason).toMatch(/no asking price/i);
    const dataGate = gates.gates.find((g) => g.id === "data_sufficiency");
    expect(dataGate?.status).toBe("withhold");
    expect(dataGate?.forbid).toEqual(expect.arrayContaining(["buy", "negotiate", "pass"]));

    // HOLD2: fee-refetch withheld report is not chargeable — route must 0-debit.
    const charge = decideReportCharge(computed);
    expect(charge.charge).toBe(false);
    if (!charge.charge) {
      expect(charge.error).toBe("unusable_purchase_ask");
      expect(charge.message).toMatch(/No credit was charged/i);
    }
  });

  it("preview badge also refuses fee figure as a rated purchase ask", async () => {
    const preview = await previewListing(
      { mode: "personal", vin: RAV4_VIN, url: VDP, zip: "68114" },
      {
        autodevKey: "test-key",
        fetch: mockFetch(),
        autodev: { cache: new TtlCache(), counter: new MemoryCounter() },
        kv: new MemoryKv(),
        env: {},
      },
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok || !("badge" in preview)) return;
    expect(preview.badge.tone).toBe("unknown");
    expect(preview.badge.label).toMatch(/not enough similar cars/i);
  });

  it("flip mode: fee re-fetch yields no profit margin claim", async () => {
    const result = await assembleReport(
      {
        mode: "flip",
        vin: RAV4_VIN,
        url: VDP,
        zip: "68114",
        miles: 21_001,
        targetProfitUsd: 2_000,
      },
      {
        autodevKey: "test-key",
        fetch: mockFetch(),
        autodev: { cache: new TtlCache(), counter: new MemoryCounter() },
        kv: new MemoryKv(),
        env: {},
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.computed.subject.priceUsd).toBeNull();
    expect(result.report.computed.flip).toBeNull();
  });
});
