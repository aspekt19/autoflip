/**
 * Check-surface free monthly allotment + auth gates (t334).
 * No Autodev/SERV/Stripe network — mocks only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKv } from "@/io/kv";
import { creditGrant } from "@/io/credit-book";

const ACCOUNT = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const VIN = "1M8GDM9AXKP042788";

const kvHolder: { kv: MemoryKv } = { kv: new MemoryKv() };
const assemble = vi.fn();
const persist = vi.fn();
const rememberReport = vi.fn();
const findReport = vi.fn(async () => null);
const readReport = vi.fn();
const telegram = vi.fn();
const requireChecks = vi.fn();

vi.mock("@/server/session", async () => {
  const creditBook = await import("@/io/credit-book");
  return {
    ledgerOwnerId: async () => ACCOUNT,
    userId: async () => ACCOUNT,
    balanceOf: async () => creditBook.creditBalance(kvHolder.kv, ACCOUNT),
    spendCredit: (id: string, key: string) => creditBook.creditSpend(kvHolder.kv, id, key),
    compensateSpendCredit: (id: string, key: string) =>
      creditBook.creditCompensateSpend(kvHolder.kv, id, key),
    grantCredit: (id: string, n: number, key: string) => creditBook.creditGrant(kvHolder.kv, id, n, key),
    requireVerifiedAccountForChecks: () => requireChecks(),
  };
});

vi.mock("@/server/assemble", () => ({
  assembleReport: (input: unknown, deps: unknown) => assemble(input, deps),
}));

vi.mock("@/server/deps", () => ({
  runtimeDeps: () => ({ autodevKey: null, servKey: null }),
}));

vi.mock("@/io/persist-report", () => ({
  findUserReport: () => findReport(),
  readPersistedReport: (id: string) => readReport(id),
  rememberUserReport: (...args: unknown[]) => rememberReport(...args),
  persistReport: (report: unknown) => persist(report),
  reportReusable: () => false,
}));

vi.mock("@/io/kv", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/io/kv")>();
  return { ...actual, getKv: () => kvHolder.kv };
});

vi.mock("@/server/telegram-notify", () => ({
  sendLinkedTelegram: (...args: unknown[]) => telegram(...args),
}));

vi.mock("@/server/secrets", () => ({
  originOf: () => "https://lemonless.test",
}));

import { POST } from "./route";
import { readFreeCheckQuota } from "@/io/free-check-quota";

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
          year: 2018,
          make: "Honda",
          model: "Civic",
          trim: null,
          priceUsd: 12_000,
          miles: 40_000,
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

describe("free check quota on /api/report (check surface)", () => {
  beforeEach(async () => {
    kvHolder.kv = new MemoryKv();
    await creditGrant(kvHolder.kv, ACCOUNT, 0, "init");
    requireChecks.mockReset();
    requireChecks.mockResolvedValue({ ok: true, id: ACCOUNT, email: "a@example.com" });
    assemble.mockReset();
    persist.mockReset();
    persist.mockResolvedValue(undefined);
    rememberReport.mockReset();
    findReport.mockReset();
    findReport.mockResolvedValue(null);
    readReport.mockReset();
    telegram.mockReset();
    vi.clearAllMocks();
  });

  it("fails closed when auth is missing (no anonymous free checks)", async () => {
    requireChecks.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "auth_required" }, { status: 401 }),
    });
    const res = await POST(
      req({
        surface: "check",
        mode: "personal",
        vin: VIN,
        askingPriceUsd: 12000,
        miles: 40000,
        zip: "33101",
      }),
    );
    expect(res.status).toBe(401);
    expect(assemble).not.toHaveBeenCalled();
  });

  it("uses free monthly allotment without debiting credits", async () => {
    assemble.mockResolvedValue(okReport("r-free-1"));
    const res = await POST(
      req({
        surface: "check",
        mode: "personal",
        vin: VIN,
        askingPriceUsd: 12000,
        miles: 40000,
        zip: "33101",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { freeCheck?: boolean; charged?: boolean; balance?: number };
    expect(body.freeCheck).toBe(true);
    expect(body.charged).toBe(false);
    expect(body.balance).toBe(0);
    expect((await readFreeCheckQuota(kvHolder.kv, ACCOUNT)).used).toBe(1);
  });

  it("releases free reservation on assemble failure (no burn)", async () => {
    assemble.mockResolvedValue({ ok: false, error: "provider_error", message: "down", status: 502 });
    const res = await POST(
      req({
        surface: "check",
        mode: "personal",
        vin: VIN,
        askingPriceUsd: 12000,
        miles: 40000,
        zip: "33101",
      }),
    );
    expect(res.status).toBe(502);
    expect((await readFreeCheckQuota(kvHolder.kv, ACCOUNT)).used).toBe(0);
    // A later attempt can still use the free slot.
    assemble.mockResolvedValue(okReport("r-free-2"));
    const again = await POST(
      req({
        surface: "check",
        mode: "personal",
        vin: VIN,
        askingPriceUsd: 12000,
        miles: 40000,
        zip: "33101",
      }),
    );
    expect(again.status).toBe(200);
    expect((await readFreeCheckQuota(kvHolder.kv, ACCOUNT)).used).toBe(1);
  });

  it("requires credits after 3 free checks are exhausted", async () => {
    const vins = ["1M8GDM9A1KP042100", "1M8GDM9A3KP042101", "1M8GDM9A5KP042102"];
    for (let i = 0; i < vins.length; i += 1) {
      assemble.mockResolvedValue(okReport(`r-${i}`));
      const res = await POST(
        req({
          surface: "check",
          mode: "personal",
          vin: vins[i],
          askingPriceUsd: 12000,
          miles: 40000,
          zip: "33101",
        }),
      );
      expect(res.status).toBe(200);
    }
    expect((await readFreeCheckQuota(kvHolder.kv, ACCOUNT)).remaining).toBe(0);

    assemble.mockResolvedValue(okReport("r-paid"));
    const denied = await POST(
      req({
        surface: "check",
        mode: "personal",
        vin: "2T3N1RFV8MC246100",
        askingPriceUsd: 12000,
        miles: 40000,
        zip: "33101",
      }),
    );
    expect(denied.status).toBe(403);
    const body = (await denied.json()) as { error?: string };
    expect(body.error).toBe("credits_required");
  });
});
