import { describe, expect, it, vi } from "vitest";
import { MemoryKv } from "@/io/kv";
import { TtlCache } from "@/io/cache";
import { MemoryCounter } from "@/io/quota";
import { dedupeWarningMessages, runFindMatch } from "./find-match";
import { proposeDirections } from "@/domain/directions";
import { explicitNeedFromText, validateNeed } from "@/domain/need";
import { resolveSelectedListingHandoff } from "@/domain/find-analysis-handoff";

const RAV4_VIN = "2T3N1RFV6MC246998";

function listingRow(over: { vin: string; make: string; model: string; year?: number; price: number; vdp?: string | null }) {
  return {
    vin: over.vin,
    vehicle: { year: over.year ?? 2021, make: over.make, model: over.model, trim: "Limited" },
    retailListing: {
      price: over.price,
      miles: 21_001,
      used: true,
      city: "Columbia",
      state: "MO",
      zip: "65202",
      vdp: over.vdp ?? "https://www.joemachenstoyota.com/auto/used-2021-toyota-rav4-limited/126661218/",
      primaryImage: null,
    },
  };
}

function servAllow() {
  return Response.json({ choices: [{ message: { content: "ALLOW" } }] });
}

describe("/find fee-price must not budget-match (owner RAV4 $587)", () => {
  it("excludes the Admin-Fee-sized feed figure from within-budget results", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const href = String(url);
      if (href.includes("openserv") || href.includes("inference") || href.includes("chat/completions")) {
        return servAllow();
      }
      return Response.json({
        data: [listingRow({ vin: RAV4_VIN, make: "Toyota", model: "RAV4", price: 587 })],
      });
    });

    const need = {
      mode: "personal",
      useCase: "family",
      budgetUsd: 20_000,
      budgetKnown: true,
      preferredModels: [{ make: "Toyota", model: "RAV4" }],
      preferredMakes: ["Toyota"],
      preferredModelsSource: "user_note",
      openToOtherMakes: true,
      zip: "68114",
      distanceMiles: 500,
      milesMax: null,
      note: "I like the Toyota RAV4 under $20,000",
    };

    const result = await runFindMatch(
      { need },
      {
        autodevKey: "test-key",
        servKey: "serv",
        fetch: fetchImpl as typeof fetch,
        autodev: { cache: new TtlCache<unknown>(), counter: new MemoryCounter() },
        kv: new MemoryKv(),
        env: {},
        maxProviderQueries: 4,
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = result.body.directions.flatMap((g) => g.listings);
    expect(rows.some((row) => row.vin === RAV4_VIN)).toBe(false);
    expect(rows.every((row) => row.priceUsd == null || row.priceUsd !== 587)).toBe(true);
  });

  it("keeps a credible in-budget ask and attaches price provenance", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const href = String(url);
      if (href.includes("openserv") || href.includes("inference") || href.includes("chat/completions")) {
        return servAllow();
      }
      return Response.json({
        data: [listingRow({ vin: RAV4_VIN, make: "Toyota", model: "RAV4", year: 2019, price: 17_900 })],
      });
    });

    const result = await runFindMatch(
      {
        need: {
          mode: "personal",
          useCase: "family",
          budgetUsd: 20_000,
          budgetKnown: true,
          preferredModels: [{ make: "Toyota", model: "RAV4" }],
          preferredMakes: ["Toyota"],
          preferredModelsSource: "user_note",
          openToOtherMakes: false,
          zip: "68114",
          distanceMiles: 500,
          note: "Toyota RAV4 under 20000",
        },
      },
      {
        autodevKey: "test-key",
        servKey: "serv",
        fetch: fetchImpl as typeof fetch,
        autodev: { cache: new TtlCache<unknown>(), counter: new MemoryCounter() },
        kv: new MemoryKv(),
        env: {},
        maxProviderQueries: 4,
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const car = result.body.directions.flatMap((g) => g.listings).find((row) => row.vin === RAV4_VIN);
    expect(car).toBeTruthy();
    expect(car!.priceView.usableForBudget).toBe(true);
    expect(car!.priceView.displayPrimary).toBe("$17,900");
  });
});

describe("models attribution provenance", () => {
  it("does not say Models you named when only the service suggested models", () => {
    const need = validateNeed({
      ...explicitNeedFromText("Looking for a reliable family SUV around $20,000 near 68114", "personal"),
      preferredModels: [
        { make: "Mazda", model: "CX-5" },
        { make: "Toyota", model: "RAV4" },
      ],
      preferredModelsSource: "service",
      preferredMakes: ["Mazda", "Toyota"],
      openToOtherMakes: true,
      zip: "68114",
      distanceMiles: 100,
      budgetUsd: 20_000,
      budgetKnown: true,
    });
    expect(need.ok).toBe(true);
    if (!need.ok) return;
    const directions = proposeDirections(need.need, undefined, new Date("2026-11-08T00:00:00Z"));
    expect(directions[0]?.segment).toBe("Suggested models");
    expect(directions[0]?.segment).not.toMatch(/you named/i);
    expect(directions[0]?.why).toMatch(/suggested/i);
    expect(directions[0]?.why).not.toMatch(/^You named/i);
  });

  it("keeps Models you named when preferred models are form/SERV-labeled", () => {
    const need = {
      ...explicitNeedFromText("family SUV under $20,000", "personal"),
      zip: "68114",
      distanceMiles: 100,
      budgetUsd: 20_000,
      budgetKnown: true,
      preferredModels: [
        { make: "Mazda", model: "CX-5" },
        { make: "Toyota", model: "RAV4" },
      ],
      preferredModelsSource: "user_note" as const,
      openToOtherMakes: true,
    };
    const directions = proposeDirections(need, undefined, new Date("2026-11-08T00:00:00Z"));
    expect(directions[0]?.segment).toBe("Models you named");
  });
});

describe("warning dedupe", () => {
  it("collapses duplicate listing-lookup warnings without hiding distinct coverage text", () => {
    const out = dedupeWarningMessages([
      "Some model searches failed. Showing only the live rows that returned. The listing lookup did not respond.",
      "The listing lookup did not respond.",
      "The listing lookup did not respond.",
      "Coverage incomplete: Mazda CX-5 (timeout) did not return a successful provider response.",
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/Some model searches failed/);
    expect(out[1]).toMatch(/Coverage incomplete/);
  });
});

describe("CTA handoff from find card", () => {
  it("traces find_card_full_analysis and keeps VIN when VDP has no VIN", () => {
    const handoff = resolveSelectedListingHandoff(
      {
        vin: RAV4_VIN,
        year: 2021,
        make: "Toyota",
        model: "RAV4",
        miles: 21_001,
        priceUsd: 587,
        vdp: "https://www.joemachenstoyota.com/auto/used-2021-toyota-rav4-limited/126661218/",
        source: "autodev",
        analysisContextToken: "find-ctx-token-from-match",
      },
      { mode: "personal", zip: "68114" },
      "find_card_full_analysis",
    );
    expect(handoff.ok).toBe(true);
    if (!handoff.ok) return;
    expect(handoff.payload.cta).toBe("find_card_full_analysis");
    expect(handoff.payload.vin).toBe(RAV4_VIN);
    expect(handoff.payload.url).toContain("joemachenstoyota.com");
    expect(handoff.payload.findContextToken).toBe("find-ctx-token-from-match");
  });
});
