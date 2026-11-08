import { describe, expect, it } from "vitest";
import {
  isTrustedFindAnalysisContext,
  prechargeAnalysisGate,
  resolveManualCheckHandoff,
  resolveSelectedListingHandoff,
} from "./find-analysis-handoff";

const RAV4 = {
  vin: "2T3N1RFV6MC246998",
  year: 2021,
  make: "Toyota",
  model: "RAV4",
  trim: "Limited",
  miles: 21_001,
  priceUsd: 587,
  vdp: "https://www.joemachenstoyota.com/auto/used-2021-toyota-rav4-limited/126661218/",
  source: "autodev",
};

const NEED = {
  mode: "personal" as const,
  zip: "68114",
  repairAbility: "unknown" as const,
  targetProfitUsd: null,
};

describe("selected-listing full-analysis handoff", () => {
  it("preserves VIN + VDP from the find card without requiring VIN-in-URL", () => {
    const result = resolveSelectedListingHandoff(RAV4, NEED, "find_card_full_analysis");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.cta).toBe("find_card_full_analysis");
    expect(result.payload.surface).toBe("find");
    expect(result.payload.vin).toBe(RAV4.vin);
    expect(result.payload.url).toBe(RAV4.vdp);
    expect(result.payload.selectedVin).toBe(RAV4.vin);
    expect(result.payload.zip).toBe("68114");
    expect(result.payload.miles).toBe(21_001);
    // Fee-like feed figure must not be promoted as a typed asking price.
    expect(result.payload.askingPriceUsd).toBeUndefined();
  });

  it("still works when the dealer VDP is missing but VIN is present", () => {
    const result = resolveSelectedListingHandoff({ ...RAV4, vdp: null }, NEED);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.vin).toBe(RAV4.vin);
    expect(result.payload.url).toBeUndefined();
  });

  it("fails closed before charge when identity is missing", () => {
    const result = resolveSelectedListingHandoff(
      { ...RAV4, vin: "", vdp: "https://example.com/cars/no-vin-here" },
      NEED,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("missing_identity");
    expect(result.message).toMatch(/VIN/i);
  });

  it("fails closed for unsupported sources", () => {
    const result = resolveSelectedListingHandoff({ ...RAV4, source: "scraped_html" }, NEED);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("unsupported_source");
  });

  it("passes a credible ask through when the feed figure is usable", () => {
    const result = resolveSelectedListingHandoff({ ...RAV4, priceUsd: 18_900 }, NEED);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.askingPriceUsd).toBe(18_900);
  });
});

describe("manual URL / VIN check path", () => {
  it("accepts a listing URL that embeds a VIN", () => {
    const url = `https://dealer.example/listing/${RAV4.vin}`;
    const result = resolveManualCheckHandoff({
      mode: "personal",
      kind: "link",
      lookup: url,
      zip: "68114",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.cta).toBe("check_manual_url");
    expect(result.payload.vin).toBe(RAV4.vin);
    expect(result.payload.url).toBe(url);
  });

  it("rejects a URL without a VIN before any charge", () => {
    const result = resolveManualCheckHandoff({
      mode: "personal",
      kind: "link",
      lookup: "https://www.joemachenstoyota.com/auto/used-2021-toyota-rav4-limited/126661218/",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("missing_identity");
  });
});

describe("precharge analysis gate", () => {
  it("accepts VIN from the selected card even when URL has no VIN", () => {
    const gate = prechargeAnalysisGate({ vin: RAV4.vin, url: RAV4.vdp });
    expect(gate.ok).toBe(true);
    if (!gate.ok) return;
    expect(gate.vin).toBe(RAV4.vin);
  });

  it("rejects URL-only requests that lack a VIN before credits", () => {
    const gate = prechargeAnalysisGate({ url: RAV4.vdp });
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.error).toBe("vin_required");
  });
});

describe("trusted find analysis context (server-side)", () => {
  it("accepts selected-card VIN+VDP+find CTA without re-typing ask", () => {
    expect(
      isTrustedFindAnalysisContext({
        surface: "find",
        cta: "find_card_full_analysis",
        vin: RAV4.vin,
        url: RAV4.vdp,
        selectedVin: RAV4.vin,
        selectedVdp: RAV4.vdp,
        zip: "68114",
        miles: 21_001,
      }),
    ).toBe(true);
  });

  it("accepts no-VDP card when miles+ZIP were already found", () => {
    expect(
      isTrustedFindAnalysisContext({
        surface: "find",
        cta: "find_card_full_analysis",
        vin: RAV4.vin,
        selectedVin: RAV4.vin,
        miles: 21_001,
        zip: "68114",
      }),
    ).toBe(true);
  });

  it("rejects counterfeit surface:find + VIN-only without found-listing facts", () => {
    expect(
      isTrustedFindAnalysisContext({
        surface: "find",
        vin: RAV4.vin,
      }),
    ).toBe(false);
    expect(
      isTrustedFindAnalysisContext({
        surface: "find",
        cta: "find_card_full_analysis",
        vin: RAV4.vin,
        selectedVin: RAV4.vin,
      }),
    ).toBe(false);
  });

  it("rejects mismatched selectedVin even with find CTA", () => {
    expect(
      isTrustedFindAnalysisContext({
        surface: "find",
        cta: "find_card_full_analysis",
        vin: RAV4.vin,
        selectedVin: "1HGCM82633A004352",
        url: RAV4.vdp,
      }),
    ).toBe(false);
  });
});
