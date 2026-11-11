/**
 * Billable Find requires verified Auth.js account (t334 residual Fix A).
 * No Autodev/SERV network — mocks only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKv } from "@/io/kv";
import { creditBalance, creditGrant } from "@/io/credit-book";
import { readFreeCheckQuota } from "@/io/free-check-quota";
import {
  loadFindSearchContext,
  mintFindSearchContextRecord,
  storeFindSearchContext,
} from "@/server/find-search-context";

const ACCOUNT = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const ANON = "ffffffff-ffff-ffff-ffff-ffffffffffff";

const kvHolder: { kv: MemoryKv } = { kv: new MemoryKv() };
const requireFind = vi.fn();
const runFind = vi.fn();

vi.mock("@/server/session", () => ({
  requireVerifiedAccountForFind: () => requireFind(),
  ledgerOwnerId: async () => ANON,
  userId: async () => ANON,
}));

vi.mock("@/server/find-match", () => ({
  runFindMatch: (body: unknown, deps: unknown) => runFind(body, deps),
}));

vi.mock("@/server/deps", () => ({
  runtimeDeps: () => ({ autodevKey: null, servKey: null }),
}));

vi.mock("@/io/kv", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/io/kv")>();
  return { ...actual, getKv: () => kvHolder.kv };
});

vi.mock("@/server/find-analysis-context", () => ({
  rememberFindAnalysisContexts: async () => new Map(),
}));

import { POST } from "./route";

const NEED = {
  mode: "personal",
  useCase: "commute",
  note: "reliable SUV under 20k",
  budgetUsd: 20_000,
  budgetKnown: true,
  budgetScope: "car",
  mustHaves: [],
  priorities: [],
  zip: "33101",
  distanceMiles: 50,
  repairAbility: "unknown",
  targetProfitUsd: null,
  milesMax: null,
  yearMin: 2016,
  yearMax: 2022,
  yearBandResolved: true,
  milesCapResolved: true,
  conditionPriority: "unspecified",
  make: null,
  preferredMakes: [],
  preferredModels: [],
  preferredModelsSource: "none",
  openToOtherMakes: true,
};

function req(body: unknown) {
  return new Request("https://lemonless.test/api/match", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Delivered Find body — at least one provider query and one listing (REPORT_356a charge gate). */
function deliveredMatchBody(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    sample: false,
    emptyReason: null,
    message: null,
    headline: null,
    nextStep: null,
    scope: "test",
    affordabilityAssessed: true,
    partialFailure: false,
    geoScope: { kind: "nationwide" },
    directions: [
      {
        direction: {
          id: "d1",
          segment: "Compact crossovers",
          models: [{ make: "Mazda", model: "CX-5" }],
          search: { make: "Mazda", model: "CX-5" },
          yearMin: 2020,
          yearMax: 2022,
        },
        listings: [
          {
            vin: "1M8GDM9AXKP042788",
            year: 2020,
            make: "Mazda",
            model: "CX-5",
            miles: 40000,
            priceUsd: 18000,
            vdp: "https://dealer.example/vdp/1",
            source: "live",
            badge: { label: "Fair", tone: "fair" },
            flipNote: null,
            clearsTarget: null,
            priceView: { usableForBudget: true, displayPrimary: "$18,000" },
          },
        ],
        coverage: "ok",
        coverageLevel: "medium",
        note: null,
        plannedModels: [{ make: "Mazda", model: "CX-5" }],
        searchedModels: [{ make: "Mazda", model: "CX-5" }],
        failedModels: [],
        skippedModels: [],
        providerWarning: null,
        queryOutcomes: [],
      },
    ],
    compsPool: [],
    providerQueriesUsed: 1,
    ...overrides,
  };
}

