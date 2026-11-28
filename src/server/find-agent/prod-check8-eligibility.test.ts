import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { StructuredNeed } from "@/domain/need";
import type { ShopperBrief } from "@/domain/shopper-brief";
import { findEligibilityContextFrom, normKey } from "@/domain/find-hard-eligibility";
import { enforceFindHardEligibility, gateFindPublishedResult } from "@/domain/find-publish-eligibility";
import { priceRiskFor } from "@/domain/price-risk";
import { formatJournalProvenanceLines } from "@/domain/serv-decision-journal-copy";
import { gateFindGraphDecideInput, runFindGraphDecide } from "@/server/find-graph-decide";
import { mapFindAgentLoopToDecide } from "./map-to-decide";
import fixture from "./fixtures/prod-check8-b50f0b05.json";

/**
 * Prod check 8 (run b50f0b05, 2026-11-28 13:22 Europe/Kirov) published a 2026 Chevrolet
 * Silverado 1500 pickup for a sedan brief. Evidence from the persisted session:
 *
 * - SERV wrote the hard constraint as `body_style: sedan`. normKey kept the underscore and
 *   BODY_KEYS had no "body_style", so the sedan limit was dropped on every path (the persisted
 *   need.bodyStyle is null). The Silverado (offerPool, zip 75041) and two SUVs then passed
 *   every eligibility filter and reached the shortlist and the graph's input.
 * - The graph picked Sentra 3N1AB8CV1SY362757, inspect first. cleanLowerMileAlternative
 *   (#230 bc32c3c, wired into the graph-primary path by #237 e961296) replaced it with the
 *   lowest-miles car "with no reported accident"; the Silverado's unknown accident count counted
 *   as clean, so code published the pickup with "Code overrode the graph pick".
 */

const SILVERADO = "3GCUKHEL5TG323344";
const CHEROKEE = "1C4PJLLBXLD548806";
const MURANO = "5N1AZ2MG1JN137705";
const GRAPH_SENTRA = "3N1AB8CV1SY362757";
const LOOP_SENTRA = "3N1AB8CV5SY312167";
const NOT_SEDANS = [SILVERADO, CHEROKEE, MURANO];

const brief = fixture.brief as unknown as ShopperBrief;
const listings = fixture.listings as unknown as Array<{ vin: string } & Record<string, unknown>>;
const need = {
  mode: "personal",
  note: fixture.brief.summary,
  budgetUsd: 15_000,
  budgetKnown: true,
  zip: "75201",
  distanceMiles: 50,
  milesMax: 100_000,
  yearMin: null,
  yearMax: null,
  bodyStyle: fixture.persistedNeedBodyStyle,
  mustHaves: [],
  priorities: [],
} as unknown as StructuredNeed;

function loop() {
  return mapFindAgentLoopToDecide({
    agent: {
      ok: true,
      agentMode: "tools",
      toolRounds: 13,
      verdictReached: true,
      verdict: {
        summary: "Sentra 312167 first; Elantra second.",
        confidence: "medium",
        picks: [
          { vin: LOOP_SENTRA, label: "2025 Nissan Sentra", action: "inspect_first", offerUsd: null, why: "fits the brief" },
          { vin: "KMHLM4DG8TU121240", label: "2026 Hyundai Elantra", action: "inspect_first", offerUsd: null, why: "low miles" },
        ],
        relaxedConditions: [],
        passReason: null,
      },
      droppedPicks: [],
      listingsByVin: new Map(listings.map((l) => [l.vin, l])),
      journal: [],
      relaxedConditions: [],
    } as never,
  });
}

/** The graph's recorded answer for this run, as decide/challenge JSON. */
const decide = {
  pickKey: GRAPH_SENTRA,
  action: "inspect_first",
  confidence: "medium",
  confidenceWhy:
    "This Sentra fits the sedan, price, and mileage limits and has fewer miles than the other Sentra at the same asking price.",
  reasons: [
    {
      text: "Fewer miles than the other Sentra at the same asking price.",
      evidenceIds: [`car:${GRAPH_SENTRA}`, `car:${LOOP_SENTRA}`],
    },
  ],
  watchOuts: ["The reported accident is a specific risk to have an inspection settle."],
  askSeller: ["Repair records for the reported accident?"],
  alternatives: [{ key: LOOP_SENTRA, whyNot: "More miles at the same asking price." }],
  offerUsd: null,
};
const challenge = {
  agree: false,
  issues: [{ text: "Noted its reported accident.", evidenceIds: [`car:${GRAPH_SENTRA}`] }],
  revised: { pickKey: GRAPH_SENTRA, action: "inspect_first", confidence: "medium" },
};

