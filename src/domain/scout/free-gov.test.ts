import { describe, expect, it, vi } from "vitest";
import { TtlCache } from "@/io/cache";
import type { Listing } from "@/domain/types";
import {
  createLiveFreeGovPort,
  unsupportedFreeGovPort,
  type FreeGovEvidencePacket,
} from "./free-gov";

const listing: Listing = {
  vin: "4T1B11HK5JU123456",
  year: 2020,
  make: "Toyota",
  model: "Camry",
  trim: null,
  miles: 40_000,
  priceUsd: 18_000,
  city: null,
  state: null,
  zip: null,
  dealer: null,
  vdp: null,
  primaryImage: null,
  carfaxUrl: null,
  used: true,
  cpo: null,
  accidentCount: null,
  oneOwner: null,
  ownerCount: null,
  usageType: null,
  fuel: null,
  engine: "2.5L",
  drivetrain: null,
  bodyStyle: null,
  latitude: null,
  longitude: null,
  removedAt: null,
  source: "autodev",
};

describe("free gov port (offline mocked)", () => {
  it("unsupported harness never fabricates clean title or success", async () => {
    const packet = await unsupportedFreeGovPort().run("evidence.gov_recalls", listing);
    expect(packet.outcomeOk).toBe(false);
    expect(packet.outcomeStatus).toBe("unsupported");
    expect(packet.facts.every((f) => f.kind === "unknown")).toBe(true);
    expect(JSON.stringify(packet)).not.toMatch(/clean title|nmvtis.*clear/i);
  });

  it("recalls: available empty ≠ unavailable; scope denies VIN unrepaired claim", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("recallsByVehicle")) {
        return new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("complaintsByVehicle")) {
        return new Response(JSON.stringify({ count: 0, results: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("nope", { status: 500 });
    }) as unknown as typeof fetch;

    const packet = await createLiveFreeGovPort({ fetch: fetchImpl }).run("evidence.gov_recalls", listing);
    expect(packet.status).toBe("empty");
    expect(packet.outcomeStatus).toBe("empty");
    expect(packet.outcomeOk).toBe(true);
    expect(packet.scope).toMatch(/NOT VIN-specific unrepaired/i);
    expect(packet.facts[0]?.value).toMatchObject({ titleNmvtis: "unknown_not_connected" });
    expect(packet.facts.some((f) => f.key === "nhtsa_park_it")).toBe(false);
  });

  it("recalls: park-it campaign becomes adverse nhtsa_park_it fact", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("recallsByVehicle")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                NHTSACampaignNumber: "20V123",
                Component: "AIR BAGS",
                Summary: "Park it campaign",
                Consequence: "Injury",
                Remedy: "Dealer",
                parkIt: true,
                parkOutSide: false,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (u.includes("complaintsByVehicle")) {
        return new Response(JSON.stringify({ count: 3, results: [{}, {}, {}] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("nope", { status: 500 });
    }) as unknown as typeof fetch;

    const packet = await createLiveFreeGovPort({ fetch: fetchImpl }).run("evidence.gov_recalls", listing);
    expect(packet.status).toBe("ok");
    expect(packet.facts.some((f) => f.key === "nhtsa_park_it" && f.kind === "verified")).toBe(true);
    expect(packet.summary).toMatch(/parkIt=true/);
  });

  it("upstream failure is unavailable (not empty-no-record)", async () => {
    const fetchImpl = vi.fn(async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    const packet = await createLiveFreeGovPort({ fetch: fetchImpl }).run("evidence.gov_fuel", listing);
    expect(packet.status).toBe("unavailable");
    expect(packet.outcomeOk).toBe(false);
    expect(packet.outcomeCapability).toBe("failed");
  });

  it("caches successful packets and stamps cached=true on replay", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      calls += 1;
      const u = String(url);
      if (u.includes("DecodeVinValues")) {
        return new Response(
          JSON.stringify({
            Results: [{ ModelYear: "2020", Make: "TOYOTA", Model: "CAMRY", ErrorCode: "0" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("nope", { status: 500 });
    }) as unknown as typeof fetch;

    const cache = new TtlCache<FreeGovEvidencePacket>(60_000);
    const port = createLiveFreeGovPort({ fetch: fetchImpl, cache });
    const first = await port.run("evidence.gov_vpic", listing);
    const second = await port.run("evidence.gov_vpic", listing);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(calls).toBe(1);
    expect(first.facts[0]?.value).toMatchObject({ titleNmvtis: "unknown_not_connected" });
  });

  it("safety ratings empty index is available empty", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("SafetyRatings/modelyear")) {
        return new Response(JSON.stringify({ Count: 0, Results: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("nope", { status: 500 });
    }) as unknown as typeof fetch;
    const packet = await createLiveFreeGovPort({ fetch: fetchImpl }).run("evidence.gov_safety", listing);
    expect(packet.status).toBe("empty");
    expect(packet.outcomeCapability).toBe("empty");
  });
});
