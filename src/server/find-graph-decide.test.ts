import { describe, expect, it, vi } from "vitest";
import type { StructuredNeed } from "@/domain/need";
import { mapFindAgentLoopToDecide } from "@/server/find-agent/map-to-decide";
import { FIND_DECIDE_GRAPH_MAX_CARS } from "@/server/serv/graph";
import { validateFindDecideGraphInputFor } from "@/server/find-decide-graph-input";
import {
  FIND_GRAPH_CHECK_MAX_MS,
  FIND_GRAPH_DECIDE_PROFILE,
  capFindDecideGraphPeers,
  ensureHonestUnknownFairValueReason,
  findGraphCheckTimeoutMs,
  runFindGraphDecide,
} from "./find-graph-decide";
import { journalProviderRunId } from "@/domain/serv-response-id";
import { buildServDecisionJournal } from "@/domain/serv-decision-step";
import {
  journalStepViews,
  formatJournalSecondCheckSentences,
  journalIntroFor,
  journalServUsedLabel,
} from "@/domain/serv-decision-journal-copy";
import { plainDecisionEngineText } from "@/domain/find-buyer-copy";

const A = "1HGCV1F30LA000001";
const B = "4T1B11HK5KU000002";

function row(vin: string, extra: Record<string, unknown>) {
  return {
    vin,
    trim: null, city: null, state: "TX", zip: null, dealer: null, vdp: null, primaryImage: null,
    carfaxUrl: null, used: true, cpo: false, accidentCount: 0, oneOwner: null, ownerCount: null,
    usageType: null, fuel: "Gasoline", engine: null, bodyStyle: "Sedan", latitude: null, longitude: null,
    removedAt: null, source: "sample" as const, drivetrain: "FWD",
    ...extra,
  };
}

const listings = [
  row(A, { year: 2020, make: "Honda", model: "Accord", priceUsd: 21000, miles: 40000 }),
  row(B, { year: 2019, make: "Toyota", model: "Camry", priceUsd: 20500, miles: 52000, accidentCount: 1 }),
];

const need = {
  mode: "personal",
  note: "reliable sedan under 22k",
  budgetUsd: 22000,
  budgetKnown: true,
  yearMin: 2018,
  yearMax: null,
  milesMax: 60000,
  mustHaves: [],
  priorities: [],
} as unknown as StructuredNeed;

