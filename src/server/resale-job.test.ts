/**
 * Stepped Resale job — agent loop is the only settle path (classic inventory deleted).
 */
import { describe, expect, it, vi } from "vitest";
import { creditBalance, creditEventSeen, creditGrant, creditSpend } from "@/io/credit-book";
import { MemoryKv } from "@/io/kv";
import type { Listing } from "@/domain/types";
import { buildResaleCandidatePnls } from "@/domain/resale-pnl";
import { topFlipCandidates } from "@/domain/flip-rank";
import {
  advanceResaleJob,
  createAndRunResaleJobStep1,
  jobToClientBody,
  readResaleJob,
  RESALE_CREDIT_NOTE_UNPAID,
  RESALE_JOB_FINAL_STEP,
} from "./resale-job";
import { resaleSearchSpendKey } from "./resale-search-credit";

function listing(
  partial: Partial<Listing> & Pick<Listing, "vin" | "year" | "make" | "model" | "priceUsd" | "miles">,
): Listing {
  return {
    trim: "EX",
    city: "Omaha",
    state: "NE",
    zip: "68114",
    dealer: "Fixture Motors",
    vdp: null,
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: null,
    accidentCount: 0,
    oneOwner: true,
    ownerCount: 1,
    usageType: null,
    fuel: null,
    engine: null,
    drivetrain: null,
    bodyStyle: "sedan",
    latitude: null,
    longitude: null,
    removedAt: null,
    source: "autodev",
    ...partial,
  };
}

function pool(): Listing[] {
  return [
    listing({ vin: "1HGCV1F30JA000001", year: 2018, make: "Honda", model: "Accord", priceUsd: 12_500, miles: 55_000 }),
    listing({ vin: "1HGCV1F30JA000002", year: 2018, make: "Honda", model: "Accord", priceUsd: 14_800, miles: 58_000 }),
    listing({ vin: "1HGCV1F30JA000003", year: 2018, make: "Honda", model: "Accord", priceUsd: 15_200, miles: 52_000 }),
    listing({ vin: "1HGCV1F30JA000004", year: 2018, make: "Honda", model: "Accord", priceUsd: 14_500, miles: 54_000 }),
    listing({ vin: "1HGCV1F30JA000005", year: 2018, make: "Honda", model: "Accord", priceUsd: 8_500, miles: 51_000 }),
    listing({ vin: "1HGCV1F30JA000006", year: 2018, make: "Honda", model: "Accord", priceUsd: 13_200, miles: 53_000 }),
  ];
}

function assembleFixture(listings: Listing[]) {
  return vi.fn(async () => ({
    ok: true as const,
    listings,
    sample: false,
    message: "fixture inventory",
    status: 200,
  }));
}

function mockAgentOk(listings: Listing[]) {
  const ranked = topFlipCandidates(listings, new Date(), 6, {
    repairAbility: "minor",
    targetProfitUsd: 1500,
  });
  const pnls = buildResaleCandidatePnls(ranked, {
    repairAbility: "minor",
    resaleChannel: "private_party",
    asIs: false,
    sellWithinDays: 30,
    targetProfitUsd: 1500,
    taxState: "NE",
  });
  const pick = pnls[0]!;
  const pnlByVin = new Map(pnls.map((row) => [row.vin.toUpperCase(), row]));
  const listingsByVin = new Map(listings.map((row) => [row.vin.toUpperCase(), row]));
  return {
    ok: true as const,
    agentMode: "tools" as const,
    requestedMode: "tools" as const,
    toolRounds: 2,
    verdictReached: true as const,
    verdict: {
      summary: "synthetic-test flip pick",
      confidence: "medium" as const,
      picks: [
        {
          vin: pick.vin,
          action: "negotiate" as const,
          offerUsd: pick.negotiatedOfferUsd,
          why: "synthetic-test",
        },
      ],
      relaxedConditions: [],
    },
    relaxedConditions: [],
    journal: [],
    knownVins: [...listingsByVin.keys()],
    listingsByVin,
    pnlByVin,
    droppedPicks: [],
    featureRejections: [],
    featureFlags: [],
    servFeatures: {
      features: [],
      promptGuard: null,
      shadowRequested: false,
      shadowMaxIterations: null,
    },
  };
}

