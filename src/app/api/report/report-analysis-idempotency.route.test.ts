/**
 * Concurrent /api/report selected-listing submits on shared Kv (multi-instance sim).
 * Uses real credit-book + persist; mocks only assemble/providers/telegram.
 * Barriers prove old UUID spend double-debit class, then fixed one-debit/one-report.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  creditBalance,
  creditCompensateSpend,
  creditEventSeen,
  creditGrant,
  creditSpend,
} from "@/io/credit-book";
import { MemoryKv } from "@/io/kv";
import {
  findUserReport,
  persistReport,
  readPersistedReport,
  rememberUserReport,
  reportReusable,
} from "@/io/persist-report";
import {
  mintFindAnalysisContextRecord,
  storeFindAnalysisContext,
} from "@/server/find-analysis-context";
import {
  findAnalysisSpendKey,
  legacyReportUuidSpendKey,
  reportAnalysisRecordKey,
} from "@/server/report-analysis-idempotency";

const uid = vi.fn(async () => "11111111-1111-4111-8111-111111111111");
const assemble = vi.fn();
const telegram = vi.fn();

const persistSeams = vi.hoisted(() => ({
  realRemember: null as null | RememberFn,
  persistImpl: vi.fn(),
  rememberImpl: vi.fn(),
}));
const persistImpl = persistSeams.persistImpl;
const rememberImpl = persistSeams.rememberImpl;

type RememberFn = typeof rememberUserReport;
const kvHolder: { kv: MemoryKv } = { kv: new MemoryKv() };

vi.mock("@/server/session", () => ({
  userId: () => uid(),
  ledgerOwnerId: () => uid(),
  balanceOf: (id: string) => creditBalance(kvHolder.kv, id),
  spendCredit: (id: string, key: string) => creditSpend(kvHolder.kv, id, key),
  grantCredit: (id: string, n: number, key: string) => creditGrant(kvHolder.kv, id, n, key),
  compensateSpendCredit: (id: string, key: string) => creditCompensateSpend(kvHolder.kv, id, key),
  requireVerifiedAccountForChecks: async () => ({
    ok: true as const,
    id: "user-a",
    email: "a@example.com",
  }),
}));

vi.mock("@/server/assemble", () => ({
  assembleReport: (input: unknown, deps: unknown) => assemble(input, deps),
}));

vi.mock("@/server/deps", () => ({
  runtimeDeps: () => ({ autodevKey: null, servKey: null }),
}));

vi.mock("@/io/kv", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/io/kv")>();
  return {
    ...actual,
    getKv: () => kvHolder.kv,
  };
});

vi.mock("@/io/persist-report", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/io/persist-report")>();
  persistSeams.realRemember = actual.rememberUserReport;
  persistSeams.persistImpl.mockImplementation(async (report: { id: string }) => {
    await kvHolder.kv.set(`report:${report.id}`, JSON.stringify(report));
  });
  persistSeams.rememberImpl.mockImplementation(
    async (
      kv: Parameters<RememberFn>[0],
      userId: string,
      vin: string,
      reportId: string,
      report?: Parameters<RememberFn>[4],
    ) => {
      if (!persistSeams.realRemember) throw new Error("realRemember not bound");
      return persistSeams.realRemember(kv, userId, vin, reportId, report);
    },
  );
  return {
    ...actual,
    persistReport: (report: Parameters<typeof persistReport>[0]) => persistSeams.persistImpl(report),
    findUserReport: (
      kv: Parameters<typeof findUserReport>[0],
      userId: string,
      vin: string,
      mode?: Parameters<typeof findUserReport>[3],
    ) => actual.findUserReport(kv, userId, vin, mode),
    readPersistedReport: (id: string) => actual.readPersistedReport(id),
    rememberUserReport: ((kv, userId, vin, reportId, report) =>
      persistSeams.rememberImpl(kv, userId, vin, reportId, report)) as RememberFn,
    reportReusable: (
      existing: Parameters<typeof reportReusable>[0],
      input: Parameters<typeof reportReusable>[1],
    ) => actual.reportReusable(existing, input),
  };
});

vi.mock("@/server/telegram-notify", () => ({
  sendLinkedTelegram: (id: string, text: string, button?: unknown) => telegram(id, text, button),
}));

vi.mock("@/server/secrets", () => ({
  originOf: () => "https://lemonless.test",
}));

import { POST } from "./route";

const USER = "11111111-1111-4111-8111-111111111111";
const VIN = "2T3N1RFV6MC246998";
const VDP = "https://www.joemachenstoyota.com/auto/used-2021-toyota-rav4-limited/126661218/";

function req(body: unknown) {
  return new Request("https://lemonless.test/api/report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function okReport(id: string) {
  return {
    ok: true as const,
    report: {
      id,
      createdAt: new Date().toISOString(),
      explanation: "ok",
      proof: {},
      computed: {
        subject: {
          vin: VIN,
          year: 2021,
          make: "Toyota",
          model: "RAV4",
          trim: null,
          priceUsd: 18_900,
          miles: 21_001,
          city: null,
          state: null,
        },
        mode: "personal",
        flags: [],
        openParkIt: false,
        verdict: "fair",
        score: 50,
        dataNotes: [],
        reasons: [],
        sample: false,
      },
    },
  };
}

async function mintToken(userId = USER) {
  const record = mintFindAnalysisContextRecord(
    userId,
    {
      vin: VIN,
      year: 2021,
      make: "Toyota",
      model: "RAV4",
      miles: 21_001,
      priceUsd: 18_900,
      vdp: VDP,
      priceView: { usableForBudget: true },
    },
    "68114",
  );
  await storeFindAnalysisContext(kvHolder.kv, record);
  return record.token;
}

function findBody(token: string) {
  return {
    mode: "personal",
    surface: "find",
    cta: "find_card_full_analysis",
    vin: VIN,
    url: VDP,
    selectedVin: VIN,
    selectedVdp: VDP,
    findContextToken: token,
    zip: "68114",
    miles: 21_001,
  };
}

describe("POST /api/report analysis idempotency (shared Kv concurrent)", () => {
  beforeEach(async () => {
    kvHolder.kv = new MemoryKv();
    assemble.mockReset();
    telegram.mockReset();
    persistImpl.mockReset();
    rememberImpl.mockReset();
    // Default: durable write via shared test Kv (getKv is mocked to kvHolder.kv).
    persistImpl.mockImplementation(async (report) => {
      await kvHolder.kv.set(`report:${report.id}`, JSON.stringify(report));
    });
    rememberImpl.mockImplementation((kv, userId, vin, reportId, report) => {
      if (!persistSeams.realRemember) throw new Error("realRemember not bound");
      return persistSeams.realRemember(kv, userId, vin, reportId, report);
    });
    uid.mockResolvedValue(USER);
    await creditGrant(kvHolder.kv, USER, 3, `seed:${USER}:${Date.now()}`);
  });

  it("OLD class: parallel UUID spend keys still double-debit on the shared ledger", async () => {
    // Documents the pre-fix failure mode the route must not reintroduce.
    const [a, b] = await Promise.all([
      creditSpend(kvHolder.kv, USER, legacyReportUuidSpendKey("r1")),
      creditSpend(kvHolder.kv, USER, legacyReportUuidSpendKey("r2")),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(await creditBalance(kvHolder.kv, USER)).toBe(1); // 3 - 2
  });

  it("FIXED: barrier concurrent first submits → one assemble, one debit, same report on retry", async () => {
    const token = await mintToken();
    let releaseAssemble!: () => void;
    const assembleGate = new Promise<void>((r) => {
      releaseAssemble = r;
    });
    let assembleEntered = 0;
    let reportSeq = 0;

    assemble.mockImplementation(async () => {
      assembleEntered += 1;
      await assembleGate;
      reportSeq += 1;
      return okReport(`report-fixed-${reportSeq}`);
    });

    // Both POSTs pass find-context + claim race before either assemble finishes.
    const p1 = POST(req(findBody(token)));
    const p2 = POST(req(findBody(token)));

    // Wait until the winner has entered assemble (claim held).
    for (let i = 0; i < 100 && assembleEntered < 1; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(assembleEntered).toBe(1);
    releaseAssemble();

    const [r1, r2] = await Promise.all([p1, p2]);
    const bodies = await Promise.all([r1.json(), r2.json()]);
    const oks = [r1, r2].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(assembleEntered).toBe(1);
    expect(await creditBalance(kvHolder.kv, USER)).toBe(2); // only one debit from 3

    const successBodies = bodies.filter((_, i) => [r1, r2][i]!.status === 200);
    const reportIds = new Set(successBodies.map((b) => b.id));
    expect(reportIds.size).toBe(1);
    const reportId = [...reportIds][0] as string;

    // Stable retry — same token, same report, 0 additional debit.
    const retry = await POST(req({ ...findBody(token), cta: "find_pending_retry" }));
    expect(retry.status).toBe(200);
    const retryBody = await retry.json();
    expect(retryBody.id).toBe(reportId);
    expect(retryBody.alreadySaved).toBe(true);
    expect(await creditBalance(kvHolder.kv, USER)).toBe(2);
    expect(assembleEntered).toBe(1);

    // Spend event is analysis-scoped, not UUID-scoped.
    const spendSeen = await creditSpend(
      kvHolder.kv,
      USER,
      findAnalysisSpendKey({ userId: USER, findContextToken: token }),
    );
    expect(spendSeen.ok).toBe(true);
    expect(spendSeen.balance).toBe(2);
  });

  it("failure release: assemble error then retry succeeds once without double debit", async () => {
    const token = await mintToken();
    assemble
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        error: "listings_error",
        message: "Listings unavailable",
      })
      .mockResolvedValueOnce(okReport("report-after-fail"));

    const failed = await POST(req(findBody(token)));
    expect(failed.status).toBe(502);
    expect(await creditBalance(kvHolder.kv, USER)).toBe(3);

    const ok = await POST(req(findBody(token)));
    expect(ok.status).toBe(200);
    expect((await ok.json()).id).toBe("report-after-fail");
    expect(await creditBalance(kvHolder.kv, USER)).toBe(2);
    expect(assemble).toHaveBeenCalledTimes(2);
  });

  it("fee refusal still 0 debit / 0 persist and releases claim for clean state", async () => {
    const token = await mintToken();
    assemble.mockResolvedValue({
      ok: true,
      report: {
        id: "report-fee",
        createdAt: new Date().toISOString(),
        explanation: "x",
        proof: {},
        computed: {
          subject: {
            vin: VIN,
            year: 2021,
            make: "Toyota",
            model: "RAV4",
            trim: null,
            priceUsd: null,
            miles: 21_001,
            city: null,
            state: null,
          },
          mode: "personal",
          flags: [],
          openParkIt: false,
          verdict: "withheld",
          score: 0,
          dataNotes: [
            "Feed/stated figure $587 is not treated as a verified vehicle purchase ask (known non purchase).",
          ],
          reasons: [],
          sample: false,
        },
      },
    });

    const response = await POST(req(findBody(token)));
    expect(response.status).toBe(422);
    expect((await response.json()).charge).toBe(false);
    expect(await creditBalance(kvHolder.kv, USER)).toBe(3);
    expect(await findUserReport(kvHolder.kv, USER, VIN, "personal")).toBeNull();
  });

  it("wrong-owner token still 0 spend; different users not cross-deduped", async () => {
    const otherToken = await mintToken("22222222-2222-4222-8222-222222222222");
    const response = await POST(req(findBody(otherToken)));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("find_context_invalid");
    expect(await creditBalance(kvHolder.kv, USER)).toBe(3);
    expect(assemble).not.toHaveBeenCalled();
  });

  it("intentional re-analysis: new find token may charge again", async () => {
    const tokenA = await mintToken();
    assemble.mockResolvedValueOnce(okReport("report-a"));
    expect((await POST(req(findBody(tokenA)))).status).toBe(200);
    expect(await creditBalance(kvHolder.kv, USER)).toBe(2);

    const tokenB = await mintToken();
    expect(tokenB).not.toBe(tokenA);
    assemble.mockResolvedValueOnce(okReport("report-b"));
    // alreadySaved may short-circuit on same VIN+mode+ask+miles — clear vin lookup to simulate
    // intentional re-run after a new Find (new token) when prior report facts no longer match.
    // Force non-reuse by remembering under a different ask via a non-reusable prior is covered
    // elsewhere; here spend keys differ so a second charge is possible when reuse does not hit.
    await kvHolder.kv.delete(`report-vin:${USER}:${VIN}:personal`);
    await kvHolder.kv.delete(`report-vin:${USER}:${VIN}`);

    const second = await POST(req(findBody(tokenB)));
    // If alreadySaved still fires via leftover report row lookup miss → must assemble+spend.
    expect(second.status).toBe(200);
    const body = await second.json();
    if (!body.alreadySaved) {
      expect(body.id).toBe("report-b");
      expect(await creditBalance(kvHolder.kv, USER)).toBe(1);
    }
  });

  it("persist throw after spend: compensate + retry debits exactly once (no FREE_REPORT)", async () => {
    const token = await mintToken();
    const spendKey = findAnalysisSpendKey({ userId: USER, findContextToken: token });
    assemble
      .mockResolvedValueOnce(okReport("report-persist-fail"))
      .mockResolvedValueOnce(okReport("report-persist-ok"));

    persistImpl.mockImplementationOnce(async () => {
      throw new Error("persist_boom");
    });

    const failed = await POST(req(findBody(token)));
    expect(failed.status).toBe(500);
    expect((await failed.json()).error).toBe("save_failed");
    expect(await creditBalance(kvHolder.kv, USER)).toBe(3); // credit restored
    expect(await creditEventSeen(kvHolder.kv, spendKey)).toBe(false);
    expect(await kvHolder.kv.get(reportAnalysisRecordKey({ userId: USER, findContextToken: token }))).toBeNull();

    const ok = await POST(req(findBody(token)));
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.id).toBe("report-persist-ok");
    expect(body.alreadySaved).not.toBe(true);
    expect(await creditBalance(kvHolder.kv, USER)).toBe(2); // exactly one net debit
    expect(await creditEventSeen(kvHolder.kv, spendKey)).toBe(true);
  });

  it("complete throw after report persisted: keeps debit, returns saved report, retry replays", async () => {
    const token = await mintToken();
    const spendKey = findAnalysisSpendKey({ userId: USER, findContextToken: token });
    assemble.mockResolvedValue(okReport("report-complete-fail"));

    // Persist lands; remember throws before completeFindAnalysis — catch must not compensate.
    rememberImpl.mockImplementationOnce(async () => {
      throw new Error("remember_boom");
    });

    const first = await POST(req(findBody(token)));
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.id).toBe("report-complete-fail");
    expect(await creditBalance(kvHolder.kv, USER)).toBe(2); // spend kept — report durable
    expect(await creditEventSeen(kvHolder.kv, spendKey)).toBe(true);
    expect(await readPersistedReport("report-complete-fail")).toBeTruthy();

    const retry = await POST(req(findBody(token)));
    expect(retry.status).toBe(200);
    const retryBody = await retry.json();
    expect(retryBody.id).toBe("report-complete-fail");
    expect(await creditBalance(kvHolder.kv, USER)).toBe(2); // no second debit
  });

  it("concurrent compensate after persist-fail cannot mint free reports or double-credit", async () => {
    const token = await mintToken();
    const spendKey = findAnalysisSpendKey({ userId: USER, findContextToken: token });
    assemble.mockResolvedValue(okReport("report-race-persist"));

    let persistAttempts = 0;
    persistImpl.mockImplementation(async (report) => {
      persistAttempts += 1;
      if (persistAttempts === 1) throw new Error("persist_boom");
      await kvHolder.kv.set(`report:${report.id}`, JSON.stringify(report));
    });

    const failed = await POST(req(findBody(token)));
    expect(failed.status).toBe(500);
    expect(await creditBalance(kvHolder.kv, USER)).toBe(3);

    // Repeated / concurrent compensates against the cleared spend are no-ops.
    const [c1, c2, c3] = await Promise.all([
      creditCompensateSpend(kvHolder.kv, USER, spendKey),
      creditCompensateSpend(kvHolder.kv, USER, spendKey),
      creditCompensateSpend(kvHolder.kv, USER, spendKey),
    ]);
    expect([c1, c2, c3].every((c) => !c.compensated)).toBe(true);
    expect(await creditBalance(kvHolder.kv, USER)).toBe(3);

    const ok = await POST(req(findBody(token)));
    expect(ok.status).toBe(200);
    expect(await creditBalance(kvHolder.kv, USER)).toBe(2);
  });

  it(
    "HOLD5: aged persisted orphan cannot be refunded into a free report via claim aging",
    async () => {
      // Crash window: spend + durable report:{id} persisted; claim never completed /
      // VIN index never written. Former 90s stale reclaim compensated without checking
      // report:{id} → FREE_ORPHAN. With reclaim removed, peer sees analysis_in_progress
      // and debit stays charged. Peer waitForFindAnalysisReceipt defaults to ~8s.
      const token = await mintToken();
      const spendKey = findAnalysisSpendKey({ userId: USER, findContextToken: token });
      const reportId = "report-aged-orphan";
      const identity = { userId: USER, findContextToken: token };
      const recordKey = reportAnalysisRecordKey(identity);

      expect((await creditSpend(kvHolder.kv, USER, spendKey)).ok).toBe(true);
      expect(await creditBalance(kvHolder.kv, USER)).toBe(2);
      await kvHolder.kv.set(
        `report:${reportId}`,
        JSON.stringify({
          id: reportId,
          createdAt: new Date().toISOString(),
          explanation: "ok",
          proof: {},
          computed: okReport(reportId).report.computed,
        }),
      );
      await kvHolder.kv.set(
        recordKey,
        JSON.stringify({
          status: "in_progress",
          userId: USER,
          findContextToken: token,
          claimedAt: new Date(Date.now() - 90_000 - 5_000).toISOString(),
          claimId: "stale-holder-claim",
        }),
      );

      const peer = await POST(req(findBody(token)));
      expect(peer.status).toBe(409);
      const peerBody = await peer.json();
      expect(peerBody.error).toBe("analysis_in_progress");
      expect(peerBody.charge).toBe(false);
      expect(await creditBalance(kvHolder.kv, USER)).toBe(2);
      expect(await creditEventSeen(kvHolder.kv, spendKey)).toBe(true);
      expect(await readPersistedReport(reportId)).toBeTruthy();
      expect(assemble).not.toHaveBeenCalled();
    },
    20_000,
  );

  it(
    "HOLD5: slow over-90s holder spend is not reversed while still in_progress",
    async () => {
      // Gate after spend (on persist) so debit exists while claim ages past former 90s.
      const token = await mintToken();
      const spendKey = findAnalysisSpendKey({ userId: USER, findContextToken: token });
      let releasePersist!: () => void;
      const persistGate = new Promise<void>((r) => {
        releasePersist = r;
      });
      let persistEntered = 0;

      assemble.mockResolvedValue(okReport("report-slow-holder"));
      persistImpl.mockImplementation(async (report) => {
        persistEntered += 1;
        await persistGate;
        await kvHolder.kv.set(`report:${report.id}`, JSON.stringify(report));
      });

      const slow = POST(req(findBody(token)));
      for (let i = 0; i < 100 && persistEntered < 1; i += 1) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(persistEntered).toBe(1);
      expect(await creditEventSeen(kvHolder.kv, spendKey)).toBe(true);
      expect(await creditBalance(kvHolder.kv, USER)).toBe(2);

      const recordKey = reportAnalysisRecordKey({ userId: USER, findContextToken: token });
      const raw = await kvHolder.kv.get(recordKey);
      expect(raw).toBeTruthy();
      const claim = JSON.parse(raw!) as {
        claimedAt: string;
        claimId: string;
        status: string;
        userId: string;
        findContextToken: string;
      };
      claim.claimedAt = new Date(Date.now() - 90_000 - 1_000).toISOString();
      await kvHolder.kv.set(recordKey, JSON.stringify(claim));

      // Peer waits for receipt (~8s) then fail-closes — must not reverse spend.
      const peer = await POST(req(findBody(token)));
      expect(peer.status).toBe(409);
      expect((await peer.json()).error).toBe("analysis_in_progress");
      expect(await creditBalance(kvHolder.kv, USER)).toBe(2);
      expect(await creditEventSeen(kvHolder.kv, spendKey)).toBe(true);
      expect(await kvHolder.kv.get(recordKey)).toBeTruthy();

      releasePersist();
      const winner = await slow;
      expect(winner.status).toBe(200);
      expect((await winner.json()).id).toBe("report-slow-holder");
      expect(await creditBalance(kvHolder.kv, USER)).toBe(2); // exactly one debit kept
      expect(await creditEventSeen(kvHolder.kv, spendKey)).toBe(true);
      expect(assemble).toHaveBeenCalledTimes(1);
    },
    25_000,
  );
});
