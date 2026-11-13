import { describe, expect, it, vi } from "vitest";
import type { BestDealCandidate } from "@/domain/find-best-deal";
import { BASE_MODEL } from "@/server/serv";
import { runFindCloseCallMultipathServ } from "./find-close-call-serv";

function car(partial: Partial<BestDealCandidate> & { key: string; score: number }): BestDealCandidate {
  return {
    key: partial.key,
    make: partial.make ?? "Toyota",
    model: partial.model ?? "RAV4",
    year: partial.year ?? 2021,
    priceUsd: partial.priceUsd ?? 15_000,
    miles: partial.miles ?? 40_000,
    vin: partial.vin ?? null,
    score: partial.score,
    factors: partial.factors ?? [
      {
        id: "mmy_recall_campaigns",
        label: "Recalls",
        points: 8,
        detail: "No recall campaigns on file",
        source: "NHTSA",
      },
      {
        id: "estimated_fuel_cost",
        label: "Fuel",
        points: 0,
        detail: "About $1,200/yr fuel",
        source: "FuelEconomy.gov",
      },
    ],
    unknowns: [],
    fuelSummary: null,
    excludedFromPick: false,
    excludedReason: null,
    sellerQuestions: [],
  };
}

describe("runFindCloseCallMultipathServ", () => {
  it("skips when fewer than two close cars", async () => {
    const result = await runFindCloseCallMultipathServ({
      cars: [car({ key: "a", score: 30 }), car({ key: "b", score: 10 })],
      servKey: "synthetic-test-key",
    });
    expect(result.source).toBe("skipped");
    expect(result.multipath).toBeNull();
    expect(result.proofRecords).toEqual([]);
  });

  it("uses SERV find_close_call_multipath for a near tie (synthetic-test-* fixture)", async () => {
    const tied = [
      car({ key: "a", score: 28.5, priceUsd: 14_900 }),
      car({ key: "b", score: 27.8, priceUsd: 15_200 }),
    ];
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "synthetic-test-close-call-multipath",
          object: "chat.completion",
          model: "stub-serv-model-serv-multipath",
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  paths: [
                    {
                      id: "price_first",
                      pickKey: "a",
                      summary: "Lower ask on a.",
                      evidenceIds: ["ask:a"],
                    },
                    {
                      id: "risk_first",
                      pickKey: "a",
                      summary: "Same recall picture; keep a.",
                      evidenceIds: ["recalls:a"],
                    },
                    {
                      id: "total_cost_first",
                      pickKey: "b",
                      summary: "Fuel path leans b.",
                      evidenceIds: ["ask:b"],
                    },
                  ],
                  reconciliation: "Two paths chose a.",
                  finalPickKey: "a",
                }),
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await runFindCloseCallMultipathServ({
      cars: tied,
      servKey: "synthetic-test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      transportPolicy: "experiment_single_attempt",
    });

    expect(result.source).toBe("serv");
    expect(result.finalPickKey).toBe("a");
    expect(result.multipath?.source).toBe("serv");
    expect(result.multipath?.finalPickKey).toBe("a");
    expect(result.proofRecords[0]?.purpose).toBe("find_close_call_multipath");
    expect(result.proofRecords[0]?.status).toBe("ok");
    expect(fetchImpl).toHaveBeenCalled();
    const [, init] = fetchImpl.mock.calls[0]! as unknown as [unknown, { body?: string }];
    const body = JSON.parse(String(init?.body ?? "{}"));
    expect(body.model).toBe(BASE_MODEL);
    expect(body.tools ?? []).toEqual([]);
  });

  it("falls back to code reconcile when SERV is unavailable", async () => {
    const tied = [
      car({ key: "cheap", score: 28, priceUsd: 14_000 }),
      car({ key: "pricey", score: 27.5, priceUsd: 16_000 }),
    ];
    const result = await runFindCloseCallMultipathServ({
      cars: tied,
      servKey: null,
    });
    expect(result.source).toBe("code");
    expect(result.finalPickKey).toBe("cheap");
    expect(result.multipath?.source).toBe("code");
    expect(result.proofRecords[0]?.status).toBe("skipped");
    expect(result.proofRecords[0]?.reason).toMatch(/SERV_API_KEY|not configured/i);
  });
});