describe("POST /api/match verified-auth Find (t334 Fix A)", () => {
  beforeEach(async () => {
    kvHolder.kv = new MemoryKv();
    requireFind.mockReset();
    runFind.mockReset();
    await creditGrant(kvHolder.kv, ACCOUNT, 3, "init-acct");
    await creditGrant(kvHolder.kv, ANON, 9, "init-anon");
  });

  it("denies Find without verified auth (no anonymous debit)", async () => {
    requireFind.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "auth_required" }, { status: 401 }),
    });
    const res = await POST(req({ need: NEED, searchIdempotencyKey: "find-unauth-0001" }));
    expect(res.status).toBe(401);
    expect(runFind).not.toHaveBeenCalled();
    // Anonymous cookie balance must not move.
    expect(await creditBalance(kvHolder.kv, ANON)).toBe(9);
    expect(await creditBalance(kvHolder.kv, ACCOUNT)).toBe(3);
  });

  it("debits 1 credit for verified Find and rematch continuation does not re-debit", async () => {
    requireFind.mockResolvedValue({ ok: true, id: ACCOUNT, email: "a@example.com" });
    runFind.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        ok: true,
        sample: false,
        emptyReason: null,
        message: null,
        headline: null,
        nextStep: null,
        scope: "test",
        affordabilityAssessed: true,
        partialFailure: false,
        geoScope: { kind: "nationwide" },
        directions: [
          {
            direction: {
              id: "d1",
              segment: "Suggested models",
              models: [{ make: "Honda", model: "CR-V" }],
              search: { make: "Honda", model: "CR-V" },
              yearMin: 2016,
              yearMax: 2022,
            },
            listings: [
              {
                vin: "1M8GDM9AXKP042788",
                year: 2018,
                make: "Honda",
                model: "CR-V",
                miles: 40000,
                priceUsd: 18000,
                vdp: "https://dealer.example/vdp/1",
                source: "live",
                badge: { label: "Fair", tone: "fair" },
                flipNote: null,
                clearsTarget: null,
                priceView: { usableForBudget: true, displayPrimary: "$18,000" },
              },
            ],
            coverage: "ok",
            coverageLevel: "medium",
            note: null,
            plannedModels: [{ make: "Honda", model: "CR-V" }],
            searchedModels: [{ make: "Honda", model: "CR-V" }],
            failedModels: [],
            skippedModels: [],
            providerWarning: null,
            queryOutcomes: [],
          },
        ],
        providerQueriesUsed: 1,
      },
    });

    const first = await POST(req({ need: NEED, searchIdempotencyKey: "find-auth-0001" }));
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      charged?: boolean;
      balance?: number;
      searchContextToken?: string;
    };
    expect(firstBody.charged).toBe(true);
    expect(firstBody.balance).toBe(2);
    expect(typeof firstBody.searchContextToken).toBe("string");
    expect(await creditBalance(kvHolder.kv, ACCOUNT)).toBe(2);
    // Anonymous ledger untouched. Monthly free VIN checks are not the Find payment.
    expect(await creditBalance(kvHolder.kv, ANON)).toBe(9);
    expect((await readFreeCheckQuota(kvHolder.kv, ACCOUNT)).used).toBe(0);

    const token = firstBody.searchContextToken!;
    // Ensure ownership is on verified account (route also mints; seed for clarity).
    const seeded = mintFindSearchContextRecord({
      userId: ACCOUNT,
      need: NEED as never,
      listings: [],
      servNextCheckEnabled: true,
      token,
    });
    seeded.servPaidCalls = 4;
    await storeFindSearchContext(kvHolder.kv, seeded);

    const rematch = await POST(
      req({
        need: { ...NEED, yearMin: 2017 },
        searchContextToken: token,
        searchIdempotencyKey: "find-auth-rematch-0002",
      }),
    );
    expect(rematch.status).toBe(200);
    const rematchBody = (await rematch.json()) as {
      charged?: boolean;
      rematchContinuation?: boolean;
      balance?: number;
      searchContextToken?: string;
    };
    expect(rematchBody.rematchContinuation).toBe(true);
    expect(rematchBody.charged).toBe(false);
    expect(rematchBody.searchContextToken).toBe(token);
    const kept = await loadFindSearchContext(kvHolder.kv, { userId: ACCOUNT, token });
    expect(kept.ok).toBe(true);
    if (kept.ok) expect(kept.record.servPaidCalls).toBe(4);
    expect(await creditBalance(kvHolder.kv, ACCOUNT)).toBe(2);
  });

  it("refuses a new Find at balance 0 before searching", async () => {
    requireFind.mockResolvedValue({ ok: true, id: ACCOUNT, email: "a@example.com" });
    kvHolder.kv = new MemoryKv();
    await creditGrant(kvHolder.kv, ACCOUNT, 0, "init-zero");
    const res = await POST(req({ need: NEED, searchIdempotencyKey: "find-zero-balance1" }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; balance?: number };
    expect(body.error).toBe("credits_required");
    expect(body.balance).toBe(0);
    expect(runFind).not.toHaveBeenCalled();
    expect(await creditBalance(kvHolder.kv, ACCOUNT)).toBe(0);
  });

  it("does not debit when the search fails, and a later success debits once", async () => {
    requireFind.mockResolvedValue({ ok: true, id: ACCOUNT, email: "a@example.com" });
    runFind.mockResolvedValueOnce({
      ok: false,
      status: 502,
      body: { error: "provider_failure", message: "upstream down" },
    });
    const failed = await POST(req({ need: NEED, searchIdempotencyKey: "find-fail-then-ok1" }));
    expect(failed.status).toBe(502);
    const failedBody = (await failed.json()) as { charged?: boolean; balance?: number };
    expect(failedBody.charged).toBe(false);
    expect(failedBody.balance).toBe(3);
    expect(await creditBalance(kvHolder.kv, ACCOUNT)).toBe(3);

    runFind.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: deliveredMatchBody(),
    });
    const ok = await POST(req({ need: NEED, searchIdempotencyKey: "find-fail-then-ok1" }));
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { charged?: boolean; balance?: number };
    expect(okBody.charged).toBe(true);
    expect(okBody.balance).toBe(2);
    expect(await creditBalance(kvHolder.kv, ACCOUNT)).toBe(2);
  });

  it("returns the stored delivery for the same key and does not search or debit again", async () => {
    requireFind.mockResolvedValue({ ok: true, id: ACCOUNT, email: "a@example.com" });
    const delivered = {
      ok: true,
      status: 200,
      body: deliveredMatchBody(),
    };
    runFind.mockResolvedValue(delivered);
    const first = await POST(req({ need: NEED, searchIdempotencyKey: "find-once-key-01" }));
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { searchContextToken?: string };
    expect(await creditBalance(kvHolder.kv, ACCOUNT)).toBe(2);
    expect(runFind).toHaveBeenCalledTimes(1);

    // A later failure must not run, and must not refund the original delivery.
    runFind.mockRejectedValueOnce(new Error("retry must not run"));
    const replay = await POST(req({ need: { ...NEED, note: "different search" }, searchIdempotencyKey: "find-once-key-01" }));
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as {
      charged?: boolean;
      balance?: number;
      searchContextToken?: string;
    };
    expect(replayBody.charged).toBe(true);
    expect(replayBody.balance).toBe(2);
    expect(replayBody.searchContextToken).toBe(firstBody.searchContextToken);
    expect(runFind).toHaveBeenCalledTimes(1);
    expect(await creditBalance(kvHolder.kv, ACCOUNT)).toBe(2);
  });

  it("collapses concurrent retries of one key into a single search and a single debit", async () => {
    requireFind.mockResolvedValue({ ok: true, id: ACCOUNT, email: "a@example.com" });
    runFind.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { ok: true, status: 200, body: deliveredMatchBody() };
    });
    const [a, b] = await Promise.all([
      POST(req({ need: NEED, searchIdempotencyKey: "find-race-key-01" })),
      POST(req({ need: NEED, searchIdempotencyKey: "find-race-key-01" })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const aBody = (await a.json()) as { searchContextToken?: string; balance?: number };
    const bBody = (await b.json()) as { searchContextToken?: string; balance?: number };
    expect(aBody.searchContextToken).toBeTruthy();
    expect(aBody.searchContextToken).toBe(bBody.searchContextToken);
    expect(aBody.balance).toBe(2);
    expect(bBody.balance).toBe(2);
    expect(runFind).toHaveBeenCalledTimes(1);
    expect(await creditBalance(kvHolder.kv, ACCOUNT)).toBe(2);
  });

  it("scopes the idempotency key per account so two shoppers each pay once", async () => {
    const other = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    await creditGrant(kvHolder.kv, other, 3, "init-other");
    requireFind.mockImplementation(async () => ({ ok: true, id: ACCOUNT, email: "a@example.com" }));
    runFind.mockResolvedValue({ ok: true, status: 200, body: deliveredMatchBody() });
    const first = await POST(req({ need: NEED, searchIdempotencyKey: "shared-client-key" }));
    expect(first.status).toBe(200);
    requireFind.mockImplementation(async () => ({ ok: true, id: other, email: "b@example.com" }));
    const second = await POST(req({ need: NEED, searchIdempotencyKey: "shared-client-key" }));
    expect(second.status).toBe(200);
    expect(await creditBalance(kvHolder.kv, ACCOUNT)).toBe(2);
    expect(await creditBalance(kvHolder.kv, other)).toBe(2);
    expect(runFind).toHaveBeenCalledTimes(2);
  });

  it("REPORT_356a: does not charge when no_directions / zero cars / no provider query", async () => {
    requireFind.mockResolvedValue({ ok: true, id: ACCOUNT, email: "a@example.com" });
    runFind.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        ok: true,
        emptyReason: "no_directions",
        message: "No model direction for this note yet.",
        headline: "No search directions yet",
        nextStep: "Try again.",
        directions: [],
        compsPool: [],
        providerQueriesUsed: 0,
      },
    });
    const res = await POST(req({ need: NEED, searchIdempotencyKey: "find-no-dirs-yura01" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      charged?: boolean;
      balance?: number;
      emptyReason?: string;
      message?: string;
    };
    expect(body.charged).toBe(false);
    expect(body.balance).toBe(3);
    expect(body.emptyReason).toBe("no_directions");
    expect(body.message).toMatch(/no credit was used/i);
    expect(await creditBalance(kvHolder.kv, ACCOUNT)).toBe(3);
  });

  it("does not debit when the search throws", async () => {
    requireFind.mockResolvedValue({ ok: true, id: ACCOUNT, email: "a@example.com" });
    runFind.mockRejectedValueOnce(new Error("boom"));
    const res = await POST(req({ need: NEED, searchIdempotencyKey: "find-throw-key01" }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { charged?: boolean; balance?: number; message?: string };
    expect(body.charged).toBe(false);
    expect(body.balance).toBe(3);
    expect(body.message).toMatch(/No credit was used/);
    expect(await creditBalance(kvHolder.kv, ACCOUNT)).toBe(3);
  });
});