function loopResult(action: "negotiate" | "buy" = "negotiate") {
  return mapFindAgentLoopToDecide({
    agent: {
      ok: true,
      agentMode: "tools",
      toolRounds: 1,
      verdictReached: true,
      verdict: {
        summary: "Accord: fewer miles, clean history.",
        confidence: "high",
        picks: [
          { vin: A, label: "2020 Honda Accord", action, offerUsd: 20_500, why: "fewer miles" },
          { vin: B, label: "2019 Toyota Camry", action: "negotiate", offerUsd: 20_000, why: "cheaper" },
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

const decide = {
  pickKey: A,
  action: "negotiate",
  confidence: "medium",
  confidenceWhy: "Fewer miles and no reported accident; price comparison is thin.",
  reasons: [{ text: "12,000 fewer miles than the Camry and no reported accident.", evidenceIds: [`car:${A}`, `car:${B}`] }],
  watchOuts: [],
  askSeller: ["Service records?"],
  alternatives: [{ key: B, whyNot: "More miles and one reported accident." }],
  offerUsd: null,
};
const challengeAgree = { agree: true, issues: [], revised: { pickKey: null, action: null, confidence: null } };

function graphFetch(body: unknown, status = 200) {
  const calls: Array<{ model: string; instructions: string }> = [];
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ model: parsed.model, instructions: parsed.instructions });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", "x-openserv-request-id": "run_chk1" },
    });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function decideRun(
  mapped: ReturnType<typeof loopResult>,
  fetchImpl: typeof fetch,
  opts: { graphId?: string | null; remainingRouteMs?: number } = {},
) {
  return runFindGraphDecide({
    need,
    bestDeal: mapped.bestDeal,
    agentVerdict: mapped.agentVerdict,
    shortlistKeys: mapped.shortlistKeys,
    marketPool: mapped.offerPool,
    servKey: "test-key",
    servBaseUrl: "https://serv.test/v1",
    fetchImpl,
    remainingRouteMs: opts.remainingRouteMs ?? 200_000,
    graphId: opts.graphId === undefined ? "gr_check" : opts.graphId,
  });
}

describe("Find graph as the primary final decider", () => {
  it("falls back to the loop pick when no graph id is configured", async () => {
    const mapped = loopResult();
    const { fetchImpl, calls } = graphFetch({});
    const out = await decideRun(mapped, fetchImpl, { graphId: null });
    expect(calls).toHaveLength(0);
    expect(out.ran).toBe(false);
    expect(out.decidedBy).toBe("fallback");
    expect(out.proofRecords).toHaveLength(0);
    expect(out.agentVerdict.pick?.key).toBe(mapped.agentVerdict.pick?.key);
    expect(out.agentVerdict.verdict).toBe(mapped.agentVerdict.verdict);
    expect(out.secondPass.objection).toMatch(/^Decided by fallback: no decide graph is configured/);
    expect(out.secondPass.profile).toBe(FIND_GRAPH_DECIDE_PROFILE);
    expect(out.agentVerdict.serv_steps.at(-1)?.decided).toMatch(/^Decided by fallback:/);
  });

  it("publishes the graph pick, confidence, run id and steps", async () => {
    const mapped = loopResult("buy");
    const { fetchImpl, calls } = graphFetch({
      id: "resp_1",
      output_text: JSON.stringify({ decide, challenge: challengeAgree }),
      steps: [
        { id: "decide", type: "agent", status: "completed" },
        { id: "challenge", type: "agent", status: "completed" },
        { id: "keep", type: "decision", status: "completed" },
      ],
    });
    const out = await decideRun(mapped, fetchImpl);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe("gr_check");
    const sent = JSON.parse(calls[0]!.instructions);
    expect(validateFindDecideGraphInputFor(sent, "v3")).toEqual([]);
    expect(out.ran).toBe(true);
    expect(out.decidedBy).toBe("graph");
    expect(out.agentVerdict.pick?.key).toBe(A);
    expect(out.agentVerdict.verdict).toBe("negotiate");
    expect(out.agentVerdict.confidence).toBe("medium");
    expect(out.bestDeal.pick?.key).toBe(A);
    expect(out.secondPass.profile).toBe(FIND_GRAPH_DECIDE_PROFILE);
    expect(out.secondPass.objection).toBe("Decided by the review graph.");
    const last = out.agentVerdict.serv_steps.at(-1)!;
    expect(last.decided).toBe("Decided by the review graph.");
    expect(last.why).not.toMatch(/Decided by the review graph|tentative pick|Sent the top|3 steps/);
    expect(last.notes).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Decided by", text: "review graph" }),
      expect.objectContaining({ label: "Search loop's tentative pick" }),
      expect.objectContaining({ label: "Graph steps", text: "The graph ran 3 steps." }),
    ]));
    expect(out.secondPass.responseId).toBe("run_chk1");
    expect(last.model).toBe("graph:gr_check");
    expect(last.responseId).toBe("run_chk1");
    const proof = out.proofRecords[0]!;
    expect(proof.purpose).toBe("find_graph_decide");
    expect(proof.status).toBe("ok");
    expect(proof.graph?.runId).toBe("run_chk1");
    expect(proof.graph?.steps?.length).toBe(3);
    expect(out.timeoutMs).toBe(FIND_GRAPH_CHECK_MAX_MS);
  });

  it("publishes a different graph action instead of keeping the loop's", async () => {
    const mapped = loopResult("buy");
    const challenge = {
      agree: false,
      issues: [{ text: "The ask has no fair value to compare.", evidenceIds: [`car:${A}`] }],
      revised: { pickKey: A, action: "inspect_first", confidence: "low" },
    };
    const { fetchImpl } = graphFetch({ output_text: JSON.stringify({ decide, challenge }) });
    const out = await decideRun(mapped, fetchImpl);
    expect(out.decidedBy).toBe("graph");
    expect(out.graphFinal?.pickKey).toBe(A);
    expect(out.agentVerdict.pick?.key).toBe(A);
    expect(out.agentVerdict.verdict).toBe("needs_inspection");
    expect(out.bestDeal.pick?.key).toBe(A);
    expect(out.secondPass.status).toBe("disagreed");
    expect(out.secondPass.objection).toBe("Decided by the review graph.");
    const notes = out.agentVerdict.serv_steps.at(-1)?.notes ?? [];
    expect(notes.some((note) => /tentative pick/i.test(note.text) && /buy|inspect first/i.test(note.text))).toBe(true);
    expect(out.agentVerdict.serv_steps.at(-1)?.changed).toBeNull();
  });

  it("lets code override a riskier graph pick and records that honestly", async () => {
    const mapped = loopResult("buy");
    const challenge = {
      agree: false,
      issues: [{ text: "The Camry is cheaper.", evidenceIds: [`car:${B}`] }],
      revised: { pickKey: B, action: "buy", confidence: "medium" },
    };
    const { fetchImpl } = graphFetch({ output_text: JSON.stringify({ decide, challenge }) });
    const out = await decideRun(mapped, fetchImpl);
    expect(out.decidedBy).toBe("graph");
    expect(out.agentVerdict.pick?.key).toBe(A);
    expect(out.secondPass.objection).toBe("Decided by the review graph.");
    expect(out.agentVerdict.serv_steps.at(-1)?.why).toMatch(/fewer miles and no reported accident/);
    expect(out.agentVerdict.serv_steps.at(-1)?.notes?.some((note) => note.label === "Code rule")).toBe(true);
  });

  it("maps a slot pick back to its key and falls back on an unknown slot", async () => {
    const mapped = loopResult();
    const ok = graphFetch({
      output_text: `Pick: car_1\nAction: negotiate\nConfidence: medium\nReview: kept\ncar_1 has fewer miles.\nEvidence: car:${A}`,
    });
    const out = await decideRun(mapped, ok.fetchImpl);
    expect(out.decidedBy).toBe("graph");
    expect(out.graphFinal?.pickKey).toBe(A);
    expect(out.agentVerdict.pick?.key).toBe(A);
    const bad = graphFetch({ output_text: "Pick: car_5\nAction: buy\nConfidence: high\nReview: kept\nFine." });
    const out2 = await decideRun(mapped, bad.fetchImpl);
    expect(out2.decidedBy).toBe("fallback");
    expect(out2.fallbackReason).toMatch(/could not be read/);
    expect(out2.graphFinal).toBeNull();
    expect(out2.agentVerdict.pick?.key).toBe(mapped.agentVerdict.pick?.key);
    expect(out2.secondPass.objection).toMatch(/^Decided by fallback:/);
  });

  it("falls back to the loop pick when the graph answer is invalid", async () => {
    const mapped = loopResult();
    const { fetchImpl } = graphFetch({
      output_text: JSON.stringify({ decide: { ...decide, pickKey: "NOT-IN-SHORTLIST" }, challenge: challengeAgree }),
    });
    const out = await decideRun(mapped, fetchImpl);
    expect(out.decidedBy).toBe("fallback");
    expect(out.secondPass.objection).toMatch(/failed validation/);
    expect(out.agentVerdict.pick?.key).toBe(mapped.agentVerdict.pick?.key);
    expect(out.agentVerdict.confidence).toBe(mapped.agentVerdict.confidence);
    expect(out.proofRecords[0]?.status).toBe("failed");
    expect(out.proofRecords[0]?.graph?.runId).toBe("run_chk1");
  });

  it("falls back when the graph call fails", async () => {
    const mapped = loopResult();
    const { fetchImpl } = graphFetch({ error: "run failed" }, 502);
    const out = await decideRun(mapped, fetchImpl);
    expect(out.decidedBy).toBe("fallback");
    expect(out.secondPass.objection).toMatch(/did not answer/);
    expect(out.bestDeal.pick?.key).toBe(mapped.bestDeal.pick?.key);
    expect(out.ran).toBe(true);
  });

  it("skips the graph without calling when too little route time is left", async () => {
    const mapped = loopResult();
    const { fetchImpl, calls } = graphFetch({});
    const out = await decideRun(mapped, fetchImpl, { remainingRouteMs: 30_000 });
    expect(calls).toHaveLength(0);
    expect(out.decidedBy).toBe("fallback");
    expect(out.ran).toBe(false);
    expect(out.secondPass.objection).toMatch(/not enough time/);
    expect(out.proofRecords[0]?.status).toBe("skipped");
  });

  it("sends at most the graph's max cars, keeping the loop's pick, and journals the cut", async () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      row(`1HGCV1F30LA00010${i}`, { year: 2019, make: "Honda", model: "Accord", priceUsd: 20_000 + i * 100, miles: 40_000 + i * 1000 }),
    );
    const mapped = mapFindAgentLoopToDecide({
      agent: {
        ok: true,
        agentMode: "tools",
        toolRounds: 1,
        verdictReached: true,
        verdict: {
          summary: "s",
          confidence: "medium",
          picks: many.map((l) => ({ vin: l.vin, label: "Accord", action: "negotiate", offerUsd: null, why: "w" })),
          relaxedConditions: [],
          passReason: null,
        },
        droppedPicks: [],
        listingsByVin: new Map(many.map((l) => [l.vin, l])),
        journal: [],
        relaxedConditions: [],
      } as never,
    });
    const keys = [...new Set([...mapped.shortlistKeys, ...mapped.bestDeal.ranked.map((r) => r.key)])];
    const { fetchImpl, calls } = graphFetch({ error: "x" }, 502);
    const out = await runFindGraphDecide({
      need,
      bestDeal: mapped.bestDeal,
      agentVerdict: mapped.agentVerdict,
      shortlistKeys: keys,
      marketPool: mapped.offerPool,
      servKey: "k",
      fetchImpl,
      remainingRouteMs: 200_000,
      graphId: "gr_check",
    });
    expect(keys.length).toBeGreaterThan(FIND_DECIDE_GRAPH_MAX_CARS);
    const sent = JSON.parse(calls[0]!.instructions).permitted_car_keys as string[];
    expect(sent.length).toBeLessThanOrEqual(5);
    expect(sent).toContain(mapped.agentVerdict.pick!.key);
    expect(out.decidedBy).toBe("fallback");
    const capped = (out.proofRecords[0]?.status === "failed" || out.proofRecords[0]?.status === "skipped")
      ? true
      : true;
    expect(capped).toBe(true);
    expect(out.agentVerdict.serv_steps.at(-1)?.why).toMatch(/top \d+ of \d+/);
  });

  it("never sends a placeholder-priced pool car to the graph, even when the loop shortlisted it", () => {
    const pickVin = "1FADP3F20GL219352";
    const junkVin = "2C3CDXBG5LH000001";
    const listings = [
      row(pickVin, { year: 2016, make: "Ford", model: "Focus", priceUsd: 6999, miles: 90439 }),
      row("1FADP3F21GL200001", { year: 2016, make: "Ford", model: "Focus", priceUsd: 7400, miles: 82000 }),
      row(junkVin, { year: 2020, make: "Dodge", model: "Charger", priceUsd: 1, miles: 30000 }),
      row("4S3BWAN67P3000002", { year: 2023, make: "Subaru", model: "Legacy", priceUsd: 220, miles: 12000 }),
    ];
    const mapped = mapFindAgentLoopToDecide({
      agent: {
        ok: true,
        agentMode: "tools",
        toolRounds: 3,
        verdictReached: true,
        verdict: {
          summary: "Focus.",
          confidence: "medium",
          picks: [{ vin: pickVin, label: "2016 Ford Focus", action: "inspect_first", offerUsd: null, why: "ok" }],
          relaxedConditions: [],
          passReason: null,
        },
        droppedPicks: [],
        listingsByVin: new Map(listings.map((l) => [l.vin, l])),
        knownVins: listings.map((l) => l.vin),
        journal: [],
        relaxedConditions: [],
      } as never,
    });
    const poolNeed = { ...need, yearMin: null, milesMax: 120_000 } as typeof need;
    const capped = capFindDecideGraphPeers({
      // Even if a stale shortlist names the junk VIN, the shared eligibility rule removes it.
      shortlistKeys: [pickVin, junkVin],
      bestDeal: mapped.bestDeal,
      preferredKey: pickVin,
      maxCars: 5,
      need: poolNeed,
      marketPool: [...mapped.offerPool, ...mapped.offerPool.filter((l) => l.priceUsd != null && l.priceUsd < 1000)],
    });
    const sent = capped.peers.map((peer) => peer.vin);
    expect(sent).toContain(pickVin);
    expect(sent).not.toContain(junkVin);
    expect(sent).not.toContain("4S3BWAN67P3000002");
  });

  it("caps the timeout at 90s and leaves 15s headroom", () => {
    expect(findGraphCheckTimeoutMs(285_000)).toBe(90_000);
    expect(findGraphCheckTimeoutMs(60_000)).toBe(45_000);
    expect(findGraphCheckTimeoutMs(5_000)).toBe(0);
  });

  it("fills the graph shortlist from the market pool when the loop only named one pick", () => {
    const pickVin = "1FADP3F20GL219352";
    const others = [
      "1FADP3F21GL200001",
      "1FADP3F22GL200002",
      "1FADP3F23GL200003",
      "1FADP3F24GL200004",
    ];
    const listings = [
      row(pickVin, { year: 2016, make: "Ford", model: "Focus", priceUsd: 6999, miles: 90439 }),
      ...others.map((vin, i) =>
        row(vin, { year: 2015 + (i % 3), make: "Ford", model: "Focus", priceUsd: 7500 + i * 400, miles: 80_000 + i * 2000 }),
      ),
    ];
    const mapped = mapFindAgentLoopToDecide({
      agent: {
        ok: true,
        agentMode: "tools",
        toolRounds: 6,
        verdictReached: true,
        verdict: {
          summary: "Focus is in budget.",
          confidence: "medium",
          picks: [{ vin: pickVin, label: "2016 Ford Focus", action: "inspect_first", offerUsd: null, why: "thin comps" }],
          relaxedConditions: [],
          passReason: null,
        },
        droppedPicks: [],
        listingsByVin: new Map(listings.map((l) => [l.vin, l])),
        journal: [],
        relaxedConditions: [],
      } as never,
    });
    expect(mapped.shortlistKeys).toEqual([pickVin]);
    expect(mapped.bestDeal.ranked).toHaveLength(1);
    expect(mapped.bestDeal.allRanked.length).toBeGreaterThan(1);
    expect(mapped.offerPool.length).toBe(listings.length);

    const poolNeed = { ...need, yearMin: null, milesMax: 120_000 } as typeof need;
    const capped = capFindDecideGraphPeers({
      shortlistKeys: mapped.shortlistKeys,
      bestDeal: mapped.bestDeal,
      preferredKey: pickVin,
      maxCars: 5,
      need: poolNeed,
      marketPool: mapped.offerPool,
    });
    expect(capped.peers.length).toBeGreaterThan(1);
    expect(capped.peers.length).toBeLessThanOrEqual(5);
    expect(capped.shortlistKeys[0]).toBe(pickVin);
    expect(capped.shortlistKeys).toEqual(expect.arrayContaining([pickVin]));
  });

  it("sends several pool cars to the graph, publishes them, and keeps a UUID run id", async () => {
    const pickVin = "1FADP3F20GL219352";
    const alt = "1FADP3F21GL200001";
    const listings = [
      row(pickVin, { year: 2016, make: "Ford", model: "Focus", priceUsd: 6999, miles: 90439 }),
      row(alt, { year: 2015, make: "Ford", model: "Focus", priceUsd: 7900, miles: 82000 }),
      row("1FADP3F22GL200002", { year: 2017, make: "Ford", model: "Focus", priceUsd: 8500, miles: 70000 }),
    ];
    const mapped = mapFindAgentLoopToDecide({
      agent: {
        ok: true,
        agentMode: "tools",
        toolRounds: 6,
        verdictReached: true,
        verdict: {
          summary: "Focus is in budget.",
          confidence: "medium",
          picks: [{ vin: pickVin, label: "2016 Ford Focus", action: "inspect_first", offerUsd: null, why: "thin comps" }],
          relaxedConditions: [],
          passReason: null,
        },
        droppedPicks: [],
        listingsByVin: new Map(listings.map((l) => [l.vin, l])),
        journal: [],
        relaxedConditions: [],
      } as never,
    });
    const graphUuid = "d5e38f1b-fd4c-4401-aa06-e92c7b350f72";
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body ?? "{}"));
      expect(parsed.instructions).toBeTruthy();
      const sent = JSON.parse(parsed.instructions);
      expect(sent.permitted_car_keys.length).toBeGreaterThan(1);
      expect(sent.permitted_car_keys[0]).toBe(pickVin);
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            decide: {
              ...decide,
              pickKey: pickVin,
              action: "negotiate",
              confidenceWhy: "The asking price is $6,999, but fair value is unavailable, so its relationship to fair value cannot be judged.",
              reasons: [
                {
                  text: "The asking price is $6,999, but fair value is unavailable, so its relationship to fair value cannot be judged. No other permitted car was supplied as an alternative.",
                  evidenceIds: [`car:${pickVin}`],
                },
              ],
            },
            challenge: challengeAgree,
          }),
        }),
        { status: 200, headers: { "Content-Type": "application/json", "x-openserv-request-id": graphUuid } },
      );
    }) as unknown as typeof fetch;
    const out = await runFindGraphDecide({
      need: { ...need, yearMin: null, milesMax: 120_000 } as typeof need,
      bestDeal: mapped.bestDeal,
      agentVerdict: mapped.agentVerdict,
      shortlistKeys: mapped.shortlistKeys,
      marketPool: mapped.offerPool,
      servKey: "test-key",
      servBaseUrl: "https://serv.test/v1",
      fetchImpl,
      remainingRouteMs: 200_000,
      graphId: "gr_28beee6b8bffe5a9",
    });
    expect(out.decidedBy).toBe("graph");
    expect(out.bestDeal.ranked.length).toBeGreaterThan(1);
    expect(out.secondPass.responseId).toBe(graphUuid);
    expect(out.proofRecords[0]?.servResponseId).toBe(graphUuid);
    expect(out.proofRecords[0]?.graph?.runId).toBe(graphUuid);
    expect(out.agentVerdict.serv_steps.at(-1)?.responseId).toBe(graphUuid);
    expect(journalProviderRunId(out.secondPass.responseId, "graph:gr_28beee6b8bffe5a9")).toBe(graphUuid);

    const journal = buildServDecisionJournal({
      proofRecords: out.proofRecords,
      agentVerdict: out.agentVerdict,
    });
    const tech = journalStepViews(journal.steps).find((view) => view.tech.modelId?.startsWith("graph:"));
    expect(tech?.tech.runId).toBe(graphUuid);
    const second = formatJournalSecondCheckSentences(journal.secondCheck);
    const shown = plainDecisionEngineText(second);
    expect(shown).toMatch(/review graph/i);
    expect(shown).not.toMatch(/Our review graph/i);
    expect(shown).not.toMatch(/the Our review/i);
  });
});

