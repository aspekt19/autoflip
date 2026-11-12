/**
 * Budget-only Resale path under a simulated slow upstream.
 * Must return code-ranked flips (or a JSON time-budget failure) before a Hobby kill.
 */
import { describe, expect, it, vi } from "vitest";
import { MemoryKv } from "@/io/kv";
import {
  makeResaleDeadline,
  RESALE_HANDLER_HARD_CAP_MS,
  RESALE_INTERNAL_BUDGET_MS,
  RESALE_TIME_BUDGET_SKIP,
} from "@/domain/resale-deadline";
import type { Listing } from "@/domain/types";
import { runResaleSearch } from "./resale-search";
import { runResaleSettleServ } from "./resale-settle-serv";

function listing(partial: Partial<Listing> & Pick<Listing, "vin" | "year" | "make" | "model" | "priceUsd" | "miles">): Listing {
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
  const subject = listing({
    vin: "1HGCV1F30JA000001",
    year: 2018,
    make: "Honda",
    model: "Accord",
    priceUsd: 12_500,
    miles: 55_000,
  });
  return [
    subject,
    listing({ vin: "1HGCV1F30JA000002", year: 2018, make: "Honda", model: "Accord", priceUsd: 14_800, miles: 58_000 }),
    listing({ vin: "1HGCV1F30JA000003", year: 2018, make: "Honda", model: "Accord", priceUsd: 15_200, miles: 52_000 }),
    listing({ vin: "1HGCV1F30JA000004", year: 2018, make: "Honda", model: "Accord", priceUsd: 14_500, miles: 54_000 }),
    listing({ vin: "1HGCV1F30JA000005", year: 2018, make: "Honda", model: "Accord", priceUsd: 8_500, miles: 51_000 }),
    listing({ vin: "1HGCV1F30JA000006", year: 2018, make: "Honda", model: "Accord", priceUsd: 13_200, miles: 53_000 }),
    listing({ vin: "5J6RM4H75GL000001", year: 2018, make: "Honda", model: "CR-V", priceUsd: 13_900, miles: 58_000 }),
    listing({ vin: "5J6RM4H75GL000002", year: 2018, make: "Honda", model: "CR-V", priceUsd: 14_200, miles: 56_000 }),
    listing({ vin: "5J6RM4H75GL000003", year: 2018, make: "Honda", model: "CR-V", priceUsd: 15_800, miles: 54_000 }),
    listing({ vin: "5J6RM4H75GL000004", year: 2018, make: "Honda", model: "CR-V", priceUsd: 13_400, miles: 57_000 }),
    listing({ vin: "5J6RM4H75GL000005", year: 2018, make: "Honda", model: "CR-V", priceUsd: 14_900, miles: 59_000 }),
    listing({ vin: "5J6RM4H75GL000006", year: 2018, make: "Honda", model: "CR-V", priceUsd: 12_800, miles: 55_000 }),
  ];
}

/** Fake upstream that hangs until AbortSignal fires — tracks in-flight count. */
function hangingFetchTracker() {
  let inFlight = 0;
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    inFlight += 1;
    try {
      await new Promise<void>((resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        const timer = setTimeout(() => resolve(), 120_000);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });
      return new Response("{}", { status: 200 });
    } finally {
      inFlight -= 1;
    }
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    inFlight: () => inFlight,
  };
}

