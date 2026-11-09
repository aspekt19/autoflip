import { describe, expect, it, vi } from "vitest";
import { TtlCache } from "@/io/cache";
import type { Listing } from "@/domain/types";
import {
  createLiveFreeGovPort,
  isFreeGovToolId,
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
  it("FuelEconomy.gov is an allowlisted free gov tool id (Find free_gov_fuel)", () => {
    expect(isFreeGovToolId("evidence.gov_fuel")).toBe(true);
    expect(isFreeGovToolId("evidence.gov_recalls")).toBe(true);
    expect(isFreeGovToolId("evidence.gov_vpic")).toBe(true);
    expect(isFreeGovToolId("evidence.gov_safety")).toBe(true);
  });

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
    expect(packet.facts[0]?.value).toMatchObject({
      titleNmvtis: "unknown_not_connected",
      vinOpenRecalls: null,
    });
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
    expect(packet.facts.some((f) => f.key === "nhtsa_park_outside")).toBe(false);
    expect(packet.summary).toMatch(/parkIt=true/);
    expect(packet.summary).toMatch(/parkOutside=false/);
  });

  it("recalls: parkOutside-only does NOT emit nhtsa_park_it", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("recallsByVehicle")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                NHTSACampaignNumber: "99V001",
                Component: "ENGINE",
                Summary: "Park outside",
                Consequence: "Fire",
                Remedy: "Inspect",
                parkIt: false,
                parkOutSide: true,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
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
    expect(packet.status).toBe("ok");
    const primary = packet.facts.find((f) => f.key === "evidence.gov_recalls")?.value as {
      parkIt?: boolean;
      parkOutside?: boolean;
    };
    expect(primary.parkIt).toBe(false);
    expect(primary.parkOutside).toBe(true);
    expect(packet.facts.some((f) => f.key === "nhtsa_park_outside")).toBe(true);
    expect(packet.facts.some((f) => f.key === "nhtsa_park_it")).toBe(false);
    expect(packet.summary).toMatch(/parkIt=false/);
    expect(packet.summary).toMatch(/parkOutside=true/);
  });

  it("upstream failure is unavailable (not empty-no-record)", async () => {
    const fetchImpl = vi.fn(async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    const packet = await createLiveFreeGovPort({ fetch: fetchImpl }).run("evidence.gov_recalls", listing);
    expect(packet.status).toBe("unavailable");
    expect(packet.outcomeOk).toBe(false);
    expect(packet.outcomeCapability).toBe("failed");
  });

  it("vPIC: HTTP 200 + ErrorCode!=0 is error — never invents decode identity", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("DecodeVinValues")) {
        return new Response(
          JSON.stringify({
            Results: [
              {
                ModelYear: "2011",
                Make: "BMW",
                Model: "X3",
                ErrorCode: "6",
                ErrorText: "6 - Incomplete VIN",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("nope", { status: 500 });
    }) as unknown as typeof fetch;

    const packet = await createLiveFreeGovPort({ fetch: fetchImpl }).run("evidence.gov_vpic", listing);
    expect(packet.status).toBe("error");
    expect(packet.outcomeOk).toBe(false);
    expect(packet.outcomeCapability).toBe("failed");
    const value = packet.facts[0]?.value as Record<string, unknown>;
    expect(value.errorCode).toBe("6");
    expect(value).not.toHaveProperty("make");
    expect(value).not.toHaveProperty("model");
    expect(value).not.toHaveProperty("year");
    expect(value.titleNmvtis).toBe("unknown_not_connected");
  });

  it("vPIC: ErrorCode=0 records specs; title stays unknown_not_connected", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("DecodeVinValues")) {
        return new Response(
          JSON.stringify({
            Results: [{ ModelYear: "2020", Make: "TOYOTA", Model: "CAMRY", ErrorCode: "0", ErrorText: "0 - VIN decoded clean." }],
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
    expect(first.status).toBe("ok");
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(first.facts[0]?.value).toMatchObject({
      titleNmvtis: "unknown_not_connected",
      errorCode: "0",
      make: "TOYOTA",
    });
  });

  it("safety: Not Rated + RolloverPossibility 0 is unknown, not risk-zero pass", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("SafetyRatings/modelyear")) {
        return new Response(JSON.stringify({ Count: 1, Results: [{ VehicleId: 7520, VehicleDescription: "2013 Acura RDX SUV FWD" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("SafetyRatings/VehicleId/7520")) {
        return new Response(
          JSON.stringify({
            Results: [
              {
                VehicleId: 7520,
                VehicleDescription: "2013 Acura RDX SUV FWD",
                OverallRating: "Not Rated",
                OverallFrontCrashRating: "Not Rated",
                OverallSideCrashRating: "Not Rated",
                RolloverRating: "Not Rated",
                RolloverPossibility: 0.0,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("nope", { status: 500 });
    }) as unknown as typeof fetch;

    const packet = await createLiveFreeGovPort({ fetch: fetchImpl }).run("evidence.gov_safety", listing);
    expect(packet.status).toBe("ok");
    expect(packet.facts[0]?.kind).toBe("unknown");
    const value = packet.facts[0]?.value as {
      ratingAggregate: string;
      variants: Array<{ ratingStatus: string; overallRating: string | null; rolloverPossibility: number | null }>;
      warnings: string[];
    };
    expect(value.ratingAggregate).toBe("not_rated");
    expect(value.variants[0]?.ratingStatus).toBe("not_rated");
    expect(value.variants[0]?.overallRating).toBeNull();
    expect(value.variants[0]?.rolloverPossibility).toBe(0);
    expect(value.warnings.some((w) => /Not Rated/i.test(w))).toBe(true);
    expect(value.warnings.some((w) => /RolloverPossibility/i.test(w))).toBe(true);
    expect(packet.summary).toMatch(/not_rated|unknown/i);
    expect(packet.summary).not.toMatch(/\b0 stars\b|risk-zero|clean pass/i);
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
