/**
 * Architecture enforcement for the SERV ↔ code boundary.
 * These tests must FAIL if the architecture is violated.
 */
import { describe, expect, it } from "vitest";
import type { Listing } from "@/domain/types";
import {
  assertAgentLoopRanForFinalResult,
  assertAgentRequestReasoningEffort,
  assertNoNonUserSetConstraints,
  assertReasoningEffortNotNone,
  assertThinSearchProxyDidNotDropProductRows,
  buildThinSearchProxyResult,
  buildUserIntent,
  buildUserIntentFromFlatForm,
  filterRealRelaxedConditions,
  liveEvalOutcomeOk,
  mapBodyStyleForProvider,
  mustNotSubstituteCodeDecision,
  normalizeRelaxedConditions,
  normalizeServAgentReasoningEffort,
  serializeUserIntentConstraints,
  validateServAnswer,
} from "./serv-boundary";
import { buildServChatTurnBody, buildServResponsesTurnBody } from "@/server/serv/agent-chat-turn";

function listing(partial?: Partial<Listing>): Listing {
  return {
    vin: "JTMRWRFV0KJ123456",
    year: 2018,
    make: "Toyota",
    model: "Camry",
    trim: "LE",
    miles: 62000,
    priceUsd: 14_500,
    city: "Columbus",
    state: "OH",
    zip: "43215",
    dealer: "Test",
    vdp: "https://example.com/vdp",
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: false,
    accidentCount: 0,
    oneOwner: true,
    ownerCount: 1,
    usageType: null,
    fuel: "Gasoline",
    engine: null,
    drivetrain: "FWD",
    transmission: "Automatic",
    bodyStyle: "Car",
    style: "Sedan",
    distanceMiles: 42,
    createdAt: "2026-01-01T00:00:00.000Z",
    latitude: null,
    longitude: null,
    removedAt: null,
    source: "autodev",
    ...partial,
  };
}

describe("UserIntent — only origin=user Form edits to SERV", () => {
  it("does not extract constraints from the note — fields stay empty without user form", () => {
    const intent = buildUserIntent({ note: "reliable car under $12,000 near 43215" });
    expect(intent.fields).toEqual({});
    const serialized = serializeUserIntentConstraints(intent);
    expect(serialized).toEqual({});
    expect(assertNoNonUserSetConstraints(serialized, intent).ok).toBe(true);
  });

  it("FAILS architecture when a non-user-set value reaches SERV as a constraint", () => {
    const intent = buildUserIntent({ note: "budget $10k" });
    const leaked = {
      ...serializeUserIntentConstraints(intent),
      radiusMi: { value: 100, provenance: "default" },
    };
    const check = assertNoNonUserSetConstraints(leaked, intent);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.hits.some((h) => h.key === "radiusMi")).toBe(true);
    }
  });

  it("FAILS architecture when note provenance is sent as Form edits", () => {
    const intent = buildUserIntent({ note: "SUV under 20k" });
    const padded = {
      priceMaxUsd: { value: 20_000, provenance: "note", origin: "note" },
      yearMin: null,
      milesMax: null,
      radiusMi: null,
    };
    const check = assertNoNonUserSetConstraints(padded, intent);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.hits.some((h) => h.key === "priceMaxUsd")).toBe(true);
      expect(check.hits.some((h) => h.key === "yearMin")).toBe(true);
      expect(check.hits.some((h) => h.key === "radiusMi")).toBe(true);
    }
  });

  it("flat bare numbers are not user-origin; note is not parsed into fields", () => {
    const intent = buildUserIntentFromFlatForm({
      note: "under $11k near 43215",
      form: { budgetUsd: 11_000, zip: "43215", yearMin: null, milesMax: null, distanceMiles: null },
    });
    // Bare finite values must NOT become user form — and code must not invent note fields.
    expect(intent.fields.priceMaxUsd).toBeUndefined();
    expect(intent.fields.zip).toBeUndefined();
    expect(intent.fields.yearMin).toBeUndefined();
    expect(intent.fields.milesMax).toBeUndefined();
    expect(intent.fields.radiusMi).toBeUndefined();
    expect(serializeUserIntentConstraints(intent)).toEqual({});
    expect(assertNoNonUserSetConstraints(serializeUserIntentConstraints(intent), intent).ok).toBe(
      true,
    );
  });

  it("user-origin (and legacy dirty) flat edits become form constraints", () => {
    const intent = buildUserIntentFromFlatForm({
      note: "SUV",
      form: {
        priceMaxUsd: { value: 15_000, dirty: true },
        radiusMi: { value: null, origin: "user" },
      },
    });
    expect(intent.fields.priceMaxUsd).toEqual({
      value: 15_000,
      provenance: "user",
      origin: "user",
    });
    expect(intent.fields.radiusMi).toEqual({ value: null, provenance: "user", origin: "user" });
    expect(serializeUserIntentConstraints(intent)).toEqual({
      priceMaxUsd: { value: 15_000, origin: "user", provenance: "user" },
      radiusMi: { value: null, origin: "user", provenance: "user" },
    });
  });
});

