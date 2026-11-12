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
      { kv, userId: "synthetic-test-user", servKey: null },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("agent_loop_required");
  });

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
      { kv, userId: "synthetic-test-user", servKey: null },
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
});