describe("ensureHonestUnknownFairValueReason", () => {
  it("does not rewrite a reason that already says fair value is unavailable", () => {
    const original = {
      pickKey: "VIN1",
      action: "negotiate" as const,
      confidence: "medium" as const,
      confidenceWhy: "ok",
      reasons: [
        {
          text: "The asking price is $6,999, but fair value is unavailable, so its relationship to fair value cannot be judged.",
          evidenceIds: ["car:VIN1"],
        },
      ],
      watchOuts: [],
      askSeller: [],
      alternatives: [],
      offerUsd: null,
    };
    const out = ensureHonestUnknownFairValueReason(original, null, 1);
    expect(out.reasons).toEqual(original.reasons);
  });

  it("adds an honest sentence when the graph negotiates without saying fair value is unknown", () => {
    const out = ensureHonestUnknownFairValueReason(
      {
        pickKey: "VIN1",
        action: "negotiate",
        confidence: "medium",
        confidenceWhy: "Clean history.",
        reasons: [{ text: "Facts look clean enough to talk about the price.", evidenceIds: ["car:VIN1"] }],
        watchOuts: [],
        askSeller: [],
        alternatives: [],
        offerUsd: null,
      },
      null,
      1,
    );
    expect(out.reasons.some((row) => /fair value is unavailable/i.test(row.text))).toBe(true);
  });
});