describe("search_listings thin proxy — must not drop product-filter rows", () => {
  it("maps Sedan omit and crossover→SUV as vocabulary only", () => {
    expect(mapBodyStyleForProvider("Sedan")).toBeNull();
    expect(mapBodyStyleForProvider("crossover")).toBe("SUV");
    expect(mapBodyStyleForProvider("SUV")).toBe("SUV");
  });

  it("returns unfiltered normalized provider rows with observational funnel", () => {
    const provider = [
      listing(),
      listing({
        vin: "JTMRWRFV0KJ123457",
        bodyStyle: "SUV",
        style: "SUV",
        model: "RAV4",
        priceUsd: 25_000,
      }),
    ];
    const funnel = [
      { step: "provider_raw" as const, count: 2 },
      { step: "normalized_vin_ymm" as const, count: 2 },
      { step: "passenger_gate" as const, count: 2 },
      { step: "transmission" as const, count: 2 },
      { step: "body_family" as const, count: 1 },
      { step: "price" as const, count: 1 },
      { step: "miles" as const, count: 1 },
      { step: "radius" as const, count: 1 },
    ];
    const proxy = buildThinSearchProxyResult({
      providerListings: provider,
      params: { bodyStyle: "Sedan", priceMaxUsd: 15_000 },
      funnel,
    });
    expect(proxy.listings).toHaveLength(2);
    expect(proxy.productFiltersWouldDrop).toBe(true);
    expect(proxy.providerMapping.providerBodyStyle).toBeNull();
    expect(
      assertThinSearchProxyDidNotDropProductRows({
        providerListings: provider,
        returnedListings: proxy.listings,
      }).ok,
    ).toBe(true);
  });

  it("FAILS architecture when search_listings drops rows for a product filter", () => {
    const provider = [
      listing(),
      listing({ vin: "JTMRWRFV0KJ123457", bodyStyle: "SUV", style: "SUV", model: "RAV4" }),
    ];
    const gate = assertThinSearchProxyDidNotDropProductRows({
      providerListings: provider,
      returnedListings: [listing()],
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.detail).toMatch(/dropped VIN/i);
  });
});

describe("SERV answer validator — repair issues, never substitute", () => {
  it("rejects invented VIN and forbids code substitution", () => {
    const listings = new Map([
      ["JTMRWRFV0KJ123456", { vin: "JTMRWRFV0KJ123456", priceUsd: 14_500, miles: 62_000 }],
    ]);
    const validated = validateServAnswer({
      picks: [{ vin: "INVENTEDVIN0000001", offerUsd: 10_000 }],
      listingsByVin: listings,
      budgetUsd: 15_000,
    });
    expect(validated.ok).toBe(false);
    expect(
      mustNotSubstituteCodeDecision({
        validationOk: false,
        substitutedPickVin: "JTMRWRFV0KJ123456",
      }).ok,
    ).toBe(false);
  });

  it("flags price / miles / budget / code-math mismatches as repair issues", () => {
    const listings = new Map([
      ["JTMRWRFV0KJ123456", { vin: "JTMRWRFV0KJ123456", priceUsd: 14_500, miles: 62_000 }],
    ]);
    const validated = validateServAnswer({
      picks: [
        {
          vin: "JTMRWRFV0KJ123456",
          offerUsd: 16_000,
          claimedPriceUsd: 13_000,
          claimedMiles: 50_000,
          claimedCodeMathUsd: 999,
        },
      ],
      listingsByVin: listings,
      budgetUsd: 15_000,
      codeMathByVin: new Map([["JTMRWRFV0KJ123456", 1_200]]),
    });
    expect(validated.ok).toBe(false);
    if (!validated.ok) {
      const fields = validated.issues.map((i) => i.field);
      expect(fields.some((f) => f.includes("offerUsd"))).toBe(true);
      expect(fields.some((f) => f.includes("price"))).toBe(true);
      expect(fields.some((f) => f.includes("miles"))).toBe(true);
      expect(fields.some((f) => f.includes("codeMath"))).toBe(true);
    }
  });

  it("rejects listing asking above confirmed budget even when offerUsd is within budget", () => {
    const listings = new Map([
      ["4T1DAACK0TU295949", { vin: "4T1DAACK0TU295949", priceUsd: 25_835, miles: 5_173 }],
    ]);
    const validated = validateServAnswer({
      picks: [{ vin: "4T1DAACK0TU295949", offerUsd: 25_000 }],
      listingsByVin: listings,
      budgetUsd: 25_000,
    });
    expect(validated.ok).toBe(false);
    if (!validated.ok) {
      expect(validated.issues.some((i) => i.field.includes("price") && /25,?835/.test(i.message))).toBe(
        true,
      );
    }
  });
});

describe("Find/Resale final result requires agent loop", () => {
  it("FAILS architecture when a final result is returned without the agent loop", () => {
    for (const product of ["find", "resale"] as const) {
      const gate = assertAgentLoopRanForFinalResult({
        product,
        isFinalResult: true,
        agentLoopRan: false,
      });
      expect(gate.ok).toBe(false);
      if (!gate.ok) expect(gate.detail).toMatch(/without the agent loop/i);
    }
  });

  it("passes when the agent loop settled the final result", () => {
    expect(
      assertAgentLoopRanForFinalResult({
        product: "find",
        isFinalResult: true,
        agentLoopRan: true,
        toolRounds: 3,
        verdictReached: true,
      }).ok,
    ).toBe(true);
  });
});

describe("reasoning_effort — never none on agent builders", () => {
  it("normalizes none → low and rejects none on assert", () => {
    expect(normalizeServAgentReasoningEffort("none")).toBe("low");
    expect(assertReasoningEffortNotNone("none").ok).toBe(false);
    expect(assertReasoningEffortNotNone("low").ok).toBe(true);
  });

  it("chat/responses builders never emit reasoning_effort none", () => {
    const chat = buildServChatTurnBody({
      messages: [{ role: "user", content: "hi" }],
      reasoningEffort: "none",
    });
    expect(assertAgentRequestReasoningEffort(chat).ok).toBe(true);
    expect(chat.reasoning_effort).not.toBe("none");

    const responses = buildServResponsesTurnBody({
      instructions: "sys",
      input: "hi",
      reasoning: { effort: "none" },
    });
    expect(assertAgentRequestReasoningEffort(responses).ok).toBe(true);
    expect((responses.reasoning as { effort: string }).effort).not.toBe("none");
  });
});

describe("reasoning_effort — sweep every SERV profile / request builder", () => {
  it("every profile requestFor body has reasoning_effort !== none (or omits the field)", async () => {
    const profiles = await import("@/server/serv/profiles");
    const { requestFor } = await import("@/server/serv/run");
    const ids = Object.keys(profiles.PROFILES) as Array<keyof typeof profiles.PROFILES>;
    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) {
      const entry = profiles.PROFILES[id];
      expect((entry.reasoningEffort as string) === "none").toBe(false);
      const body = requestFor(id, "sweep") as Record<string, unknown>;
      const effort =
        typeof body.reasoning_effort === "string"
          ? body.reasoning_effort
          : body.reasoning && typeof body.reasoning === "object" && !Array.isArray(body.reasoning)
            ? (body.reasoning as { effort?: unknown }).effort
            : undefined;
      if (effort !== undefined) {
        expect(effort, `${id} reasoning effort`).not.toBe("none");
        expect(assertReasoningEffortNotNone(effort).ok, `${id} assert`).toBe(true);
      }
      expect(assertAgentRequestReasoningEffort(body as Record<string, unknown>).ok, `${id} body`).toBe(
        true,
      );
    }
    // Agent builders are also request builders for the agent loop.
    expect(
      assertAgentRequestReasoningEffort(
        buildServChatTurnBody({ messages: [{ role: "user", content: "hi" }], reasoningEffort: "low" }),
      ).ok,
    ).toBe(true);
    expect(
      assertAgentRequestReasoningEffort(
        buildServResponsesTurnBody({ instructions: "sys", input: "hi", reasoning: { effort: "low" } }),
      ).ok,
    ).toBe(true);
  });
});

