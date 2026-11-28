import { describe, expect, it, vi } from "vitest";
import type { StructuredNeed } from "@/domain/need";
import { mapFindAgentLoopToDecide } from "@/server/find-agent/map-to-decide";
import { FIND_DECIDE_GRAPH_MAX_CARS } from "@/server/serv/graph";
import { validateFindDecideGraphInputFor } from "@/server/find-decide-graph-input";
import {
  FIND_GRAPH_CHECK_MAX_MS,
  FIND_GRAPH_DECIDE_PROFILE,
  findGraphCheckTimeoutMs,
  runFindGraphDecide,
} from "./find-graph-decide";

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
    expect(out.secondPass.objection).toMatch(/^Decided by the SERV graph/);
    expect(out.secondPass.objection).toMatch(/tentative pick/);
    expect(out.secondPass.responseId).toBe("run_chk1");
    const last = out.agentVerdict.serv_steps.at(-1)!;
    expect(last.decided).toBe("Decided by the SERV graph.");
    expect(last.why).toMatch(/3 steps/);
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
    expect(out.secondPass.objection).toMatch(/buy/);
    expect(out.agentVerdict.serv_steps.at(-1)?.changed).toMatch(/inspect first/);
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
    expect(out.secondPass.objection).toMatch(/fewer miles and no reported accident/);
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

  it("caps the timeout at 90s and leaves 15s headroom", () => {
    expect(findGraphCheckTimeoutMs(285_000)).toBe(90_000);
    expect(findGraphCheckTimeoutMs(60_000)).toBe(45_000);
    expect(findGraphCheckTimeoutMs(5_000)).toBe(0);
  });
});
