import { describe, expect, it, vi } from "vitest";
import type { StructuredNeed } from "@/domain/need";
import { mapFindAgentLoopToDecide } from "@/server/find-agent/map-to-decide";
import { FIND_DECIDE_GRAPH_MAX_CARS } from "@/server/serv/graph";
import { validateFindDecideGraphInput } from "@/server/find-decide-graph-input";
import {
  FIND_GRAPH_CHECK_MAX_MS,
  findGraphCheckTimeoutMs,
  runFindGraphSecondCheck,
} from "./find-graph-second-check";

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

function check(
  mapped: ReturnType<typeof loopResult>,
  fetchImpl: typeof fetch,
  opts: { graphId?: string | null; remainingRouteMs?: number } = {},
) {
  return runFindGraphSecondCheck({
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

describe("Find loop second check via SERV graph", () => {
  it("is a no-op when no graph id is configured", async () => {
    const mapped = loopResult();
    const { fetchImpl, calls } = graphFetch({});
    const out = await check(mapped, fetchImpl, { graphId: null });
    expect(calls).toHaveLength(0);
    expect(out.ran).toBe(false);
    expect(out.proofRecords).toHaveLength(0);
    expect(out.agentVerdict).toBe(mapped.agentVerdict);
    expect(out.secondPass.status).toBe("not_run");
    expect(out.secondPass.objection).toMatch(/agentic Find loop path/);
  });

  it("agrees, sends the code facts, and records the graph run", async () => {
    const mapped = loopResult();
    const { fetchImpl, calls } = graphFetch({
      id: "resp_1",
      output_text: JSON.stringify({ decide, challenge: challengeAgree }),
      steps: [
        { id: "decide", type: "agent", status: "completed" },
        { id: "challenge", type: "agent", status: "completed" },
        { id: "keep", type: "decision", status: "completed" },
      ],
    });
    const out = await check(mapped, fetchImpl);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe("gr_check");
    const sent = JSON.parse(calls[0]!.instructions);
    expect(sent.permitted_car_keys).toEqual(expect.arrayContaining([A, B]));
    expect(validateFindDecideGraphInput(sent)).toEqual([]);
    expect(out.ran).toBe(true);
    expect(out.secondPass.status).toBe("agreed");
    // published confidence never goes above the graph's
    expect(out.agentVerdict.confidence).toBe("medium");
    expect(out.secondPass.confidenceBefore).toBe("high");
    expect(out.secondPass.confidenceAfter).toBe("medium");
    expect(out.agentVerdict.pick?.key).toBe(mapped.agentVerdict.pick?.key);
    const last = out.agentVerdict.serv_steps.at(-1)!;
    expect(last.model).toBe("graph:gr_check");
    expect(last.responseId).toBe("run_chk1");
    const proof = out.proofRecords[0]!;
    expect(proof.purpose).toBe("find_graph_check");
    expect(proof.status).toBe("ok");
    expect(proof.graph?.runId).toBe("run_chk1");
    expect(proof.graph?.steps?.length).toBe(3);
    expect(out.timeoutMs).toBe(FIND_GRAPH_CHECK_MAX_MS);
  });

  it("reads the v2 compact text reply", async () => {
    const mapped = loopResult();
    const { fetchImpl } = graphFetch({
      output_text: `Pick: ${A}\nAction: negotiate\nConfidence: high\nReview: kept\nFewer miles than the Camry (car:${A}, car:${B}).`,
    });
    const out = await check(mapped, fetchImpl);
    expect(out.secondPass.status).toBe("agreed");
    expect(out.graphFinal).toEqual({ pickKey: A, action: "negotiate", confidence: "high" });
  });

  it("records a disagreement but keeps the loop's pick", async () => {
    const mapped = loopResult("buy");
    const challenge = {
      agree: false,
      issues: [{ text: "The Accord's ask has no fair value to compare.", evidenceIds: [`car:${A}`] }],
      revised: { pickKey: B, action: "inspect_first", confidence: "low" },
    };
    const { fetchImpl } = graphFetch({ output_text: JSON.stringify({ decide, challenge }) });
    const out = await check(mapped, fetchImpl);
    expect(out.secondPass.status).toBe("disagreed");
    expect(out.secondPass.action).toBe("needs_inspection");
    expect(out.secondPass.objection).toMatch(/Camry/);
    expect(out.agentVerdict.pick?.key).toBe(mapped.agentVerdict.pick?.key);
    expect(out.agentVerdict.verdict).toBe(mapped.agentVerdict.verdict);
    expect(out.agentVerdict.confidence).toBe("low");
  });

  it("keeps 'second check not run' when the graph answer is invalid", async () => {
    const mapped = loopResult();
    const { fetchImpl } = graphFetch({
      output_text: JSON.stringify({ decide: { ...decide, pickKey: "NOT-IN-SHORTLIST" }, challenge: challengeAgree }),
    });
    const out = await check(mapped, fetchImpl);
    expect(out.secondPass.status).toBe("not_run");
    expect(out.secondPass.objection).toMatch(/failed validation/);
    expect(out.agentVerdict.confidence).toBe(mapped.agentVerdict.confidence);
    expect(out.proofRecords[0]?.status).toBe("failed");
    expect(out.proofRecords[0]?.graph?.runId).toBe("run_chk1");
  });

  it("keeps 'second check not run' when the graph call fails", async () => {
    const mapped = loopResult();
    const { fetchImpl } = graphFetch({ error: "run failed" }, 502);
    const out = await check(mapped, fetchImpl);
    expect(out.secondPass.status).toBe("not_run");
    expect(out.secondPass.objection).toMatch(/did not answer/);
    expect(out.bestDeal).toBe(mapped.bestDeal);
  });

  it("skips without calling when too little route time is left", async () => {
    const mapped = loopResult();
    const { fetchImpl, calls } = graphFetch({});
    const out = await check(mapped, fetchImpl, { remainingRouteMs: 30_000 });
    expect(calls).toHaveLength(0);
    expect(out.secondPass.status).toBe("not_run");
    expect(out.secondPass.objection).toMatch(/not enough time/);
    expect(out.proofRecords[0]?.status).toBe("skipped");
  });

  it("sends at most FIND_DECIDE_GRAPH_MAX_CARS cars, keeping the loop's pick", async () => {
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
    const out = await runFindGraphSecondCheck({
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
    expect(sent.length).toBeLessThanOrEqual(FIND_DECIDE_GRAPH_MAX_CARS);
    expect(sent).toContain(mapped.agentVerdict.pick!.key);
    if (keys.length > FIND_DECIDE_GRAPH_MAX_CARS) {
      expect(out.proofRecords[0]?.status).toBe("failed");
    }
  });

  it("caps the timeout at 90s and leaves 15s headroom", () => {
    expect(findGraphCheckTimeoutMs(285_000)).toBe(90_000);
    expect(findGraphCheckTimeoutMs(60_000)).toBe(45_000);
    expect(findGraphCheckTimeoutMs(5_000)).toBe(0);
  });
});