describe("relaxedConditions — real text, never redacted", () => {
  it("rejects redacted placeholders and synthesizes from searches", () => {
    expect(
      filterRealRelaxedConditions([
        { name: "redacted", why: "redacted" },
        { name: "radius", why: "Opened to 100 miles for inventory." },
      ]),
    ).toHaveLength(1);
    const normalized = normalizeRelaxedConditions({
      relaxed: [{ name: "redacted", why: "redacted" }],
      searches: [
        {
          params: { zip: "43215", radiusMi: 100, priceMaxUsd: 11_000 },
          resultCount: 0,
          funnel: [{ step: "provider_raw", count: 0 }],
        },
      ],
    });
    expect(normalized.rejectedPlaceholder).toBe(true);
    expect(normalized.relaxed[0]?.why).not.toMatch(/redacted/i);
    expect(normalized.relaxed[0]?.why).toMatch(/43215/);
  });
});

describe("eval ok — chosen OR documented nothing-fits; chosenListingCount separate", () => {
  it("ok with chosen listing and chosenListingCount=1", () => {
    expect(
      liveEvalOutcomeOk({
        failure: null,
        chosenVin: "JTMRWRFV0KJ123456",
        verdictReached: true,
        scoring: { complete: true, kind: "chosen" },
      }),
    ).toEqual({ ok: true, chosenListingCount: 1 });
  });

  it("ok with documented nothing-fits and chosenListingCount=0", () => {
    expect(
      liveEvalOutcomeOk({
        failure: null,
        chosenVin: null,
        verdictReached: true,
        scoring: { complete: true, kind: "nothing_fits" },
      }),
    ).toEqual({ ok: true, chosenListingCount: 0 });
  });

  it("not ok when neither chosen nor documented nothing-fits", () => {
    const out = liveEvalOutcomeOk({
      failure: null,
      chosenVin: null,
      verdictReached: false,
      scoring: { complete: false, issues: ["incomplete"] },
    });
    expect(out.ok).toBe(false);
    expect(out.chosenListingCount).toBe(0);
  });
});
