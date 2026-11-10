/**
 * Stepped Resale job: happy path through all SERV settle phases, idempotent retries, ownership.
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
    listing({ vin: "1HGCV1F30JA000002", year: 2017, make: "Honda", model: "Accord", priceUsd: 14_800, miles: 62_000 }),
    listing({ vin: "1HGCV1F30JA000003", year: 2018, make: "Honda", model: "Accord", priceUsd: 15_200, miles: 48_000 }),
    listing({ vin: "1HGCV1F30JA000004", year: 2019, make: "Honda", model: "Accord", priceUsd: 16_500, miles: 40_000 }),
    listing({ vin: "1HGCV1F30JA000005", year: 2016, make: "Honda", model: "Accord", priceUsd: 11_900, miles: 80_000 }),
    listing({ vin: "5J6RM4H75GL000001", year: 2018, make: "Honda", model: "CR-V", priceUsd: 13_900, miles: 58_000 }),
    listing({ vin: "5J6RM4H75GL000002", year: 2017, make: "Honda", model: "CR-V", priceUsd: 14_200, miles: 70_000 }),
    listing({ vin: "5J6RM4H75GL000003", year: 2019, make: "Honda", model: "CR-V", priceUsd: 15_800, miles: 45_000 }),
  ];
}

function schemaNameFromBody(raw: string): string | null {
  try {
    const body = JSON.parse(raw) as { response_format?: { json_schema?: { name?: string } } };
    return body.response_format?.json_schema?.name ?? null;
  } catch {
    return null;
  }
}

function vinsFromBody(raw: string): string[] {
  try {
    const body = JSON.parse(raw) as { messages?: Array<{ role?: string; content?: string }> };
    const user = body.messages?.find((m) => m.role === "user")?.content ?? "";
    const parsed = JSON.parse(user) as { facts?: { allowedVins?: string[]; candidates?: Array<{ vin?: string }> } };
    if (Array.isArray(parsed.facts?.allowedVins)) return parsed.facts!.allowedVins!;
    if (Array.isArray(parsed.facts?.candidates)) {
      return parsed.facts!.candidates!.map((c) => c.vin).filter((v): v is string => typeof v === "string");
    }
    return [];
  } catch {
    return [];
  }
}

/** SERV mock that answers each resale/shopper profile with allowlisted payloads. */
function servFetchMock(): typeof fetch {
  let call = 0;
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    call += 1;
    const raw = typeof init?.body === "string" ? init.body : "";
    const schema = schemaNameFromBody(raw);
    const vins = vinsFromBody(raw);
    const pickVin = vins[0] ?? "1HGCV1F30JA000001";

    let content: Record<string, unknown> = { note: "fixture" };
    if (schema === "resale_plan_search") {
      content = { directionIds: [], note: "Use editorial directions.", widen: false };
    } else if (schema === "resale_triage") {
      content = {
        deepCheckVins: vins.slice(0, 2),
        skipVins: [],
        checkIds: ["price_comps", "history"],
        note: "Deep-check top VINs from allowlist.",
      };
    } else if (schema === "resale_pick") {
      content = {
        pickVin,
        action: "negotiate",
        note: "Pick allowlisted VIN from code P&L.",
        evidenceIds: [`vin:${pickVin}`, "check:price_comps"],
      };
    } else if (schema === "resale_challenge") {
      content = {
        agrees: true,
        pickVin,
        action: "negotiate",
        objection: null,
        evidenceIds: [`vin:${pickVin}`, "check:price_comps"],
      };
    } else if (schema === "report_verdict_decision") {
      content = { verdict: "negotiate", note: "Negotiate from code facts." };
    } else if (schema === "report_verdict_challenge") {
      content = {
        agrees: true,
        action: "negotiate",
        objection: null,
        evidenceIds: ["pnl_mid", "comps"],
      };
    } else {
      // NHTSA / other deep-check fetches
      return new Response(JSON.stringify({ Results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return Response.json({
      id: `chatcmpl-step-${call}-${schema ?? "other"}`,
      object: "chat.completion",
      
      choices: [
        {
          finish_reason: "stop",
          message: { content: JSON.stringify(content) },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  }) as typeof fetch;
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

describe("resale stepped job", () => {
  it("happy path: inventory then all settle SERV phases, charge once on step 4", async () => {
    const kv = new MemoryKv();
    const ownerId = "11111111-1111-4111-8111-111111111111";
    await creditGrant(kv, ownerId, 3, "test-grant-happy");
    const listings = pool();
    const fetchImpl = servFetchMock();
    const assemble = assembleFixture(listings);

    const created = await createAndRunResaleJobStep1(
      { budgetUsd: 15_000, searchIdempotencyKey: "job-happy-1" },
      {
        kv,
        ownerId,
        clientIdempotencyKey: "job-happy-1",
        assembleRadarImpl: assemble as never,
        autodevKey: "test",
        autodev: { cache: undefined as never, counter: undefined as never },
        servKey: "test-key",
        fetchImpl,
        env: { VERCEL: undefined, NETLIFY: undefined },
        maxProviderQueries: 6,
        parallelProviderQueries: true,
      },
    );
    expect(created.ok).toBe(true);
    if (!created.ok || created.kind !== "job") return;
    expect(created.job.stepCompleted).toBe(1);
    expect(created.job.candidates.length).toBeGreaterThan(0);
    expect(created.job.charged).toBe(false);
    expect(await creditBalance(kv, ownerId)).toBe(3);

    const profilesSeen = new Set<string>();
    const trackingFetch: typeof fetch = async (input, init) => {
      const raw = typeof init?.body === "string" ? init.body : "";
      const schema = schemaNameFromBody(raw);
      if (schema) profilesSeen.add(schema);
      return fetchImpl(input, init);
    };

    const step2 = await advanceResaleJob({
      kv,
      ownerId,
      jobId: created.job.jobId,
      step: 2,
      servKey: "test-key",
      fetchImpl: trackingFetch,
    });
    expect(step2.ok).toBe(true);
    if (!step2.ok) return;
    expect(step2.job.stepCompleted).toBe(2);
    expect(step2.job.settleCheckpoint?.phaseCompleted).toBe("triage_deep");
    expect(profilesSeen.has("resale_triage")).toBe(true);
    expect(step2.job.charged).toBe(false);

    const step3 = await advanceResaleJob({
      kv,
      ownerId,
      jobId: created.job.jobId,
      step: 3,
      servKey: "test-key",
      fetchImpl: trackingFetch,
    });
    expect(step3.ok).toBe(true);
    if (!step3.ok) return;
    expect(step3.job.stepCompleted).toBe(3);
    expect(step3.job.settleCheckpoint?.phaseCompleted).toBe("pick_challenge");
    expect(profilesSeen.has("resale_pick")).toBe(true);
    expect(profilesSeen.has("resale_challenge")).toBe(true);
    expect(step3.job.charged).toBe(false);
    expect(await creditBalance(kv, ownerId)).toBe(3);

    const step4 = await advanceResaleJob({
      kv,
      ownerId,
      jobId: created.job.jobId,
      step: 4,
      servKey: "test-key",
      fetchImpl: trackingFetch,
    });
    expect(step4.ok).toBe(true);
    if (!step4.ok) return;
    expect(step4.job.stepCompleted).toBe(4);
    expect(step4.job.status).toBe("completed");
    expect(step4.job.delivery?.best).toBeTruthy();
    expect(step4.job.charged).toBe(true);
    expect(profilesSeen.has("report_verdict_decision")).toBe(true);
    expect(profilesSeen.has("report_verdict_challenge")).toBe(true);
    expect(await creditBalance(kv, ownerId)).toBe(2);
    expect(await creditEventSeen(kv, resaleSearchSpendKey(ownerId, "job-happy-1"))).toBe(true);
  });

  it("retrying a completed step is idempotent (no redo, no double charge)", async () => {
    const kv = new MemoryKv();
    const ownerId = "22222222-2222-4222-8222-222222222222";
    await creditGrant(kv, ownerId, 2, "test-grant-idem");
    const listings = pool();
    const fetchImpl = servFetchMock();
    let servPosts = 0;
    const countingFetch: typeof fetch = async (input, init) => {
      const raw = typeof init?.body === "string" ? init.body : "";
      if (schemaNameFromBody(raw)) servPosts += 1;
      return fetchImpl(input, init);
    };

    const created = await createAndRunResaleJobStep1(
      { budgetUsd: 15_000, searchIdempotencyKey: "job-idem-1" },
      {
        kv,
        ownerId,
        clientIdempotencyKey: "job-idem-1",
        assembleRadarImpl: assembleFixture(listings) as never,
        autodevKey: "test",
        autodev: { cache: undefined as never, counter: undefined as never },
        servKey: "test-key",
        fetchImpl: countingFetch,
        env: { VERCEL: undefined, NETLIFY: undefined },
        maxProviderQueries: 6,
        parallelProviderQueries: true,
      },
    );
    expect(created.ok && created.kind === "job").toBe(true);
    if (!created.ok || created.kind !== "job") return;

    const first2 = await advanceResaleJob({
      kv,
      ownerId,
      jobId: created.job.jobId,
      step: 2,
      servKey: "test-key",
      fetchImpl: countingFetch,
    });
    expect(first2.ok).toBe(true);
    if (!first2.ok) return;
    const postsAfter2 = servPosts;
    const journalLen = first2.job.settleCheckpoint?.journal.steps.length ?? 0;

    const retry2 = await advanceResaleJob({
      kv,
      ownerId,
      jobId: created.job.jobId,
      step: 2,
      servKey: "test-key",
      fetchImpl: countingFetch,
    });
    expect(retry2.ok).toBe(true);
    if (!retry2.ok) return;
    expect(retry2.job.stepCompleted).toBe(2);
    expect(servPosts).toBe(postsAfter2);
    expect(retry2.job.settleCheckpoint?.journal.steps.length).toBe(journalLen);

    for (const step of [3, 4] as const) {
      const run = await advanceResaleJob({
        kv,
        ownerId,
        jobId: created.job.jobId,
        step,
        servKey: "test-key",
        fetchImpl: countingFetch,
      });
      expect(run.ok).toBe(true);
    }
    const balanceAfter = await creditBalance(kv, ownerId);
    expect(balanceAfter).toBe(1);

    const postsBeforeRetry4 = servPosts;
    const retry4 = await advanceResaleJob({
      kv,
      ownerId,
      jobId: created.job.jobId,
      step: 4,
      servKey: "test-key",
      fetchImpl: countingFetch,
    });
    expect(retry4.ok).toBe(true);
    if (!retry4.ok) return;
    expect(servPosts).toBe(postsBeforeRetry4);
    expect(await creditBalance(kv, ownerId)).toBe(1);
    expect(retry4.job.charged).toBe(true);
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
        fetchImpl: servFetchMock(),
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
      fetchImpl: servFetchMock(),
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe("forbidden");

    const still = await readResaleJob(kv, created.job.jobId);
    expect(still?.stepCompleted).toBe(1);
    expect(still?.charged).toBe(false);
  });

  it("failed debit: shows result as delivered_unpaid, honest label, retries charge", async () => {
    const kv = new MemoryKv();
    const ownerId = "55555555-5555-4555-8555-555555555555";
    // Exactly 1 credit — spent after step 3 so step 4 debit fails.
    await creditGrant(kv, ownerId, 1, "test-grant-unpaid");
    const listings = pool();
    const fetchImpl = servFetchMock();

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
        fetchImpl,
        env: { VERCEL: undefined, NETLIFY: undefined },
        maxProviderQueries: 6,
        parallelProviderQueries: true,
      },
    );
    expect(created.ok && created.kind === "job").toBe(true);
    if (!created.ok || created.kind !== "job") return;

    for (const step of [2, 3] as const) {
      const run = await advanceResaleJob({
        kv,
        ownerId,
        jobId: created.job.jobId,
        step,
        servKey: "test-key",
        fetchImpl,
      });
      expect(run.ok).toBe(true);
    }

    // Drain the only credit with an unrelated spend so step 4 debit fails.
    const drained = await creditSpend(kv, ownerId, "drain-before-step4");
    expect(drained.ok).toBe(true);
    expect(await creditBalance(kv, ownerId)).toBe(0);

    const unpaid = await advanceResaleJob({
      kv,
      ownerId,
      jobId: created.job.jobId,
      step: 4,
      servKey: "test-key",
      fetchImpl,
    });
    expect(unpaid.ok).toBe(true);
    if (!unpaid.ok) return;
    expect(unpaid.job.status).toBe("delivered_unpaid");
    expect(unpaid.job.charged).toBe(false);
    expect(unpaid.job.delivery?.best).toBeTruthy();
    expect(unpaid.job.delivery?.chargedCredit).toBe(false);
    expect(await creditEventSeen(kv, resaleSearchSpendKey(ownerId, "job-unpaid-1"))).toBe(false);

    const client = jobToClientBody(unpaid.job, { balance: unpaid.balance });
    expect(client.chargedCredit).toBe(false);
    expect(client.done).toBe(false);
    expect(client.creditNote).toBe(RESALE_CREDIT_NOTE_UNPAID);
    expect(client.creditNote).toMatch(/Credit not charged/i);

    // Replay label stays honest (still unpaid).
    const replayUnpaid = await createAndRunResaleJobStep1(
      { budgetUsd: 15_000, searchIdempotencyKey: "job-unpaid-1" },
      {
        kv,
        ownerId,
        clientIdempotencyKey: "job-unpaid-1",
        assembleRadarImpl: assembleFixture(listings) as never,
        autodevKey: "test",
        autodev: { cache: undefined as never, counter: undefined as never },
        servKey: "test-key",
        fetchImpl,
        env: { VERCEL: undefined, NETLIFY: undefined },
      },
    );
    expect(replayUnpaid.ok && replayUnpaid.kind === "job").toBe(true);
    if (!replayUnpaid.ok || replayUnpaid.kind !== "job") return;
    expect(replayUnpaid.job.status).toBe("delivered_unpaid");
    expect(replayUnpaid.job.charged).toBe(false);
    expect(jobToClientBody(replayUnpaid.job).chargedCredit).toBe(false);

    // Fund account and retry charge via advance — no SERV redo, then paid.
    await creditGrant(kv, ownerId, 1, "test-grant-unpaid-retry");
    const postsBefore = { n: 0 };
    const countingFetch: typeof fetch = async (input, init) => {
      const raw = typeof init?.body === "string" ? init.body : "";
      if (schemaNameFromBody(raw)) postsBefore.n += 1;
      return fetchImpl(input, init);
    };
    const paid = await advanceResaleJob({
      kv,
      ownerId,
      jobId: created.job.jobId,
      step: 4,
      servKey: "test-key",
      fetchImpl: countingFetch,
    });
    expect(paid.ok).toBe(true);
    if (!paid.ok) return;
    expect(postsBefore.n).toBe(0);
    expect(paid.job.status).toBe("completed");
    expect(paid.job.charged).toBe(true);
    expect(paid.job.delivery?.chargedCredit).toBe(true);
    expect(jobToClientBody(paid.job).chargedCredit).toBe(true);
    expect(jobToClientBody(paid.job).done).toBe(true);
    expect(await creditBalance(kv, ownerId)).toBe(0);
    expect(await creditEventSeen(kv, resaleSearchSpendKey(ownerId, "job-unpaid-1"))).toBe(true);
  });

  it("settle phases chain without duplicating triage work", async () => {
    const candidates = buildResaleCandidatePnls(topFlipCandidates(pool(), new Date(), 8));
    expect(candidates.length).toBeGreaterThan(0);
    const { runResaleSettleServ } = await import("./resale-settle-serv");
    const fetchImpl = servFetchMock();
    const schemas: string[] = [];
    const tracking: typeof fetch = async (input, init) => {
      const raw = typeof init?.body === "string" ? init.body : "";
      const schema = schemaNameFromBody(raw);
      if (schema) schemas.push(schema);
      return fetchImpl(input, init);
    };

    const triage = await runResaleSettleServ({
      candidates,
      budgetUsd: 15_000,
      servKey: "test-key",
      
      fetchImpl: tracking,
      phase: "triage_deep",
    });
    expect(triage.checkpoint.phaseCompleted).toBe("triage_deep");
    expect(schemas.filter((s) => s === "resale_triage").length).toBe(1);
    expect(schemas.some((s) => s === "resale_pick")).toBe(false);

    const pick = await runResaleSettleServ({
      candidates,
      budgetUsd: 15_000,
      servKey: "test-key",
      
      fetchImpl: tracking,
      phase: "pick_challenge",
      checkpoint: triage.checkpoint,
    });
    expect(pick.checkpoint.phaseCompleted).toBe("pick_challenge");
    expect(schemas.filter((s) => s === "resale_triage").length).toBe(1);
    expect(schemas.some((s) => s === "resale_pick")).toBe(true);

    const shopper = await runResaleSettleServ({
      candidates,
      budgetUsd: 15_000,
      servKey: "test-key",
      
      fetchImpl: tracking,
      phase: "shopper",
      checkpoint: pick.checkpoint,
    });
    expect(shopper.checkpoint.phaseCompleted).toBe("shopper");
    expect(shopper.best?.vin).toBeTruthy();
    expect(schemas.filter((s) => s === "resale_triage").length).toBe(1);
  });
});