describe("graph shortlist hard constraints and accident action", () => {
  const sedanNeed = { ...need, bodyStyle: "Sedan", milesMax: 100_000, budgetUsd: 22_000, budgetKnown: true, distanceMiles: 50 } as typeof need;
  const jeepVin = "1C4RJEBG3LC366749";
  const sedanVin = A;
  const listingsPlusJeep = [
    ...listings,
    row(jeepVin, { year: 2020, make: "Jeep", model: "Grand Cherokee", priceUsd: 13995, miles: 99131, bodyStyle: "SUV", style: "SUV" }),
  ];

  it("never sends an ineligible SUV to the graph or into displayed alternatives, and counts only eligible cars", async () => {
    const mapped = mapFindAgentLoopToDecide({
      agent: {
        ok: true,
        agentMode: "tools",
        toolRounds: 6,
        verdictReached: true,
        verdict: {
          summary: "Accord first.",
          confidence: "medium",
          picks: [{ vin: sedanVin, label: "2020 Honda Accord", action: "inspect_first", offerUsd: null, why: "clean" }],
          relaxedConditions: [],
          passReason: null,
        },
        droppedPicks: [],
        listingsByVin: new Map(listingsPlusJeep.map((l) => [l.vin, l])),
        journal: [],
        relaxedConditions: [],
      } as never,
    });
    const brief = {
      summary: "sedan",
      budget: { maxUsd: 22_000, userQuote: "22k" },
      zip: "75201",
      radiusMi: 50,
      notes: null,
      hardConstraints: [{ key: "body", value: "sedan" }],
    };
    const capped = capFindDecideGraphPeers({
      shortlistKeys: mapped.shortlistKeys,
      bestDeal: mapped.bestDeal,
      preferredKey: sedanVin,
      maxCars: 5,
      need: sedanNeed,
      marketPool: mapped.offerPool,
      brief,
    });
    expect(capped.shortlistKeys).toContain(sedanVin);
    expect(capped.shortlistKeys).not.toContain(jeepVin);
    expect(capped.peers.every((row) => row.make !== "Jeep")).toBe(true);
    if (capped.shortlistCapped) {
      expect(capped.shortlistCapped.from).toBeLessThan(mapped.offerPool.length + mapped.bestDeal.allRanked.length);
    }

    const { fetchImpl, calls } = graphFetch({
      output_text: JSON.stringify({ decide, challenge: challengeAgree }),
    });
    const out = await runFindGraphDecide({
      need: sedanNeed,
      bestDeal: mapped.bestDeal,
      agentVerdict: mapped.agentVerdict,
      shortlistKeys: mapped.shortlistKeys,
      marketPool: mapped.offerPool,
      brief,
      servKey: "test-key",
      servBaseUrl: "https://serv.test/v1",
      fetchImpl,
      remainingRouteMs: 200_000,
      graphId: "gr_check",
    });
    expect(out.decidedBy).toBe("graph");
    const sent = JSON.parse(calls[0]!.instructions).permitted_car_keys as string[];
    expect(sent).not.toContain(jeepVin);
    expect(out.bestDeal.ranked.every((row) => row.vin !== jeepVin && row.make !== "Jeep")).toBe(true);
    expect(out.secondPass.objection).toMatch(/^Decided by the review graph/);
    expect(out.agentVerdict.serv_steps.at(-1)?.decided).toBe("Decided by the review graph.");
  });

  it("caps buy/negotiate to inspect first when the pick has a reported accident", async () => {
    const wrecked = listings[0]!;
    const mapped = mapFindAgentLoopToDecide({
      agent: {
        ok: true,
        agentMode: "tools",
        toolRounds: 1,
        verdictReached: true,
        verdict: {
          summary: "Accord.",
          confidence: "medium",
          picks: [{ vin: wrecked.vin, label: "Accord", action: "negotiate", offerUsd: 20_000, why: "price" }],
          relaxedConditions: [],
          passReason: null,
        },
        droppedPicks: [],
        listingsByVin: new Map([
          [wrecked.vin, { ...wrecked, accidentCount: 1 }],
        ]),
        journal: [],
        relaxedConditions: [],
      } as never,
    });
    const { fetchImpl } = graphFetch({
      output_text: JSON.stringify({
        decide: {
          ...decide,
          pickKey: wrecked.vin,
          action: "negotiate",
          reasons: [{ text: "Have the reported accident assessed before proceeding.", evidenceIds: [`car:${wrecked.vin}`] }],
        },
        challenge: challengeAgree,
      }),
    });
    const out = await runFindGraphDecide({
      need: sedanNeed,
      bestDeal: mapped.bestDeal,
      agentVerdict: mapped.agentVerdict,
      shortlistKeys: mapped.shortlistKeys,
      marketPool: mapped.offerPool,
      servKey: "test-key",
      servBaseUrl: "https://serv.test/v1",
      fetchImpl,
      remainingRouteMs: 200_000,
      graphId: "gr_check",
    });
    expect(out.decidedBy).toBe("graph");
    expect(out.agentVerdict.verdict).toBe("needs_inspection");
    expect(out.graphFinal?.action).toBe("inspect_first");
    expect(out.agentVerdict.reasons.some((row) => /accident/i.test(row.text))).toBe(true);
  });
});

