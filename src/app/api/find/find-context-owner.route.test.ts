/**
 * Signed-in Find stores the search context under the Auth.js account id.
 * Next-check used to load it with the anonymous af_uid cookie, so a fresh
 * token came back as "Search context expired or unknown" and the check loop
 * never started. Anonymous (no session) still pairs store and load on the cookie.
 * No live SERV / NHTSA / Auto.dev calls.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKv } from "@/io/kv";
import { creditBalance, creditGrant } from "@/io/credit-book";
import { mintFindSearchContextRecord, storeFindSearchContext } from "@/server/find-search-context";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const ANON = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

const session = vi.hoisted(() => ({
  account: null as string | null,
  cookie: "22222222-2222-4222-8222-222222222222",
}));

const kvHolder: { kv: MemoryKv } = { kv: new MemoryKv() };
const runFind = vi.fn();

vi.mock("@/server/session", () => ({
  userId: async () => session.cookie,
  authenticatedAccountId: async () => session.account,
  requireVerifiedAccountForFind: async () => {
    if (!session.account) {
      return {
        ok: false as const,
        response: Response.json({ error: "auth_required" }, { status: 401 }),
      };
    }
    return { ok: true as const, id: session.account, email: "buyer@example.com" };
  },
}));

vi.mock("@/server/find-match", () => ({
  runFindMatch: (body: unknown, deps: unknown) => runFind(body, deps),
}));

vi.mock("@/server/deps", () => ({
  runtimeDeps: () => ({ autodevKey: null, servKey: null, servModel: undefined, servBaseUrl: undefined }),
}));

vi.mock("@/io/kv", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/io/kv")>();
  return { ...actual, getKv: () => kvHolder.kv };
});

vi.mock("@/server/find-analysis-context", () => ({
  rememberFindAnalysisContexts: async () => new Map(),
}));

vi.mock("@/domain/find-free-gov", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/domain/find-free-gov")>();
  return {
    ...actual,
    executeFindFreeGovCheck: async () => ({
      checkId: "free_gov_recalls",
      toolId: "evidence.gov_recalls",
      receipts: [],
      evidenceChanged: false,
      note: "offline stub — no live government call",
    }),
  };
});

import { POST as matchPost } from "@/app/api/match/route";
import { POST as nextPost } from "@/app/api/find/next-check/route";

const NEED = {
  mode: "personal",
  useCase: "family",
  note: "I need a decent family car for around $15,000. Mostly city driving.",
  budgetUsd: 15_000,
  budgetKnown: true,
  budgetScope: "car",
  mustHaves: [],
  priorities: [],
  zip: "68114",
  distanceMiles: 50,
  repairAbility: "unknown",
  targetProfitUsd: null,
  milesMax: null,
  yearMin: null,
  yearMax: null,
  yearBandResolved: true,
  milesCapResolved: true,
  conditionPriority: "inspection_first",
  make: null,
  preferredMakes: ["Honda", "Hyundai", "Kia"],
  preferredModels: [
    { make: "Honda", model: "CR-V" },
    { make: "Hyundai", model: "Tucson" },
    { make: "Kia", model: "Sportage" },
  ],
  preferredModelsSource: "note",
  openToOtherMakes: true,
};

function matchReq(body: unknown) {
  return new Request("https://lemonless.test/api/match", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function nextReq(token: string) {
  return new Request("https://lemonless.test/api/find/next-check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ searchContextToken: token }),
  });
}

function deliveredMatch() {
  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      sample: false,
      providerQueriesUsed: 1,
      directions: [
        {
          direction: { id: "d1", segment: "Family SUVs", models: [], search: {}, yearMin: 2012, yearMax: 2019 },
          listings: [
            {
              vin: "2HKRM4H75GH123456",
              year: 2016,
              make: "Honda",
              model: "CR-V",
              trim: "LX",
              miles: 80000,
              priceUsd: 14900,
              vdp: "https://dealer.example/crv",
              source: "live",
              priceView: { usableForBudget: true, displayPrimary: "$14,900" },
            },
            {
              vin: "5XXGT4L30GG123456",
              year: 2016,
              make: "Kia",
              model: "Sportage",
              trim: "LX",
              miles: 72000,
              priceUsd: 13900,
              source: "live",
              priceView: { usableForBudget: true, displayPrimary: "$13,900" },
            },
          ],
        },
      ],
      compsPool: [],
    },
  };
}

describe("Find search context owner (signed-in vs anonymous cookie)", { timeout: 20_000 }, () => {
  beforeEach(async () => {
    kvHolder.kv = new MemoryKv();
    session.account = null;
    session.cookie = ANON;
    runFind.mockReset();
    runFind.mockResolvedValue(deliveredMatch());
    await creditGrant(kvHolder.kv, ACCOUNT, 3, "init-acct");
    await creditGrant(kvHolder.kv, ANON, 3, "init-anon");
  });

  it("signed-in next-check loads the account context even when af_uid is a different id", async () => {
    session.account = ACCOUNT;
    session.cookie = ANON;
    const created = await matchPost(matchReq({ need: NEED, searchIdempotencyKey: "find-owner-signed-1" }));
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as { searchContextToken?: string; charged?: boolean; balance?: number };
    expect(createdBody.charged).toBe(true);
    expect(createdBody.balance).toBe(2);
    expect(await creditBalance(kvHolder.kv, ACCOUNT)).toBe(2);
    expect(await creditBalance(kvHolder.kv, ANON)).toBe(3);
    const token = createdBody.searchContextToken;
    expect(typeof token).toBe("string");

    const step = await nextPost(nextReq(token!));
    const body = (await step.json()) as {
      ok?: boolean;
      message?: string;
      error?: string;
      decisionLog?: unknown[];
      bestDeal?: { ranked?: unknown[]; pick?: unknown };
      baseline?: unknown;
    };
    expect(body.message).not.toBe("Search context expired or unknown — run Find again.");
    expect(step.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.error).not.toBe("search_context_invalid");
    expect(Array.isArray(body.decisionLog)).toBe(true);
    expect((body.decisionLog ?? []).length).toBeGreaterThan(0);
    expect(body.bestDeal).toBeTruthy();
    expect(body.baseline).toBeTruthy();
    // Next-check is not a second Find purchase.
    expect(await creditBalance(kvHolder.kv, ACCOUNT)).toBe(2);
  });

  it("signed-in next-check does not treat the anonymous cookie as the context owner", async () => {
    session.account = ACCOUNT;
    session.cookie = ANON;
    const record = mintFindSearchContextRecord({
      userId: ANON,
      need: NEED as never,
      listings: [],
      servNextCheckEnabled: false,
      token: "cookie-only-token",
    });
    await storeFindSearchContext(kvHolder.kv, record);
    const step = await nextPost(nextReq("cookie-only-token"));
    expect(step.status).toBe(404);
    const body = (await step.json()) as { message?: string };
    expect(body.message).toBe("Search context expired or unknown — run Find again.");
  });

  it("anonymous next-check loads a context stored under the cookie id", async () => {
    session.account = null;
    session.cookie = ANON;
    const record = mintFindSearchContextRecord({
      userId: ANON,
      need: NEED as never,
      listings: [
        {
          make: "Honda",
          model: "CR-V",
          year: 2016,
          priceUsd: 14900,
          miles: 80000,
          vin: "2HKRM4H75GH123456",
          trim: "LX",
        },
      ],
      servNextCheckEnabled: false,
      token: "anon-token",
    });
    await storeFindSearchContext(kvHolder.kv, record);
    const step = await nextPost(nextReq("anon-token"));
    const body = (await step.json()) as { ok?: boolean; message?: string; decisionLog?: unknown[] };
    expect(body.message).not.toBe("Search context expired or unknown — run Find again.");
    expect(step.status).toBe(200);
    expect(body.ok).toBe(true);
    expect((body.decisionLog ?? []).length).toBeGreaterThan(0);
    expect(await creditBalance(kvHolder.kv, ANON)).toBe(3);
  });

  it("does not let another signed-in account read or advance a context by token alone", async () => {
    session.account = ACCOUNT;
    session.cookie = ANON;
    const created = await matchPost(matchReq({ need: NEED, searchIdempotencyKey: "find-owner-signed-2" }));
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as { searchContextToken?: string };
    const token = createdBody.searchContextToken;
    expect(typeof token).toBe("string");

    session.account = OTHER;
    session.cookie = ACCOUNT;
    const step = await nextPost(nextReq(token!));
    expect(step.status).toBe(404);
    const body = (await step.json()) as { message?: string };
    expect(body.message).toBe("Search context expired or unknown — run Find again.");
    expect(await creditBalance(kvHolder.kv, ACCOUNT)).toBe(2);
    expect(await creditBalance(kvHolder.kv, OTHER)).toBe(0);
  });
});