describe("resale stepped job (agent loop only)", () => {
  it("step 2 agent loop settles + charges; classic inventory path is gone", async () => {
    const kv = new MemoryKv();
    const ownerId = "11111111-1111-4111-8111-111111111111";
    await creditGrant(kv, ownerId, 3, "test-grant-happy");
    const listings = pool();

    const created = await createAndRunResaleJobStep1(
      { budgetUsd: 15_000, searchIdempotencyKey: "job-happy-1" },
      {
        kv,
        ownerId,
        clientIdempotencyKey: "job-happy-1",
        assembleRadarImpl: assembleFixture(listings) as never,
        autodevKey: "test",
        autodev: { cache: undefined as never, counter: undefined as never },
        servKey: "test-key",
        fetchImpl: fetch,
        env: { VERCEL: undefined, NETLIFY: undefined },
        maxProviderQueries: 6,
        parallelProviderQueries: true,
      },
    );
    expect(created.ok).toBe(true);
    if (!created.ok || created.kind !== "job") return;
    expect(created.job.stepCompleted).toBe(1);
    expect(created.job.charged).toBe(false);

    const step2 = await advanceResaleJob({
      kv,
      ownerId,
      jobId: created.job.jobId,
      step: 2,
      servKey: "test-key",
      env: {},
      inventoryDeps: {
        assembleRadarImpl: assembleFixture(listings) as never,
        autodevKey: "test",
        autodev: { cache: undefined as never, counter: undefined as never },
        servKey: "test-key",
        fetchImpl: fetch,
        env: { VERCEL: undefined, NETLIFY: undefined },
        maxProviderQueries: 6,
        parallelProviderQueries: true,
      },
      runResaleAgentLoopImpl: async () => mockAgentOk(listings) as never,
    });
    expect(step2.ok).toBe(true);
    if (!step2.ok) return;
    expect(step2.job.stepCompleted).toBe(RESALE_JOB_FINAL_STEP);
    expect(step2.job.status).toBe("completed");
    expect(step2.job.delivery?.best).toBeTruthy();
    expect(step2.job.charged).toBe(true);
    expect(await creditBalance(kv, ownerId)).toBe(2);
    expect(await creditEventSeen(kv, resaleSearchSpendKey(ownerId, "job-happy-1"))).toBe(true);
  });

  it("agent failure returns agent_loop_failed with no charge (no classic fallback)", async () => {
    const kv = new MemoryKv();
    const ownerId = "22222222-2222-4222-8222-222222222222";
    await creditGrant(kv, ownerId, 2, "test-grant-fail");
    const listings = pool();

    const created = await createAndRunResaleJobStep1(
      { budgetUsd: 15_000, searchIdempotencyKey: "job-fail-1" },
      {
        kv,
        ownerId,
        clientIdempotencyKey: "job-fail-1",
        assembleRadarImpl: assembleFixture(listings) as never,
        autodevKey: "test",
        autodev: { cache: undefined as never, counter: undefined as never },
        servKey: "test-key",
        fetchImpl: fetch,
        env: { VERCEL: undefined, NETLIFY: undefined },
        maxProviderQueries: 6,
        parallelProviderQueries: true,
      },
    );
    expect(created.ok && created.kind === "job").toBe(true);
    if (!created.ok || created.kind !== "job") return;

    const failed = await advanceResaleJob({
      kv,
      ownerId,
      jobId: created.job.jobId,
      step: 2,
      servKey: "test-key",
      env: {},
      inventoryDeps: {
        assembleRadarImpl: assembleFixture(listings) as never,
        autodevKey: "test",
        autodev: { cache: undefined as never, counter: undefined as never },
        servKey: "test-key",
        fetchImpl: fetch,
        env: { VERCEL: undefined, NETLIFY: undefined },
        maxProviderQueries: 6,
        parallelProviderQueries: true,
      },
      runResaleAgentLoopImpl: async () =>
        ({
          ok: false,
          agentMode: "tools",
          requestedMode: "tools",
          toolRounds: 1,
          verdictReached: false,
          error: "serv_http",
          message: "synthetic-test agent failure",
          journal: [],
          knownVins: [],
          featureRejections: [],
          featureFlags: [],
          servFeatures: null,
        }) as never,
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.status).toBe(503);
    expect(failed.body.error).toBe("agent_loop_failed");
    expect(failed.body.charged).toBe(false);
    expect(await creditBalance(kv, ownerId)).toBe(2);
    const job = await readResaleJob(kv, created.job.jobId);
    expect(job?.status).toBe("failed");
  });

  it("rejects step advances from a non-owner", async () => {
    const kv = new MemoryKv();
    const ownerId = "33333333-3333-4333-8333-333333333333";
    const otherId = "44444444-4444-4444-8444-444444444444";
    await creditGrant(kv, ownerId, 2, "test-grant-owner");
    await creditGrant(kv, otherId, 2, "test-grant-other");
    const listings = pool();

    const created = await createAndRunResaleJobStep1(
      { budgetUsd: 15_000, searchIdempotencyKey: "job-own-1" },
      {
        kv,
        ownerId,
        clientIdempotencyKey: "job-own-1",
        assembleRadarImpl: assembleFixture(listings) as never,
        autodevKey: "test",
        autodev: { cache: undefined as never, counter: undefined as never },
        servKey: "test-key",
        fetchImpl: fetch,
        env: { VERCEL: undefined, NETLIFY: undefined },
        maxProviderQueries: 6,
        parallelProviderQueries: true,
      },
    );
    expect(created.ok && created.kind === "job").toBe(true);
    if (!created.ok || created.kind !== "job") return;

    const denied = await advanceResaleJob({
      kv,
      ownerId: otherId,
      jobId: created.job.jobId,
      step: 2,
      servKey: "test-key",
      env: {},
      inventoryDeps: {
        assembleRadarImpl: assembleFixture(listings) as never,
        autodevKey: "test",
        autodev: { cache: undefined as never, counter: undefined as never },
        servKey: "test-key",
        fetchImpl: fetch,
        env: { VERCEL: undefined, NETLIFY: undefined },
        maxProviderQueries: 6,
        parallelProviderQueries: true,
      },
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe("forbidden");
  });

  it("failed debit after agent settle: delivered_unpaid then retry charge", async () => {
    const kv = new MemoryKv();
    const ownerId = "55555555-5555-4555-8555-555555555555";
    await creditGrant(kv, ownerId, 1, "test-grant-unpaid");
    const listings = pool();

    const created = await createAndRunResaleJobStep1(
      { budgetUsd: 15_000, searchIdempotencyKey: "job-unpaid-1" },
      {
        kv,
        ownerId,
        clientIdempotencyKey: "job-unpaid-1",
        assembleRadarImpl: assembleFixture(listings) as never,
        autodevKey: "test",
        autodev: { cache: undefined as never, counter: undefined as never },
        servKey: "test-key",
        fetchImpl: fetch,
        env: { VERCEL: undefined, NETLIFY: undefined },
        maxProviderQueries: 6,
        parallelProviderQueries: true,
      },
    );
    expect(created.ok && created.kind === "job").toBe(true);
    if (!created.ok || created.kind !== "job") return;

    // Drain credit before settle so charge fails.
    const drained = await creditSpend(kv, ownerId, "drain-before-agent");
    expect(drained.ok).toBe(true);

    const unpaid = await advanceResaleJob({
      kv,
      ownerId,
      jobId: created.job.jobId,
      step: 2,
      servKey: "test-key",
      env: {},
      inventoryDeps: {
        assembleRadarImpl: assembleFixture(listings) as never,
        autodevKey: "test",
        autodev: { cache: undefined as never, counter: undefined as never },
        servKey: "test-key",
        fetchImpl: fetch,
        env: { VERCEL: undefined, NETLIFY: undefined },
        maxProviderQueries: 6,
        parallelProviderQueries: true,
      },
      runResaleAgentLoopImpl: async () => mockAgentOk(listings) as never,
    });
    expect(unpaid.ok).toBe(true);
    if (!unpaid.ok) return;
    expect(unpaid.job.status).toBe("delivered_unpaid");
    expect(unpaid.job.charged).toBe(false);
    expect(jobToClientBody(unpaid.job).creditNote).toBe(RESALE_CREDIT_NOTE_UNPAID);

    await creditGrant(kv, ownerId, 1, "test-grant-unpaid-retry");
    const paid = await advanceResaleJob({
      kv,
      ownerId,
      jobId: created.job.jobId,
      step: RESALE_JOB_FINAL_STEP,
      servKey: "test-key",
      env: {},
    });
    expect(paid.ok).toBe(true);
    if (!paid.ok) return;
    expect(paid.job.status).toBe("completed");
    expect(paid.job.charged).toBe(true);
  });

  it("LEMONLESS_E2E_STUB no longer disables the agent loop", async () => {
    const kv = new MemoryKv();
    const ownerId = "66666666-6666-4666-8666-666666666666";
    await creditGrant(kv, ownerId, 2, "test-grant-e2e");
    const listings = pool();
    let agentCalled = false;

    const created = await createAndRunResaleJobStep1(
      { budgetUsd: 15_000, searchIdempotencyKey: "job-e2e-1" },
      {
        kv,
        ownerId,
        clientIdempotencyKey: "job-e2e-1",
        assembleRadarImpl: assembleFixture(listings) as never,
        autodevKey: "test",
        autodev: { cache: undefined as never, counter: undefined as never },
        servKey: "test-key",
        fetchImpl: fetch,
        env: { VERCEL: undefined, NETLIFY: undefined },
        maxProviderQueries: 6,
        parallelProviderQueries: true,
      },
    );
    expect(created.ok && created.kind === "job").toBe(true);
    if (!created.ok || created.kind !== "job") return;

    const step2 = await advanceResaleJob({
      kv,
      ownerId,
      jobId: created.job.jobId,
      step: 2,
      servKey: "test-key",
      env: { LEMONLESS_E2E_STUB: "1" },
      inventoryDeps: {
        assembleRadarImpl: assembleFixture(listings) as never,
        autodevKey: "test",
        autodev: { cache: undefined as never, counter: undefined as never },
        servKey: "test-key",
        fetchImpl: fetch,
        env: { VERCEL: undefined, NETLIFY: undefined },
        maxProviderQueries: 6,
        parallelProviderQueries: true,
      },
      runResaleAgentLoopImpl: async () => {
        agentCalled = true;
        return mockAgentOk(listings) as never;
      },
    });
    expect(agentCalled).toBe(true);
    expect(step2.ok).toBe(true);
    if (!step2.ok) return;
    expect(step2.job.stepCompleted).toBe(RESALE_JOB_FINAL_STEP);
  });
});