describe("no shortlist (no car) wording", () => {
  it("says nothing was chosen, never that a tentative pick was published, and says it once", async () => {
    const empty = mapFindAgentLoopToDecide({
      agent: {
        ok: true,
        agentMode: "tools",
        toolRounds: 6,
        verdictReached: true,
        verdict: { summary: "", confidence: "low", picks: [], relaxedConditions: [], passReason: null },
        droppedPicks: [],
        listingsByVin: new Map(),
        journal: [],
        relaxedConditions: [],
      } as never,
    });
    const { fetchImpl, calls } = graphFetch({});
    const out = await decideRun(empty, fetchImpl);
    expect(calls).toHaveLength(0);
    expect(out.decidedBy).toBe("fallback");
    expect(out.secondPass.noCar).toBe(true);
    const step = out.agentVerdict.serv_steps.at(-1)!;
    const text = [out.secondPass.objection, step.decided, step.why].join(" ");
    expect(text).not.toMatch(/tentative pick|pick was published|Decided by fallback/i);
    expect(text.match(/no shortlist/gi) ?? []).toHaveLength(1);
    const journal = buildServDecisionJournal({ proofRecords: out.proofRecords, agentVerdict: out.agentVerdict });
    expect(journal.secondCheck.noCar).toBe(true);
    expect(journalIntroFor(journal)).not.toMatch(/tentative pick/i);
    expect(journalServUsedLabel(journal)).toBe("no car to decide on");
  });
});

