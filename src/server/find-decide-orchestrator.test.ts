/**
 * Offline decide orchestrator — agent loop is the only path (classic triage deleted).
 */
import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import { explicitNeedFromText } from "@/domain/need";
import type { FindFreeGovReceipt } from "@/domain/find-free-gov";
import {
  mintFindSearchContextRecord,
  storeFindSearchContext,
  updateFindSearchContext,
} from "@/server/find-search-context";
import { runFindDecideOrchestrator } from "@/server/find-decide-orchestrator";

const baseNeed = explicitNeedFromText(
  "synthetic-test AWD SUV under 25000 near 94107",
  "personal",
);

function listing(i: number) {
  return {
    make: "Toyota",
    model: "RAV4",
    year: 2020 + (i % 3),
    priceUsd: 22_000 + i * 500,
    miles: 40_000 + i * 1000,
    vin: `SYNTHETICTESTVIN${i}XXXX`.slice(0, 17),
    drivetrain: i % 2 === 0 ? "AWD" : "FWD",
  };
}

describe("runFindDecideOrchestrator (offline)", () => {
  it("fails honestly when SERV key is absent — no classic triage→decide", async () => {
    const kv = new MemoryKv();
    const listings = [listing(1), listing(2), listing(3), listing(4)];
    let record = mintFindSearchContextRecord({
      userId: "synthetic-test-user",
      need: baseNeed,
      listings,
      compsPool: listings,
      servNextCheckEnabled: false,
    });
    record = await updateFindSearchContext(kv, record, { decidePathEnabled: true });

    const result = await runFindDecideOrchestrator(
      { searchContextToken: record.token },
      {
        kv,
        userId: "synthetic-test-user",
        servKey: null,
        runFreeGov: async () => ({
          receipts: [] as FindFreeGovReceipt[],
          evidenceChanged: false,
          checkIds: [],
          note: "synthetic-test empty wave",
        }),
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("agent_loop_required");
  }, 15_000);

  it("rejects contexts minted for next-check only", async () => {
    const kv = new MemoryKv();
    const listings = [listing(1), listing(2), listing(3)];
    const record = mintFindSearchContextRecord({
      userId: "synthetic-test-user",
      need: baseNeed,
      listings,
      servNextCheckEnabled: true,
    });
    await storeFindSearchContext(kv, record);
    const result = await runFindDecideOrchestrator(
      { searchContextToken: record.token },
      {
        kv,
        userId: "synthetic-test-user",
        servKey: null,
        runFreeGov: async () => ({
          receipts: [] as FindFreeGovReceipt[],
          evidenceChanged: false,
          checkIds: [],
          note: "synthetic-test empty wave",
        }),
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("decide_path_disabled");
  });

  it("publishes via injected agent loop and never falls through to code choose", async () => {
    const kv = new MemoryKv();
    const listings = [listing(1), listing(2), listing(3)];
    let record = mintFindSearchContextRecord({
      userId: "synthetic-test-user",
      need: baseNeed,
      listings,
      compsPool: listings,
      servNextCheckEnabled: false,
    });
    record = await updateFindSearchContext(kv, record, { decidePathEnabled: true });
    const pickVin = listings[0]!.vin;

    const result = await runFindDecideOrchestrator(
      { searchContextToken: record.token },
      {
        kv,
        userId: "synthetic-test-user",
        servKey: "test-serv",
        autodevKey: "test-autodev",
        runFreeGov: async () => ({
          receipts: [],
          evidenceChanged: false,
          checkIds: [],
          note: "synthetic-test empty wave",
        }),
        runFindAgentLoopImpl: async () =>
          ({
            ok: true as const,
            agentMode: "tools" as const,
            toolRounds: 1,
            verdictReached: true,
            verdict: {
              summary: "synthetic-test pick",
              confidence: "medium" as const,
              picks: [
                {
                  vin: pickVin,
                  label: "Toyota RAV4",
                  action: "negotiate" as const,
                  offerUsd: 22_000,
                  why: "synthetic-test",
                },
              ],
              relaxedConditions: [],
              passReason: null,
            },
            droppedPicks: [],
            listingsByVin: new Map(
              listings.map((row) => [
                row.vin.toUpperCase(),
                {
                  ...row,
                  trim: null,
                  city: null,
                  state: null,
                  zip: null,
                  dealer: null,
                  vdp: null,
                  primaryImage: null,
                  carfaxUrl: null,
                  used: true,
                  cpo: false,
                  accidentCount: null,
                  oneOwner: null,
                  ownerCount: null,
                  usageType: null,
                  fuel: null,
                  engine: null,
                  bodyStyle: "SUV",
                  latitude: null,
                  longitude: null,
                  removedAt: null,
                  source: "sample" as const,
                },
              ]),
            ),
            journal: [],
            relaxedConditions: [],
          }) as never,
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decideSource).toBe("SERV");
    expect(result.agentLoop?.verdictReached).toBe(true);
    expect(result.bestDeal?.pick?.vin ?? result.pickAgentVerdict?.pick?.key).toBeTruthy();
    const settle = result.pickProofRecords.find((row) => row.purpose === "find_agent_loop");
    expect(settle).toBeTruthy();
    expect(settle?.status).toBe("ok");
    expect(settle?.inputsDigest.length).toBeGreaterThanOrEqual(32);
  });

  async function runWithGraph(graphResponse: () => Response) {
    const kv = new MemoryKv();
    const graphModels: string[] = [];
    const listings = [listing(1), listing(2), listing(3)];
    let record = mintFindSearchContextRecord({
      userId: "synthetic-test-user",
      need: baseNeed,
      listings,
      compsPool: listings,
      servNextCheckEnabled: false,
    });
    record = await updateFindSearchContext(kv, record, { decidePathEnabled: true });
    const pickVin = listings[0]!.vin;

    const result = await runFindDecideOrchestrator(
      { searchContextToken: record.token },
      {
        kv,
        userId: "synthetic-test-user",
        servKey: "test-serv",
        autodevKey: "test-autodev",
        env: { ...process.env, SERV_GRAPH_FIND_DECIDE_ID: "gr_orch" },
        servBaseUrl: "https://serv.test/v1",
        fetchImpl: (async (_url: string, init?: RequestInit) => {
          const sent = JSON.parse(String(init?.body ?? "{}"));
          graphModels.push(String(sent.model));
          return graphResponse();
        }) as unknown as typeof fetch,
        runFreeGov: async () => ({
          receipts: [],
          evidenceChanged: false,
          checkIds: [],
          note: "synthetic-test empty wave",
        }),
        runFindAgentLoopImpl: async () =>
          ({
            ok: true as const,
            agentMode: "tools" as const,
            toolRounds: 1,
            verdictReached: true,
            verdict: {
              summary: "synthetic-test pick",
              confidence: "medium" as const,
              picks: [
                {
                  vin: pickVin,
                  label: "Toyota RAV4",
                  action: "negotiate" as const,
                  offerUsd: 22_000,
                  why: "synthetic-test",
                },
              ],
              relaxedConditions: [],
              passReason: null,
            },
            droppedPicks: [],
            listingsByVin: new Map(
              listings.map((row) => [
                row.vin.toUpperCase(),
                {
                  ...row,
                  trim: null,
                  city: null,
                  state: null,
                  zip: null,
                  dealer: null,
                  vdp: null,
                  primaryImage: null,
                  carfaxUrl: null,
                  used: true,
                  cpo: false,
                  accidentCount: null,
                  oneOwner: null,
                  ownerCount: null,
                  usageType: null,
                  fuel: null,
                  engine: null,
                  bodyStyle: "SUV",
                  latitude: null,
                  longitude: null,
                  removedAt: null,
                  source: "sample" as const,
                },
              ]),
            ),
            journal: [],
            relaxedConditions: [],
          }) as never,
      },
    );

    return { result, pickVin, graphModels };
  }

  it("runs the SERV graph as the primary final decider when configured", async () => {
    const vin = listing(1).vin;
    const { result, graphModels } = await runWithGraph(() => {
      const decide = {
        pickKey: vin,
        action: "negotiate",
        confidence: "medium",
        confidenceWhy: "synthetic-test medium",
        reasons: [{ text: "synthetic-test reason", evidenceIds: [`car:${vin}`] }],
        watchOuts: [],
        askSeller: [],
        alternatives: [],
        offerUsd: null,
      };
      const challenge = { agree: true, issues: [], revised: { pickKey: null, action: null, confidence: null } };
      return new Response(JSON.stringify({ output_text: JSON.stringify({ decide, challenge }) }), {
        status: 200,
        headers: { "Content-Type": "application/json", "x-openserv-request-id": "run_orch" },
      });
    });
    expect(graphModels).toEqual(["gr_orch"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const graphProof = result.pickProofRecords.find((row) => row.purpose === "find_graph_decide");
    expect(graphProof?.graph?.runId).toBe("run_orch");
    expect(graphProof?.status).toBe("ok");
    expect(result.pickSecondPass?.status).toBe("agreed");
    expect(result.pickSecondPass?.objection).toMatch(/^Decided by the review graph/);
    expect(result.pickAgentVerdict?.serv_steps.at(-1)?.model).toBe("graph:gr_orch");
    expect(result.pickAgentVerdict?.verdict).toBe("negotiate");
    expect(result.honesty).toMatch(/SERV graph made the final choice/);
  });

  it("publishes the loop pick with an honest fallback when the graph fails", async () => {
    const { result, pickVin, graphModels } = await runWithGraph(() => new Response("{}", { status: 502 }));
    expect(graphModels).toEqual(["gr_orch"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pickSecondPass?.status).toBe("not_run");
    expect(result.pickSecondPass?.objection).toMatch(/^Decided by fallback:/);
    expect(result.pickAgentVerdict?.pick?.key).toBe(pickVin);
    expect(result.pickProofRecords.some((row) => row.purpose === "find_graph_decide" && row.status === "failed")).toBe(true);
    expect(result.honesty).toMatch(/graph fallback/);
  });
});