function graphFetch(pickKey = GRAPH_SENTRA) {
  return vi.fn(async () =>
    new Response(JSON.stringify({ output_text: JSON.stringify({ decide: { ...decide, pickKey }, challenge }) }), {
      status: 200,
      headers: { "Content-Type": "application/json", "x-openserv-request-id": fixture.runId },
    }),
  ) as unknown as typeof fetch;
}

function run(mapped: ReturnType<typeof loop>, fetchImpl: typeof fetch) {
  return runFindGraphDecide({
    need,
    bestDeal: mapped.bestDeal,
    agentVerdict: mapped.agentVerdict,
    shortlistKeys: mapped.shortlistKeys,
    marketPool: mapped.offerPool,
    brief,
    eligibility: findEligibilityContextFrom({ need, brief }),
    servKey: "test-key",
    servBaseUrl: "https://serv.test/v1",
    fetchImpl,
    remainingRouteMs: 200_000,
    graphId: fixture.graphId,
  });
}

describe("prod check 8 replay (b50f0b05)", () => {
  it("fixture is the failing run: the sedan limit is spelled body_style and the Silverado was published", () => {
    expect(fixture.brief.hardConstraints.find((c) => c.value === "sedan")?.key).toBe("body_style");
    expect(fixture.persistedNeedBodyStyle).toBeNull();
    expect(fixture.publishedBeforeFix).toBe(SILVERADO);
    expect(fixture.graphRawResponse).toMatch(new RegExp(`^Pick: ${GRAPH_SENTRA}`));
    expect(fixture.graphRawResponse).not.toContain(SILVERADO);
  });

  it("reads body_style, bodyStyle, Body style and body-style as the same sedan limit", () => {
    for (const key of ["body_style", "bodyStyle", "Body style", "body-style", "BODY_TYPE"]) {
      expect(normKey(key)).toMatch(/^body(style|type)$/);
      const ctx = findEligibilityContextFrom({
        need: null,
        brief: { ...brief, hardConstraints: [{ key, value: "sedan" }] } as ShopperBrief,
      });
      expect(ctx.bodyStyle, key).toBe("sedan");
    }
  });

  it("keeps the pickup and SUVs out of the graph input", () => {
    const mapped = loop();
    const gated = gateFindGraphDecideInput({
      need,
      bestDeal: mapped.bestDeal,
      agentVerdict: mapped.agentVerdict,
      shortlistKeys: mapped.shortlistKeys,
      marketPool: mapped.offerPool,
      brief,
      eligibility: findEligibilityContextFrom({ need, brief }),
      servKey: "k",
      remainingRouteMs: 1,
    });
    const keys = [...gated.bestDeal.ranked, ...(gated.bestDeal.allRanked ?? [])].map((r) => r.key);
    for (const vin of NOT_SEDANS) expect(keys).not.toContain(vin);
    expect(keys).toContain(GRAPH_SENTRA);
    expect(gated.agentVerdict.pick?.key).toBe(LOOP_SENTRA);
  });

  it("publishes the graph's Sentra, inspect first, with no code override and no pickup anywhere", async () => {
    const out = await run(loop(), graphFetch());
    expect(out.decidedBy).toBe("graph");
    expect(out.bestDeal.pick?.key).toBe(GRAPH_SENTRA);
    expect(out.agentVerdict.pick?.key).toBe(GRAPH_SENTRA);
    expect(out.agentVerdict.verdict).toBe("needs_inspection");
    const shown = [...out.bestDeal.ranked, ...(out.bestDeal.allRanked ?? [])].map((r) => r.key);
    for (const vin of NOT_SEDANS) expect(shown).not.toContain(vin);
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/Code overrode/);
    expect(text).not.toContain("Silverado");
    const step = out.agentVerdict.serv_steps.at(-1)!;
    // The reason names the published car, not just "This Sentra" among several Sentras.
    expect(step.why).toContain("2025 Nissan Sentra");
    expect(step.why).toMatch(/20,791/);
    const lines = formatJournalProvenanceLines(step.notes, step.why);
    const texts = lines.map((l) => l.text.toLowerCase());
    expect(new Set(texts).size).toBe(texts.length);
  });

  it("rejects an ineligible graph pick and falls back to the loop's eligible car, labelled", async () => {
    // Even if a future graph answer named the pickup, code rejects it instead of publishing it.
    const out = await run(loop(), graphFetch(SILVERADO));
    expect(out.bestDeal.pick?.key).not.toBe(SILVERADO);
    expect(out.agentVerdict.pick?.key).not.toBe(SILVERADO);
    expect([LOOP_SENTRA, undefined]).toContain(out.agentVerdict.pick?.key);
    expect(out.decidedBy).toBe("fallback");
  });

  it("publish chokepoint withholds an ineligible pick instead of swapping in another car", () => {
    const mapped = loop();
    const ctx = findEligibilityContextFrom({ need, brief });
    const silverado = mapped.bestDeal.allRanked.find((r) => r.key === SILVERADO)!;
    const published = gateFindPublishedResult({
      bestDeal: { ...mapped.bestDeal, pick: silverado },
      agentVerdict: { ...mapped.agentVerdict, pick: { ...mapped.agentVerdict.pick!, key: SILVERADO } },
      ctx,
      pool: mapped.offerPool,
    });
    expect(published.bestDeal.pick).toBeNull();
    expect(published.agentVerdict.pick).toBeNull();
    expect(published.agentVerdict.verdict).toBe("withheld");
    expect(published.agentVerdict.unknowns.join(" ")).toMatch(/No car was published: the chosen car breaks the body style/);
    const gate = enforceFindHardEligibility(mapped.bestDeal, ctx, mapped.offerPool);
    expect(gate.droppedKeys).toEqual(expect.arrayContaining(NOT_SEDANS));
  });

  it("names the price risk of a near-new car with an implausibly low ask when there are no comps", () => {
    const risk = priceRiskFor({ priceUsd: 9_672, fairValueUsd: null, compCount: 0, year: 2026, miles: 1_705, nowYear: 2026 });
    expect(risk?.kind).toBe("too_good_for_year");
    expect(risk?.text).toMatch(/\$9,672 is unusually low for a 2026 car with 1,705 miles/);
    expect(priceRiskFor({ priceUsd: 13_995, fairValueUsd: null, year: 2025, nowYear: 2026 })).toBeNull();
    expect(priceRiskFor({ priceUsd: 9_672, fairValueUsd: null, year: 2018, nowYear: 2026 })).toBeNull();
  });
});

