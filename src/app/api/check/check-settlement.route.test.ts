/**
 * Credits / free checks settle only on a delivered Check result.
 * Failed, blocked, and paywalled checks must not consume.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKv } from "@/io/kv";
import { creditBalance, creditGrant } from "@/io/credit-book";
import { readFreeCheckQuota } from "@/io/free-check-quota";

const ACCOUNT = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const VIN = "4T1KZ1AK4MU060006";

const kvHolder: { kv: MemoryKv } = { kv: new MemoryKv() };
const requireChecks = vi.fn();
const runCheckMock = vi.fn();

vi.mock("@/server/session", async () => {
  const creditBook = await import("@/io/credit-book");
  return {
    balanceOf: async () => creditBook.creditBalance(kvHolder.kv, ACCOUNT),
    spendCredit: (id: string, key: string) => creditBook.creditSpend(kvHolder.kv, id, key),
    requireVerifiedAccountForChecks: () => requireChecks(),
  };
});

vi.mock("@/io/kv", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/io/kv")>();
  return { ...actual, getKv: () => kvHolder.kv };
});

vi.mock("@/server/deps", () => ({
  runtimeDeps: () => ({
    servKey: undefined,
    servModel: undefined,
    servBaseUrl: undefined,
    autodevKey: undefined,
    autodev: undefined,
  }),
}));

vi.mock("@/server/check/run-check", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/check/run-check")>();
  return {
    ...actual,
    runCheck: (...args: unknown[]) => runCheckMock(...args),
  };
});

import { POST } from "./route";

function req(body: unknown) {
  return new Request("https://lemonless.test/api/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/check settlement", () => {
  beforeEach(async () => {
    kvHolder.kv = new MemoryKv();
    requireChecks.mockReset();
    requireChecks.mockResolvedValue({ ok: true, id: ACCOUNT, email: "a@example.com" });
    runCheckMock.mockReset();
  });

  it("refuses up front when free checks and credits are exhausted (no runCheck)", async () => {
    await creditGrant(kvHolder.kv, ACCOUNT, 0, "init-zero");
    expect(await creditBalance(kvHolder.kv, ACCOUNT)).toBe(0);

    const { reserveFreeCheck, commitFreeCheck } = await import("@/io/free-check-quota");
    for (let i = 0; i < 3; i += 1) {
      const key = `seed-${i}`;
      expect((await reserveFreeCheck(kvHolder.kv, ACCOUNT, key)).ok).toBe(true);
      await commitFreeCheck(kvHolder.kv, ACCOUNT, key);
    }
    expect((await readFreeCheckQuota(kvHolder.kv, ACCOUNT)).remaining).toBe(0);

    const response = await POST(req({ kind: "vin", vin: VIN }));
    const body = await response.json();
    expect(response.status).toBe(403);
    expect(body.error).toBe("credits_required");
    expect(body.message).toMatch(/You've used your 3 free checks/i);
    expect(runCheckMock).not.toHaveBeenCalled();
    expect(await creditBalance(kvHolder.kv, ACCOUNT)).toBe(0);
    expect((await readFreeCheckQuota(kvHolder.kv, ACCOUNT)).used).toBe(3);
  });

  it("does not consume free checks or credits when the check is blocked", async () => {
    await creditGrant(kvHolder.kv, ACCOUNT, 1, "init-credit");
    runCheckMock.mockResolvedValue({
      ok: false,
      status: 422,
      error: "listing_fetch_blocked",
      message: "The site blocked this request. Keep the URL, then paste or enter the VIN.",
      blocked: true,
      alternatives: ["paste_text", "enter_vin"],
    });

    const beforeCredits = await creditBalance(kvHolder.kv, ACCOUNT);
    const beforeFree = await readFreeCheckQuota(kvHolder.kv, ACCOUNT);

    const response = await POST(req({ kind: "link", url: "https://blocked.example/camry" }));
    const body = await response.json();
    expect(response.status).toBe(422);
    expect(body.error).toBe("listing_fetch_blocked");
    expect(body.blocked).toBe(true);
    expect(runCheckMock).toHaveBeenCalledOnce();
    expect(await creditBalance(kvHolder.kv, ACCOUNT)).toBe(beforeCredits);
    expect((await readFreeCheckQuota(kvHolder.kv, ACCOUNT)).used).toBe(beforeFree.used);
    expect((await readFreeCheckQuota(kvHolder.kv, ACCOUNT)).remaining).toBe(beforeFree.remaining);
  });

  it("commits a free check only after a delivered success", async () => {
    await creditGrant(kvHolder.kv, ACCOUNT, 1, "init-credit");
    runCheckMock.mockResolvedValue({
      ok: true,
      result: {
        kind: "vin_dossier",
        title: "2021 Toyota Camry",
        verdict: "dossier",
        verdictLabel: "VIN dossier",
        confidence: "Medium",
        summary: "ok",
        badge: null,
        fairValueUsd: null,
        priceGap: null,
        compCount: 0,
        compScope: "",
        redFlags: [],
        questions: [],
        otd: null,
        otdNeedsZip: false,
        walkAwayUsd: null,
        walkAwayLabel: null,
        similarCars: [],
        fields: null,
        provenance: [],
        vin: VIN,
        vinDecode: null,
        recalls: [],
        recallsAvailable: false,
        complaintCount: null,
        fuel: null,
        fuelConflict: null,
        safetySummary: null,
        knownIssues: [],
        unknown: [],
        listingsForVin: [],
        llmUsed: false,
        sample: false,
        agentVerdict: null,
      },
    });

    const response = await POST(req({ kind: "vin", vin: VIN }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.usedFreeCheck).toBe(true);
    expect(body.spentCredit).toBe(false);
    expect((await readFreeCheckQuota(kvHolder.kv, ACCOUNT)).used).toBe(1);
    expect(await creditBalance(kvHolder.kv, ACCOUNT)).toBe(1);
  });

  it("prefers a free check over a report credit when both remain", async () => {
    await creditGrant(kvHolder.kv, ACCOUNT, 5, "init-credits");
    const { reserveFreeCheck, commitFreeCheck } = await import("@/io/free-check-quota");
    // Two free checks already used — one remains.
    for (let i = 0; i < 2; i += 1) {
      const key = `prior-${i}`;
      expect((await reserveFreeCheck(kvHolder.kv, ACCOUNT, key)).ok).toBe(true);
      await commitFreeCheck(kvHolder.kv, ACCOUNT, key);
    }
    expect((await readFreeCheckQuota(kvHolder.kv, ACCOUNT)).remaining).toBe(1);
    expect(await creditBalance(kvHolder.kv, ACCOUNT)).toBe(5);

    runCheckMock.mockResolvedValue({
      ok: true,
      result: {
        kind: "vin_dossier",
        title: "2019 Honda Civic",
        verdict: "negotiate",
        verdictLabel: "Negotiate",
        confidence: "Low",
        summary: "ok",
        badge: null,
        fairValueUsd: 15_000,
        priceGap: 0.01,
        compCount: 6,
        compScope: "test",
        redFlags: [],
        questions: [],
        otd: null,
        otdNeedsZip: false,
        walkAwayUsd: null,
        walkAwayLabel: null,
        similarCars: [],
        fields: null,
        provenance: [],
        vin: "2HGFC3B33KH356212",
        vinDecode: null,
        recalls: [],
        recallsAvailable: false,
        complaintCount: null,
        fuel: null,
        fuelConflict: null,
        safetySummary: null,
        knownIssues: [],
        unknown: [],
        listingsForVin: [],
        llmUsed: false,
        sample: false,
        agentVerdict: null,
      },
    });

    const response = await POST(req({ kind: "vin", vin: "2HGFC3B33KH356212" }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.usedFreeCheck).toBe(true);
    expect(body.spentCredit).toBe(false);
    expect((await readFreeCheckQuota(kvHolder.kv, ACCOUNT)).used).toBe(3);
    expect((await readFreeCheckQuota(kvHolder.kv, ACCOUNT)).remaining).toBe(0);
    expect(await creditBalance(kvHolder.kv, ACCOUNT)).toBe(5);
  });

  it("replays a saved delivery without claiming another free check or credit", async () => {
    await creditGrant(kvHolder.kv, ACCOUNT, 2, "init-replay");
    runCheckMock.mockResolvedValue({
      ok: true,
      result: {
        kind: "vin_dossier",
        title: "2021 Toyota Camry",
        verdict: "dossier",
        verdictLabel: "VIN dossier",
        confidence: "Medium",
        summary: "ok",
        badge: null,
        fairValueUsd: null,
        priceGap: null,
        compCount: 0,
        compScope: "",
        redFlags: [],
        questions: [],
        otd: null,
        otdNeedsZip: false,
        walkAwayUsd: null,
        walkAwayLabel: null,
        similarCars: [],
        fields: null,
        provenance: [],
        vin: VIN,
        vinDecode: null,
        recalls: [],
        // Month-cache requires recallsAvailable !== false (degraded results are not cached).
        recallsAvailable: true,
        complaintCount: null,
        fuel: null,
        fuelConflict: null,
        safetySummary: null,
        knownIssues: [],
        unknown: [],
        listingsForVin: [],
        llmUsed: false,
        sample: false,
        agentVerdict: null,
      },
    });

    const first = await POST(req({ kind: "vin", vin: VIN }));
    const firstBody = await first.json();
    expect(first.status).toBe(200);
    expect(firstBody.usedFreeCheck).toBe(true);
    expect(firstBody.spentCredit).toBe(false);
    expect(firstBody.billingNote).toMatch(/Free vehicle check/i);
    expect((await readFreeCheckQuota(kvHolder.kv, ACCOUNT)).used).toBe(1);
    expect(await creditBalance(kvHolder.kv, ACCOUNT)).toBe(2);
    expect(runCheckMock).toHaveBeenCalledOnce();

    const second = await POST(req({ kind: "vin", vin: VIN }));
    const secondBody = await second.json();
    expect(second.status).toBe(200);
    expect(secondBody.fromCache).toBe(true);
    expect(typeof secondBody.settledAt).toBe("string");
    expect(secondBody.settledAt.length).toBeGreaterThan(0);
    expect(secondBody.usedFreeCheck).toBe(false);
    expect(secondBody.spentCredit).toBe(false);
    expect(secondBody.billingNote).toMatch(/no additional|already used/i);
    expect((await readFreeCheckQuota(kvHolder.kv, ACCOUNT)).used).toBe(1);
    expect(await creditBalance(kvHolder.kv, ACCOUNT)).toBe(2);
    // Cached VIN short-circuits before runCheck.
    expect(runCheckMock).toHaveBeenCalledOnce();
  });
});
