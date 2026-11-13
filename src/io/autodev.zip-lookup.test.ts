/**
 * Auto.dev ZIP lookup — PO-box / unresolvable ZIPs must not look like empty inventory.
 */
import { describe, expect, it, vi } from "vitest";
import { TtlCache } from "./cache";
import { MemoryCounter } from "./quota";
import {
  autodevZipLookup,
  listingsSearchUrl,
  zipLookupUrl,
} from "./autodev";

describe("autodevZipLookup", () => {
  it("builds /api/zip/{code} on the Auto.dev origin (not bare /zip)", () => {
    const url = zipLookupUrl("98101");
    expect(url).toContain("/api/zip/98101");
    expect(url).not.toMatch(/api\.auto\.dev\/zip\//);
    expect(url).toBe("https://api.auto.dev/api/zip/98101");
  });

  it("returns location_not_recognized for PO-box ZIP 30301 when provider cannot geocode", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain("/api/zip/30301");
      return new Response(
        JSON.stringify({
          success: false,
          error: { message: "ZIP not found" },
        }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    });

    const result = await autodevZipLookup("30301", {
      fetch: fetchImpl as unknown as typeof fetch,
      cache: new TtlCache(),
      counter: new MemoryCounter(),
      apiKey: "test-key",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("location_not_recognized");
    expect(result.status).toBe(404);
    expect(result.message).toMatch(/30301/);
    expect(result.url).toContain("/api/zip/30301");
    expect(result.raw).toEqual({ success: false, error: { message: "ZIP not found" } });
  });

  it("returns location_not_recognized when 200 body lacks coordinates", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({ success: true, payload: { zip: "30301", city: null, state: "GA" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const result = await autodevZipLookup("30301", {
      fetch: fetchImpl as unknown as typeof fetch,
      cache: new TtlCache(),
      counter: new MemoryCounter(),
      apiKey: "test-key",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("location_not_recognized");
  });

  it("returns resolved city-center coordinates for a geocodable ZIP", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          success: true,
          payload: {
            zip: "30303",
            city: "Atlanta",
            state: "GA",
            latitude: 33.749,
            longitude: -84.388,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const result = await autodevZipLookup("30303", {
      fetch: fetchImpl as unknown as typeof fetch,
      cache: new TtlCache(),
      counter: new MemoryCounter(),
      apiKey: "test-key",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.location).toEqual({
      zip: "30303",
      city: "Atlanta",
      state: "GA",
      latitude: 33.749,
      longitude: -84.388,
    });
  });
});

describe("listingsSearchUrl location form", () => {
  it("passes the resolved ZIP (not city name) as the provider buyer-center", () => {
    const url = listingsSearchUrl({ zip: "30303", distanceMiles: 80, limit: 20 });
    expect(url).toContain("zip=30303");
    expect(url).toContain("distance=80");
  });
});
