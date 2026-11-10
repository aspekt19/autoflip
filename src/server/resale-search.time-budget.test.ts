/**
 * Budget-only Resale path under a simulated slow upstream.
 * Must return code-ranked flips (or a JSON time-budget failure) before a Hobby kill.
 */
import { describe, expect, it, vi } from "vitest";
import { MemoryKv } from "@/io/kv";
import { makeResaleDeadline, RESALE_TIME_BUDGET_SKIP } from "@/domain/resale-deadline";
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
    listing({ vin: "1HGCV1F30JA000002", year: 2017, make: "Honda", model: "Accord", priceUsd: 14_800, miles: 62_000 }),
    listing({ vin: "1HGCV1F30JA000003", year: 2018, make: "Honda", model: "Accord", priceUsd: 15_200, miles: 48_000 }),
    listing({ vin: "1HGCV1F30JA000004", year: 2019, make: "Honda", model: "Accord", priceUsd: 16_500, miles: 40_000 }),
    listing({ vin: "1HGCV1F30JA000005", year: 2016, make: "Honda", model: "Accord", priceUsd: 11_900, miles: 80_000 }),
    listing({ vin: "5J6RM4H75GL000001", year: 2018, make: "Honda", model: "CR-V", priceUsd: 13_900, miles: 58_000 }),
    listing({ vin: "5J6RM4H75GL000002", year: 2017, make: "Honda", model: "CR-V", priceUsd: 14_200, miles: 70_000 }),
    listing({ vin: "5J6RM4H75GL000003", year: 2019, make: "Honda", model: "CR-V", priceUsd: 15_800, miles: 45_000 }),
  ];
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

  it("budget-only search still returns under a simulated slow inventory wave", async () => {
    const kv = new MemoryKv();
    const listings = pool();
    let calls = 0;
    const assemble = vi.fn(async () => {
      calls += 1;
      // Each Autodev call would be ~12s sequential; parallel + stage cap must not wait for all.
      await new Promise((r) => setTimeout(r, 80));
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
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.best).not.toBeNull();
    expect(result.body.budgetUsd).toBe(15_000);
    expect(
      result.body.journal.steps.some(
        (s) => s.decided.includes(RESALE_TIME_BUDGET_SKIP) || /time budget/i.test(s.why),
      ),
    ).toBe(true);
    expect(calls).toBeGreaterThan(0);
  });
});