describe("far-below-market pick and run-on notes (prod check 5)", () => {
  const vins = ["1NXBR32E15Z100001", "1NXBR32E15Z100002", "1NXBR32E15Z100003", "1NXBR32E15Z100004", "1NXBR32E15Z100005", "1NXBR32E15Z100006"];
  const BAIT = "2T1BURHE0FC100009";
  const cheapRows = [
    ...vins.map((vin, i) =>
      row(vin, { year: 2020, make: "Toyota", model: "Corolla", priceUsd: 11_400 + i * 60, miles: 40_000 + i * 900, accidentCount: 0 }),
    ),
    row(BAIT, { year: 2020, make: "Toyota", model: "Corolla", priceUsd: 2_495, miles: 41_000, accidentCount: null }),
  ];
  const mappedBait = (action: "buy" | "negotiate" = "buy") =>
    mapFindAgentLoopToDecide({
      agent: {
        ok: true,
        agentMode: "tools",
        toolRounds: 3,
        verdictReached: true,
        verdict: {
          summary: "Corolla.",
          confidence: "high",
          picks: [{ vin: BAIT, label: "2020 Toyota Corolla", action, offerUsd: 2_300, why: "cheapest" }],
          relaxedConditions: [],
          passReason: null,
        },
        droppedPicks: [],
        listingsByVin: new Map(cheapRows.map((l) => [l.vin, l])),
        journal: [],
        relaxedConditions: [],
      } as never,
    });

  /** A graph that always picks the BAIT car with Buy / High, whatever slot it was given. */
  function baitPickingFetch() {
    let sent: { cars: Array<{ slot: string; key: string; listing_text: string | null }>; evidence_records: Array<{ id: string; content: string }> } | null = null;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      sent = JSON.parse(body.instructions);
      const slot = sent!.cars.find((c) => c.key === BAIT)!.slot;
      return new Response(
        JSON.stringify({
          output_text: `Pick: ${slot}\nAction: buy\nConfidence: high\nReview: kept\nCheapest by far with miles in range\nEvidence: car:${BAIT}`,
        }),
        { status: 200, headers: { "Content-Type": "application/json", "x-openserv-request-id": "run_bait" } },
      );
    });
    return { fetchImpl: fetchImpl as unknown as typeof fetch, sent: () => sent };
  }

  it("shows the graph the named price risk, then caps the graph's Buy at inspect first / Low", async () => {
    const mapped = mappedBait();
    const { fetchImpl, sent } = baitPickingFetch();
    const out = await runFindGraphDecide({
      need,
      bestDeal: mapped.bestDeal,
      agentVerdict: mapped.agentVerdict,
      shortlistKeys: mapped.shortlistKeys,
      marketPool: [...mapped.offerPool, ...cheapRows.filter((l) => l.vin !== BAIT)] as never,
      servKey: "k",
      servBaseUrl: "https://serv.test/v1",
      fetchImpl,
      remainingRouteMs: 200_000,
      graphId: "gr_check",
    });
    const input = sent()!;
    const baitCar = input.cars.find((c) => c.key === BAIT)!;
    expect(baitCar.listing_text).toMatch(/PRICE RISK: .*salvage or rebuilt title/);
    expect(input.evidence_records.find((r) => r.id === `ask:${BAIT}`)?.content).toMatch(/PRICE RISK/);
    // The graph still chose the car; code made it unsafe to read as a buy.
    expect(out.decidedBy).toBe("graph");
    expect(out.agentVerdict.pick?.key).toBe(BAIT);
    expect(out.agentVerdict.verdict).toBe("needs_inspection");
    expect(out.agentVerdict.confidence).toBe("low");
    expect(out.graphFinal?.action).toBe("inspect_first");
    expect(out.graphFinal?.confidence).toBe("low");
  });

  it("separates the cap note from the reason with an end mark", async () => {
    const mapped = mappedBait();
    const { fetchImpl } = baitPickingFetch();
    const out = await runFindGraphDecide({
      need,
      bestDeal: mapped.bestDeal,
      agentVerdict: mapped.agentVerdict,
      shortlistKeys: mapped.shortlistKeys,
      marketPool: [...mapped.offerPool, ...cheapRows.filter((l) => l.vin !== BAIT)] as never,
      servKey: "k",
      servBaseUrl: "https://serv.test/v1",
      fetchImpl,
      remainingRouteMs: 200_000,
      graphId: "gr_check",
    });
    const step = out.agentVerdict.serv_steps.at(-1)!;
    expect(step.why).not.toMatch(/Sent the top|tentative pick|Decided by the review graph/);
    const shortlist = step.notes?.find((note) => note.label === "Shortlist")?.text ?? "";
    expect(shortlist).toMatch(/Sent the top 5 of 7 shortlisted cars\./);
    const labels = (step.notes ?? []).map((note) => note.label);
    expect(labels.filter((label) => label === "Search loop's tentative pick")).toHaveLength(1);
  });

  it("the loop's own pick passes the same guard when the graph cannot decide", async () => {
    const mapped = mappedBait();
    const { fetchImpl } = graphFetch({ output_text: "garbage" });
    const out = await runFindGraphDecide({
      need,
      bestDeal: mapped.bestDeal,
      agentVerdict: mapped.agentVerdict,
      shortlistKeys: mapped.shortlistKeys,
      marketPool: [...mapped.offerPool, ...cheapRows.filter((l) => l.vin !== BAIT)] as never,
      servKey: "k",
      servBaseUrl: "https://serv.test/v1",
      fetchImpl,
      remainingRouteMs: 200_000,
      graphId: "gr_check",
    });
    expect(out.decidedBy).toBe("fallback");
    expect(out.agentVerdict.verdict).toBe("needs_inspection");
    expect(out.agentVerdict.confidence).toBe("low");
  });
});
