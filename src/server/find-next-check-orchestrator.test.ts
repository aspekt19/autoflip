import { describe, expect, it, vi } from "vitest";
import { MemoryKv } from "@/io/kv";
import { explicitNeedFromText } from "@/domain/need";
import {
  mintFindSearchContextRecord,
  storeFindSearchContext,
  loadFindSearchContext,
} from "./find-search-context";
import { runFindNextCheckOrchestrator } from "./find-next-check-orchestrator";

const baseNeed = explicitNeedFromText(
  "reliable Toyota not too old under 20k near 68114 within 50 miles",
  "personal",
);

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function seedContext(
  kv: MemoryKv,
  opts?: { listings?: Array<{ make: string; model: string; year: number; priceUsd: number | null; miles: number | null }>; yearMin?: number },
) {
  const need = { ...baseNeed, yearMin: opts?.yearMin ?? baseNeed.yearMin };
  const record = mintFindSearchContextRecord({
    userId: "u1",
    need,
    refine: { yearMin: need.yearMin ?? undefined },
    listings: opts?.listings ?? [],
    servNextCheckEnabled: true,
  });
  await storeFindSearchContext(kv, record);
  return record;
}

describe("runFindNextCheckOrchestrator", () => {
  it("rejects client authority — requires owned searchContextToken", async () => {
    const kv = new MemoryKv();
    const result = await runFindNextCheckOrchestrator(
      { searchContextToken: null },
      { kv, userId: "u1", servKey: "k" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("search_context_invalid");
  });

  it("keyed SERV choose → rematch called with NEW need (not stale yearMin)", async () => {
    const kv = new MemoryKv();
    // Empty inventory → widen_or_nationwide; need starts with yearMin null ("not too old" may set via clarify — use empty + distance)
    const record = await seedContext(kv, { listings: [], yearMin: null as unknown as undefined });
    // force yearMin null on stored need
    const loaded = await loadFindSearchContext(kv, { userId: "u1", token: record.token });
    expect(loaded.ok).toBe(true);

    const matchCalls: Array<{ need: { yearMin: number | null; distanceMiles: number | null }; refine: unknown }> = [];
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({ checkId: "clarify_year_band", note: "set year floor" }),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );

    // Need without yearMin so clarify_year_band mutates
    const bare = mintFindSearchContextRecord({
      userId: "u1",
      need: { ...baseNeed, yearMin: null, yearMax: null },
      refine: {},
      listings: [{ make: "Toyota", model: "Camry", year: 2018, priceUsd: 15000, miles: 40000 }],
      servNextCheckEnabled: true,
      token: "tok-year",
    });
    await storeFindSearchContext(kv, bare);

    const result = await runFindNextCheckOrchestrator(
      { searchContextToken: "tok-year" },
      {
        kv,
        userId: "u1",
        servKey: "test-key",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        env: {},
        runMatch: async ({ need, refine }) => {
          matchCalls.push({ need: { yearMin: need.yearMin, distanceMiles: need.distanceMiles }, refine });
          return {
            ok: true,
            status: 200,
            body: {
              ok: true,
              directions: [
                {
                  listings: [
                    {
                      vin: "JT2BF28K0X0123456",
                      make: "Toyota",
                      model: "Camry",
                      year: 2016,
                      priceUsd: 14000,
                      miles: 50000,
                      priceView: { usableForBudget: true },
                    },
                  ],
                },
              ],
            },
          };
        },
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.autonomousServ).toBe(true);
    expect(result.source).toBe("serv");
    expect(result.chosenId).toBe("clarify_year_band");
    expect(result.needAfter.yearMin).toBe(2015);
    expect(matchCalls).toHaveLength(1);
    // Rematch must see NEW yearMin from apply — not null/stale.
    expect(matchCalls[0]!.need.yearMin).toBe(2015);
    expect(result.rematch?.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Evidence from rematch stored for subsequent planner call
    const after = await loadFindSearchContext(kv, { userId: "u1", token: "tok-year" });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.record.need.yearMin).toBe(2015);
    expect(after.record.listings.some((l) => l.year === 2016)).toBe(true);
    expect(after.record.appliedCheckIds).toContain("clarify_year_band");
  });

  it("concurrent same-action: only one SERV HTTP", async () => {
    const kv = new MemoryKv();
    await storeFindSearchContext(
      kv,
      mintFindSearchContextRecord({
        userId: "u1",
        need: { ...baseNeed, yearMin: null },
        listings: [],
        servNextCheckEnabled: true,
        token: "tok-race",
      }),
    );
    let inflight = 0;
    let maxInflight = 0;
    const fetchImpl = vi.fn(async () => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 30));
      inflight -= 1;
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify({ checkId: "widen_or_nationwide", note: "w" }) } }],
      });
    });
    const deps = {
      kv,
      userId: "u1",
      servKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      env: {},
      runMatch: async () => ({ ok: true, status: 200, body: { ok: true, directions: [] } }),
    };
    const results = await Promise.all([
      runFindNextCheckOrchestrator({ searchContextToken: "tok-race" }, deps),
      runFindNextCheckOrchestrator({ searchContextToken: "tok-race" }, deps),
      runFindNextCheckOrchestrator({ searchContextToken: "tok-race" }, deps),
    ]);
    const conflicts = results.filter((r) => !r.ok && "error" in r && r.error === "next_check_in_progress");
    const success = results.filter((r) => r.ok);
    expect(success.length + conflicts.length).toBe(3);
    expect(success.length).toBeGreaterThanOrEqual(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(maxInflight).toBe(1);
  });

  it("keyless deterministic_fallback is not autonomous SERV", async () => {
    const kv = new MemoryKv();
    await storeFindSearchContext(
      kv,
      mintFindSearchContextRecord({
        userId: "u1",
        need: baseNeed,
        listings: [],
        servNextCheckEnabled: false,
        token: "tok-keyless",
      }),
    );
    const fetchImpl = vi.fn();
    const result = await runFindNextCheckOrchestrator(
      { searchContextToken: "tok-keyless" },
      { kv, userId: "u1", servKey: null, fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.autonomousServ).toBe(false);
    expect(result.source).toBe("deterministic_fallback");
    expect(result.honesty).toMatch(/not autonomous SERV/i);
    expect(result.loop.reason).toBe("no_serv_key");
    expect(result.keyedAutonomyDiag.keyed).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("free_gov_recalls: mock port receipts → evidence_changed_replan (NOT live NHTSA)", async () => {
    const kv = new MemoryKv();
    await storeFindSearchContext(
      kv,
      mintFindSearchContextRecord({
        userId: "u1",
        need: {
          ...baseNeed,
          conditionPriority: "inspection_first",
          note: "SUV under 20k — don't want hidden problems",
        },
        listings: [
          {
            make: "Mazda",
            model: "CX-5",
            year: 2017,
            priceUsd: 14950,
            miles: 60000,
            vin: "JM3KE4DY5H0123456",
          },
          {
            make: "Toyota",
            model: "RAV4",
            year: 2015,
            priceUsd: 16700,
            miles: 74000,
            vin: "JTMRFREV0F0654321",
          },
        ],
        servNextCheckEnabled: true,
        token: "tok-freegov",
      }),
    );
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                checkId: "free_gov_recalls",
                note: "check free recalls first",
              }),
            },
          },
        ],
      }),
    );
    const result = await runFindNextCheckOrchestrator(
      { searchContextToken: "tok-freegov" },
      {
        kv,
        userId: "u1",
        servKey: "k",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        env: {},
        freeGovPort: {
          async run(toolId, listing) {
            return {
              toolId,
              status: "empty" as const,
              cached: false,
              fetchedAt: new Date().toISOString(),
              scope: "offline_mock_NOT_live_nhtsa",
              url: null,
              timeoutMs: 1,
              rateNote: "offline mock — NOT live proof",
              limitsNote: "Test double; make/model ≠ VIN-open recall status.",
              facts: [],
              summary: `Mock empty recalls for ${listing.make} ${listing.model} ${listing.year}`,
              outcomeOk: true,
              outcomeStatus: "empty" as const,
              outcomeCapability: "empty" as const,
            };
          },
        },
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.chosenId).toBe("free_gov_recalls");
    expect(result.freeGovReceipts.length).toBeGreaterThan(0);
    expect(result.freeEvidenceNote).toMatch(/No Report credit/i);
    expect(result.loop.continue).toBe(true);
    expect(result.loop.reason).toBe("evidence_changed_replan");
    const stored = await loadFindSearchContext(kv, { userId: "u1", token: "tok-freegov" });
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.record.freeGovReceipts?.length).toBeGreaterThan(0);
  });

  it("subsequent next-check facts include rematch listings (evidence → planner)", async () => {
    const kv = new MemoryKv();
    await storeFindSearchContext(
      kv,
      mintFindSearchContextRecord({
        userId: "u1",
        need: { ...baseNeed, yearMin: null },
        listings: [],
        servNextCheckEnabled: true,
        token: "tok-ev",
      }),
    );
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      const n = fetchImpl.mock.calls.length;
      const checkId = n === 1 ? "clarify_year_band" : "compare_observed_asks";
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify({ checkId, note: "n" }) } }],
      });
    });

    const first = await runFindNextCheckOrchestrator(
      { searchContextToken: "tok-ev" },
      {
        kv,
        userId: "u1",
        servKey: "k",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        env: {},
        runMatch: async () => ({
          ok: true,
          status: 200,
          body: {
            ok: true,
            directions: [
              {
                listings: [
                  {
                    vin: "1",
                    make: "Honda",
                    model: "Civic",
                    year: 2017,
                    priceUsd: 12000,
                    miles: 60000,
                    priceView: { usableForBudget: true },
                  },
                ],
              },
            ],
          },
        }),
      },
    );
    expect(first.ok).toBe(true);

    const second = await runFindNextCheckOrchestrator(
      { searchContextToken: "tok-ev" },
      {
        kv,
        userId: "u1",
        servKey: "k",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        env: {},
      },
    );
    expect(second.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Nested user JSON is escaped inside the chat body — assert listing evidence landed.
    expect(bodies[1]).toContain('observedListingCount\\":1');
    expect(bodies[0]).toContain('observedListingCount\\":0');
  });
});
