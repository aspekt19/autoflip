/**
 * Billable Find requires verified Auth.js account (t334 residual Fix A).
 * No Autodev/SERV network — mocks only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKv } from "@/io/kv";
import { creditBalance, creditGrant } from "@/io/credit-book";
import {
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
    // Anonymous ledger untouched.
    expect(await creditBalance(kvHolder.kv, ANON)).toBe(9);

    const token = firstBody.searchContextToken!;
    // Ensure ownership is on verified account (route also mints; seed for clarity).
    const seeded = mintFindSearchContextRecord({
      userId: ACCOUNT,
      need: NEED as never,
      listings: [],
      servNextCheckEnabled: false,
      token,
    });
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
    };
    expect(rematchBody.rematchContinuation).toBe(true);
    expect(rematchBody.charged).toBe(false);
    expect(await creditBalance(kvHolder.kv, ACCOUNT)).toBe(2);
  });
});
