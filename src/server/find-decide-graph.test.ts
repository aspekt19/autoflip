import { describe, expect, it, vi } from "vitest";
import type { StructuredNeed } from "@/domain/need";
import { emptyBestDealFromListings } from "../../test/golden/empty-best-deal";
import type { ShownListing } from "../../test/golden/types";
import { parseFindDecideGraphOutput, runFindDecideServ } from "./find-decide-serv";

const listings = [
  { vin: "1HGCV1F30LA000001", year: 2020, make: "Honda", model: "Accord", priceUsd: 21000, miles: 40000, drivetrain: "FWD", fuel: "Gasoline", accidentCount: 0, dealer: null, vdp: null, state: "TX", distanceMiles: 10 },
  { vin: "4T1B11HK5KU000002", year: 2019, make: "Toyota", model: "Camry", priceUsd: 20500, miles: 52000, drivetrain: "FWD", fuel: "Gasoline", accidentCount: 1, dealer: null, vdp: null, state: "TX", distanceMiles: 15 },
] as unknown as ShownListing[];

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

const A = "1HGCV1F30LA000001";
const B = "4T1B11HK5KU000002";

const decide = {
  pickKey: A,
  action: "inspect_first",
  confidence: "medium",
  confidenceWhy: "Fewer miles and no reported accident; price comparison is thin.",
  reasons: [{ text: "12,000 fewer miles than the Camry and no reported accident.", evidenceIds: [`car:${A}`, `car:${B}`] }],
  watchOuts: [{ text: "No fair value to compare the ask with.", evidenceIds: [`fair:${A}`] }],
  askSeller: ["Service records?"],
  alternatives: [{ key: B, whyNot: "More miles and one reported accident." }],
  offerUsd: null,
};
const challenge = {
  agree: true,
  issues: [],
  revised: { pickKey: null, action: null, confidence: null },
};

function chatResponse(content: unknown, id: string) {
  return new Response(
    JSON.stringify({
      id,
      model: "serv-test-model",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(content) } }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function makeFetch(graph: () => Response) {
  const models: string[] = [];
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const model = String(body.model ?? "");
    models.push(model);
    if (model.startsWith("gr_")) return graph();
    const system = JSON.stringify(body.messages ?? body.instructions ?? "");
    if (/independent challenger/.test(system)) return chatResponse(challenge, "chatcmpl-Challenge1");
    return chatResponse(decide, "chatcmpl-Decide1");
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, models };
}

function run(fetchImpl: typeof fetch, graphId: string | null) {
  const best = emptyBestDealFromListings(need, listings);
  return runFindDecideServ({
    need,
    bestDeal: best,
    shortlistKeys: best.ranked.map((row) => row.key),
    receipts: [],
    marketPool: [],
    servKey: "test-key",
    servBaseUrl: "https://serv.test/v1",
    fetchImpl,
    graphId,
  });
}

describe("Find decide via SERV graph", () => {
  it("uses one graph run for decide + challenge and records the graph run on both proofs", async () => {
    const { fetchImpl, models } = makeFetch(
      () =>
        new Response(JSON.stringify({ id: "resp_g1", output_text: JSON.stringify({ decide, challenge }) }), {
          status: 200,
          headers: { "Content-Type": "application/json", "x-openserv-request-id": "run_g1" },
        }),
    );
    const out = await run(fetchImpl, "gr_finddecide");
    expect(models).toEqual(["gr_finddecide"]);
    expect(out.source).toBe("SERV");
    expect(out.decide.pickKey).toBe(A);
    expect(out.secondPass.status).toBe("agreed");
    const decideProof = out.proofRecords.find((row) => row.purpose === "find_decide");
    const challengeProof = out.proofRecords.find((row) => row.purpose === "find_challenge");
    expect(decideProof?.status).toBe("ok");
    expect(decideProof?.graph).toEqual({ graphId: "gr_finddecide", runId: "run_g1", steps: null });
    expect(decideProof?.servResponseId).toBe("run_g1");
    expect(decideProof?.model).toBe("graph:gr_finddecide");
    expect(challengeProof?.graph?.runId).toBe("run_g1");
  });

  it("falls back to the two-call path when the graph answer fails validation", async () => {
    const { fetchImpl, models } = makeFetch(
      () =>
        new Response(
          JSON.stringify({ output_text: JSON.stringify({ decide: { ...decide, pickKey: "NOT-IN-SHORTLIST" }, challenge }) }),
          { status: 200, headers: { "Content-Type": "application/json", "x-openserv-request-id": "run_bad" } },
        ),
    );
    const out = await run(fetchImpl, "gr_finddecide");
    expect(models[0]).toBe("gr_finddecide");
    expect(models.length).toBeGreaterThanOrEqual(3);
    expect(models.slice(1).every((m) => !m.startsWith("gr_"))).toBe(true);
    const fallback = out.proofRecords.find((row) => row.purpose === "find_decide_graph");
    expect(fallback?.status).toBe("failed");
    expect(fallback?.graph?.runId).toBe("run_bad");
    expect(out.source).toBe("SERV");
    expect(out.proofRecords.find((row) => row.purpose === "find_decide")?.graph).toBeUndefined();
  });

  it("falls back when the graph call errors", async () => {
    const { fetchImpl, models } = makeFetch(() => new Response("{}", { status: 502 }));
    const out = await run(fetchImpl, "gr_finddecide");
    expect(models[0]).toBe("gr_finddecide");
    expect(out.source).toBe("SERV");
    expect(out.proofRecords.some((row) => row.purpose === "find_decide_graph" && row.status === "failed")).toBe(true);
  });

  it("never calls a graph when graphId is null", async () => {
    const { fetchImpl, models } = makeFetch(() => {
      throw new Error("graph must not be called");
    });
    await run(fetchImpl, null);
    expect(models.some((m) => m.startsWith("gr_"))).toBe(false);
  });

  it("parses only the { decide, challenge } shape", () => {
    expect(parseFindDecideGraphOutput(JSON.stringify({ decide, challenge }))).not.toBeNull();
    expect(parseFindDecideGraphOutput(JSON.stringify(decide))).toBeNull();
    expect(parseFindDecideGraphOutput("not json")).toBeNull();
  });
});
