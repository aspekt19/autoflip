import { describe, expect, it, vi } from "vitest";
import { runEvalLiveCheck } from "./eval-live-check";

describe("runEvalLiveCheck", () => {
  it("rejects invalid listingUrl without calling upstreams", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 500 }));
    const result = await runEvalLiveCheck({
      kind: "link",
      listingUrl: "not-a-url",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.charged).toBe(false);
    expect(result.error).toBe("invalid_listing_url");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects invalid VIN without calling upstreams", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 500 }));
    const result = await runEvalLiveCheck({
      kind: "vin",
      vin: "SHORT",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.charged).toBe(false);
    expect(result.error).toBe("invalid_vin");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports blocked link fetch without bypass (no credit)", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      // Listing page fetch — simulate anti-bot wall.
      if (url.includes("cars.com") || url.includes("dealer")) {
        return new Response("Just a moment... Cloudflare", {
          status: 403,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("{}", { status: 404 });
    });
    const result = await runEvalLiveCheck({
      kind: "link",
      listingUrl: "https://www.cars.com/vehicledetail/example-blocked/",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.charged).toBe(false);
    expect(result.ok).toBe(false);
    // Blocked or refused — never invent a bypass verdict.
    expect(result.blocked || result.error).toBeTruthy();
    if (result.blocked) {
      expect(result.error).toMatch(/listing_fetch_blocked|blocked/i);
      expect(result.message ?? "").toMatch(/do not bypass|blocked|wall/i);
    }
  });
});
