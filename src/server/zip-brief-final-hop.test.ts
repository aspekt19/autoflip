/**
 * Golden/unit coverage for ZIP URL, no re-brief after confirm,
 * verdict features only on final hop, and chat run record shape.
 */
import { describe, expect, it } from "vitest";
import { zipLookupUrl } from "@/io/autodev";
import { parseShopperBrief, formatShopperBriefCard } from "@/domain/shopper-brief";
import { resolveAgentServStep } from "@/server/serv/agent-serv-features";
import { createFindAgentToolState, executeFindAgentTool } from "@/server/find-agent/tools";
import { TtlCache } from "@/io/cache";
import { MemoryCounter } from "@/io/quota";
import { validateFindSubmitPicks } from "@/domain/find-agent";

describe("ZIP lookup URL", () => {
  it("uses /api/zip/{code} (docs.auto.dev zip-lookup)", () => {
    expect(zipLookupUrl("98101")).toBe("https://api.auto.dev/api/zip/98101");
    expect(zipLookupUrl("37201")).toContain("/api/zip/37201");
    expect(zipLookupUrl("43215")).not.toMatch(/\.dev\/zip\//);
  });
});

describe("no re-brief after confirm", () => {
  it("rejects submit_brief once briefConfirmed", async () => {
    const state = createFindAgentToolState();
    state.requireBriefConfirm = true;
    state.briefConfirmed = true;
    const rejected = await executeFindAgentTool(
      "submit_brief",
      {
        summary: "SUV under 25k",
        budget: { maxUsd: 25_000, userQuote: "under $25k" },
        zip: "43215",
        radiusMi: 50,
        notes: null,
      },
      {
        fetch: (async () => new Response("{}", { status: 500 })) as typeof fetch,
        autodevKey: "test",
        autodev: { cache: new TtlCache(), counter: new MemoryCounter() },
        chatTranscript: "Shopper: under $25k near Columbus",
      },
      state,
    );
    expect(rejected.ok).toBe(false);
    expect(rejected.result.error).toBe("brief_already_confirmed");
  });

  it("rejects ask_shopper after confirm unless ZIP geocode failed", async () => {
    const deps = {
      fetch: (async () => new Response("{}", { status: 500 })) as typeof fetch,
      autodevKey: "test",
      autodev: { cache: new TtlCache(), counter: new MemoryCounter() },
      chatTranscript: "Shopper: under $25k near Columbus",
    };
    const blocked = createFindAgentToolState();
    blocked.requireBriefConfirm = true;
    blocked.briefConfirmed = true;
    blocked.zipGeocodeFailed = false;
    const rejected = await executeFindAgentTool(
      "ask_shopper",
      { question: "What budget works for you?" },
      deps,
      blocked,
    );
    expect(rejected.ok).toBe(false);
    expect(rejected.result.error).toBe("brief_confirmed_search_now");

    const allowed = createFindAgentToolState();
    allowed.requireBriefConfirm = true;
    allowed.briefConfirmed = true;
    allowed.zipGeocodeFailed = true;
    const asked = await executeFindAgentTool(
      "ask_shopper",
      { question: "That ZIP did not geocode. Could you share a nearby residential ZIP?" },
      deps,
      allowed,
    );
    expect(asked.ok).toBe(true);
    expect(allowed.zipGeocodeFailed).toBe(false);
  });
});

describe("verdict features only on final hop", () => {
  it("keeps search step after searchCount>0 until selectionHop (nudge alone is not verdict)", () => {
    expect(
      resolveAgentServStep({
        requireBriefConfirm: true,
        briefConfirmed: true,
        searchCount: 4,
        submitNudgeSent: false,
      }),
    ).toBe("search");
    expect(
      resolveAgentServStep({
        requireBriefConfirm: true,
        briefConfirmed: true,
        searchCount: 4,
        submitNudgeSent: true,
      }),
    ).toBe("search");
    expect(
      resolveAgentServStep({
        requireBriefConfirm: true,
        briefConfirmed: true,
        searchCount: 4,
        submitNudgeSent: true,
        selectionHop: true,
      }),
    ).toBe("verdict");
  });
});

describe("confirmed brief + picks run record shape", () => {
  it("parses structured hard/soft constraints from submit_brief (no chat parse)", () => {
    const parsed = parseShopperBrief({
      summary: "Family SUV near Seattle",
      budget: { maxUsd: 30_000, userQuote: "30k" },
      zip: "98101",
      radiusMi: 40,
      notes: null,
      hardConstraints: [{ key: "body", value: "SUV" }],
      softConstraints: [{ key: "color", value: "any" }],
      agreedRelaxations: [{ key: "radius", value: "shopper OK to 60 mi" }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const card = formatShopperBriefCard(parsed.brief);
    expect(card).toMatch(/Budget: \$30,000/);
    expect(card).toMatch(/98101/);
    expect(card).toMatch(/40 mi/);
    expect(card).not.toMatch(/nationwide OK/i);
    expect(card).toMatch(/Hard: body=SUV/);
    expect(card).toMatch(/Agreed relaxations/);
  });

  it("rejects zip + null radiusMi (no nationwide OK for a city search)", () => {
    const parsed = parseShopperBrief({
      summary: "Coupe near Phoenix",
      budget: { maxUsd: 18_000, userQuote: "18k" },
      zip: "85001",
      radiusMi: null,
      notes: null,
    });
    expect(parsed.ok).toBe(false);
  });

  it("rejects picks outside confirmed radius unless widen agreed", () => {
    const vin = "4T1DAACK0TU295949";
    const listings = new Map([
      [vin, { vin, priceUsd: 22_000, miles: 30_000, distanceMiles: 120 }],
    ]);
    const outside = validateFindSubmitPicks(
      {
        summary: "Far car",
        confidence: "medium",
        picks: [{ vin, label: "Camry", action: "buy", offerUsd: 21_000, why: "ok" }],
        relaxedConditions: [],
        passReason: null,
      },
      { listingsByVin: listings, budgetUsd: 25_000, maxRadiusMi: 50, radiusWidenAgreed: false },
    );
    expect(outside.ok).toBe(false);
    const inside = validateFindSubmitPicks(
      {
        summary: "Far but agreed",
        confidence: "medium",
        picks: [{ vin, label: "Camry", action: "buy", offerUsd: 21_000, why: "ok" }],
        relaxedConditions: [],
        passReason: null,
      },
      { listingsByVin: listings, budgetUsd: 25_000, maxRadiusMi: 50, radiusWidenAgreed: true },
    );
    expect(inside.ok).toBe(true);
  });
});