describe("one shared eligibility chokepoint on every publish path", () => {
  const root = path.resolve(__dirname, "../../..");
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");

  it.each(["src/server/find-chat.ts", "src/server/find-decide-orchestrator.ts"])(
    "%s gates the graph result with gateFindPublishedResult before publishing",
    (file) => {
      const src = read(file);
      const graphAt = src.indexOf("runFindGraphDecide(");
      const gateAt = src.indexOf("gateFindPublishedResult(", graphAt);
      expect(graphAt).toBeGreaterThan(-1);
      expect(gateAt).toBeGreaterThan(graphAt);
    },
  );

  it("runFindGraphDecide gates its input and output with the shared function", () => {
    const src = read("src/server/find-graph-decide.ts");
    expect(src).toMatch(/const input = gateFindGraphDecideInput\(rawInput\)/);
    expect(src).toMatch(/rejectIneligibleGraphPick\(executedRaw, input\)/);
  });

  it("no code path swaps the graph's car", () => {
    for (const file of [
      "src/server/find-graph-decide.ts",
      "src/server/find-decide-serv.ts",
      "src/domain/find-best-deal.ts",
    ]) {
      expect(read(file), file).not.toMatch(/cleanLowerMileAlternative|Code overrode the graph pick/);
    }
  });
});
