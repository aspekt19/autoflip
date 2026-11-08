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
  analysisContextToken: "server-minted-token-abc",
};

const NEED = {
  mode: "personal" as const,
  zip: "68114",
  repairAbility: "unknown" as const,
  targetProfitUsd: null,
};

describe("selected-listing full-analysis handoff", () => {
  it("preserves VIN + VDP + server token from the find card without requiring VIN-in-URL", () => {
    const result = resolveSelectedListingHandoff(RAV4, NEED, "find_card_full_analysis");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.cta).toBe("find_card_full_analysis");
    expect(result.payload.surface).toBe("find");
    expect(result.payload.vin).toBe(RAV4.vin);
    expect(result.payload.url).toBe(RAV4.vdp);
    expect(result.payload.selectedVin).toBe(RAV4.vin);
    expect(result.payload.findContextToken).toBe("server-minted-token-abc");
    expect(result.payload.zip).toBe("68114");
    expect(result.payload.miles).toBe(21_001);
    // Fee-like feed figure must not be promoted as a typed asking price.
    expect(result.payload.askingPriceUsd).toBeUndefined();
  });

  it("fails closed when the card lacks a server analysis token", () => {
    const result = resolveSelectedListingHandoff({ ...RAV4, analysisContextToken: null }, NEED);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/server analysis token/i);
  });

  it("still works when the dealer VDP is missing but VIN + token are present", () => {
    const result = resolveSelectedListingHandoff({ ...RAV4, vdp: null }, NEED);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.vin).toBe(RAV4.vin);
    expect(result.payload.url).toBeUndefined();
    expect(result.payload.findContextToken).toBe("server-minted-token-abc");
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
    expect(result.payload.findContextToken).toBeUndefined();
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

  it("rejects an invalid 17-character VIN before submit (check digit)", () => {
    const result = resolveManualCheckHandoff({
      mode: "personal",
      kind: "vin",
      lookup: "4T1KZ1AK5MU060006",
      askingPriceUsd: 18_000,
      miles: 40_000,
      zip: "68114",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("invalid_vin");
    expect(result.message).toMatch(/valid 17-character VIN/i);
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

describe("client heuristics are NOT a trust boundary", () => {
  it("forged evil VDP + matching selectedVin + CTA must NOT grant trust", () => {
    expect(
      isTrustedFindAnalysisContext({
        surface: "find",
        cta: "find_card_full_analysis",
        vin: RAV4.vin,
        url: "https://evil.example/vdp",
        selectedVin: RAV4.vin,
        selectedVdp: "https://evil.example/vdp",
        zip: "68114",
        miles: 21_001,
      }),
    ).toBe(false);
  });

  it("zip 00000 + miles heuristics must NOT grant trust", () => {
    expect(
      isTrustedFindAnalysisContext({
        surface: "find",
        cta: "find_card_full_analysis",
        vin: RAV4.vin,
        selectedVin: RAV4.vin,
        miles: 21_001,
        zip: "00000",
      }),
    ).toBe(false);
  });

  it("even a well-formed client payload without server verification is untrusted", () => {
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
    ).toBe(false);
  });
});