describe("resale time budget (Hobby ~50s)", () => {
  it("skips later SERV stages when the deadline is already short", async () => {
    const { buildResaleCandidatePnls } = await import("@/domain/resale-pnl");
    const { topFlipCandidates } = await import("@/domain/flip-rank");
    const ranked = topFlipCandidates(pool(), new Date(), 8);
    const candidates = buildResaleCandidatePnls(ranked);
    expect(candidates.length).toBeGreaterThan(0);

    // Deadline already expired for SERV stage floors (12s+) — settle must stay code-only.
    const deadline = makeResaleDeadline(500);
    const slowServ = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 30_000));
      return { ok: true, text: "{}", proof: {} };
    });

    const settled = await runResaleSettleServ({
      candidates,
      budgetUsd: 15_000,
      servKey: "test-key",
      fetchImpl: slowServ as unknown as typeof fetch,
      deadline,
    });

    expect(settled.best).not.toBeNull();
    expect(settled.journal.steps.some((s) => /not run \(time budget\)/i.test(s.decided))).toBe(true);
    expect(slowServ).not.toHaveBeenCalled();
  });

  it("journals shopper skip as not run (time budget)", async () => {
    const { buildResaleCandidatePnls } = await import("@/domain/resale-pnl");
    const { topFlipCandidates } = await import("@/domain/flip-rank");
    const candidates = buildResaleCandidatePnls(topFlipCandidates(pool(), new Date(), 8));
    // Enough for triage floor skip path — shopper must journal when skipped.
    const deadline = makeResaleDeadline(3_000);
    const settled = await runResaleSettleServ({
      candidates,
      budgetUsd: 15_000,
      servKey: "test-key",
      fetchImpl: (async () => {
        await new Promise((r) => setTimeout(r, 60_000));
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
      deadline,
    });
    expect(
      settled.journal.steps.some(
        (s) =>
          /Verdict decide skipped/i.test(s.decided) &&
          s.decided.includes(RESALE_TIME_BUDGET_SKIP),
      ),
    ).toBe(true);
  });

  it("budget-only search still returns under a simulated slow inventory wave", async () => {
    const kv = new MemoryKv();
    const listings = pool();
    let calls = 0;
    const assemble = vi.fn(async (_q: unknown, deps?: { autodev?: { signal?: AbortSignal } }) => {
      calls += 1;
      const signal = deps?.autodev?.signal;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => resolve(), 80);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      }).catch(() => undefined);
      return {
        ok: true as const,
        listings,
        sample: false,
        message: "fixture inventory",
        status: 200,
      };
    });

    const deadline = makeResaleDeadline(2_500);
    const started = Date.now();
    const result = await runResaleSearch(
      { budgetUsd: 15_000 },
      {
        kv,
        assembleRadarImpl: assemble as never,
        autodevKey: "test",
        autodev: { cache: undefined as never, counter: undefined as never },
        servKey: "test-key",
        fetchImpl: (async () => {
          await new Promise((r) => setTimeout(r, 60_000));
          return new Response("{}", { status: 200 });
        }) as typeof fetch,
        deadline,
        internalBudgetMs: 2_500,
        inventoryStageCapMs: 400,
        parallelProviderQueries: true,
        maxProviderQueries: 6,
        // Skip shared-store gate in unit test.
        env: { VERCEL: undefined, NETLIFY: undefined },
      },
    );
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2_400);
    // Classic inventory deleted — non-plan resale search requires the SERV agent loop.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.body.error).toBe("agent_loop_required");
    expect(calls).toBe(0);
  });

  it("worst case: JSON before the injected budget with hanging SERV + Auto.dev; no pending work", async () => {
    const kv = new MemoryKv();
    const listings = pool();
    const hang = hangingFetchTracker();
    let assembleInFlight = 0;

    const assemble = vi.fn(async (_q: unknown, deps?: { autodev?: { signal?: AbortSignal } }) => {
      assembleInFlight += 1;
      try {
        const signal = deps?.autodev?.signal;
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          const timer = setTimeout(() => resolve(), 120_000);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        });
        return {
          ok: true as const,
          listings,
          sample: false,
          message: "should not finish",
          status: 200,
        };
      } catch {
        return {
          ok: false as const,
          listings: [] as Listing[],
          sample: false,
          message: "aborted",
          status: 504,
          error: "provider_timeout",
        };
      } finally {
        assembleInFlight -= 1;
      }
    });

    // Simulate request arrival — deadline starts here (same as route first line).
    expect(RESALE_INTERNAL_BUDGET_MS).toBeGreaterThanOrEqual(90_000);
    expect(RESALE_INTERNAL_BUDGET_MS).toBeLessThan(300_000);
    expect(RESALE_HANDLER_HARD_CAP_MS).toBeLessThan(300_000);
    const injectedBudgetMs = 6_000;
    const requestStarted = Date.now();
    const deadline = makeResaleDeadline(injectedBudgetMs, requestStarted);

    const result = await runResaleSearch(
      { budgetUsd: 15_000 },
      {
        kv,
        assembleRadarImpl: assemble as never,
        autodevKey: "test",
        autodev: { cache: undefined as never, counter: undefined as never },
        servKey: "test-key",
        fetchImpl: hang.fetchImpl,
        deadline,
        internalBudgetMs: injectedBudgetMs,
        inventoryStageCapMs: 1_500,
        parallelProviderQueries: true,
        maxProviderQueries: 6,
        env: { VERCEL: undefined, NETLIFY: undefined },
      },
    );
    const elapsed = Date.now() - requestStarted;

    expect(elapsed).toBeLessThan(injectedBudgetMs + 1_500);
    // Must return a JSON-shaped result (ok or time_budget) — never hang.
    expect(result).toBeTruthy();
    expect(typeof result.ok).toBe("boolean");
    expect(result.status).toBeGreaterThanOrEqual(200);

    // Drain microtasks; aborted fetches must have cleared in-flight counters.
    await new Promise((r) => setTimeout(r, 50));
    expect(hang.inFlight()).toBe(0);
    expect(assembleInFlight).toBe(0);
  }, 60_000);
});
