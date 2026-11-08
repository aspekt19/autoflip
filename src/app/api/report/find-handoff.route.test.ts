/**
 * End-to-end /api/report boundaries for selected-listing handoff.
 * Mocks provider + credit spend — no real Autodev/SERV/Stripe charges.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const spend = vi.fn<(id: string, key: string) => Promise<{ ok: boolean; balance: number }>>();
const balance = vi.fn<() => Promise<number>>();
const grant = vi.fn();
const uid = vi.fn(async () => "user-test");
const assemble = vi.fn();
const findReport = vi.fn<() => Promise<string | null>>(async () => null);
const readReport = vi.fn();
const rememberReport = vi.fn();
const persist = vi.fn();
const telegram = vi.fn();

vi.mock("@/server/session", () => ({
  userId: () => uid(),
  balanceOf: () => balance(),
  spendCredit: (id: string, key: string) => spend(id, key),
  grantCredit: (id: string, n: number, key: string) => grant(id, n, key),
}));

vi.mock("@/server/assemble", () => ({
  assembleReport: (input: unknown, deps: unknown) => assemble(input, deps),
}));

vi.mock("@/server/deps", () => ({
  runtimeDeps: () => ({ autodevKey: null, servKey: null }),
}));

const reusable = vi.fn(() => false);
vi.mock("@/io/persist-report", () => ({
  findUserReport: () => findReport(),
  readPersistedReport: (id: string) => readReport(id),
  rememberUserReport: (...args: [unknown, string, string, string, unknown]) => rememberReport(...args),
  persistReport: (report: unknown) => persist(report),
  reportReusable: () => reusable(),
}));

vi.mock("@/io/kv", () => ({
  getKv: () => ({}),
}));

vi.mock("@/server/telegram-notify", () => ({
  sendLinkedTelegram: (id: string, text: string, button?: unknown) => telegram(id, text, button),
}));

vi.mock("@/server/secrets", () => ({
  originOf: () => "https://lemonless.test",
}));

import { POST } from "./route";

const VIN = "2T3N1RFV6MC246998";
const VDP = "https://www.joemachenstoyota.com/auto/used-2021-toyota-rav4-limited/126661218/";

function req(body: unknown) {
  return new Request("https://lemonless.test/api/report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/report find handoff (mocked credits/provider)", () => {
  beforeEach(() => {
    spend.mockReset();
    balance.mockReset();
    grant.mockReset();
    assemble.mockReset();
    findReport.mockReset();
    persist.mockReset();
    telegram.mockReset();
    reusable.mockReset();
    reusable.mockReturnValue(false);
    uid.mockResolvedValue("user-test");
    findReport.mockResolvedValue(null);
    balance.mockResolvedValue(2);
    spend.mockResolvedValue({ ok: true, balance: 1 });
    persist.mockResolvedValue(undefined);
  });

  it("rejects URL-only find CTA without VIN before any credit check", async () => {
    const response = await POST(
      req({
        mode: "personal",
        surface: "find",
        cta: "find_card_full_analysis",
        url: VDP,
      }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("vin_required");
    expect(balance).not.toHaveBeenCalled();
    expect(spend).not.toHaveBeenCalled();
    expect(assemble).not.toHaveBeenCalled();
  });

  it("accepts selected card VIN+VDP and charges once after assemble succeeds", async () => {
    assemble.mockResolvedValue({
      ok: true,
      report: {
        id: "report-1",
        computed: {
          subject: { year: 2021, make: "Toyota", model: "RAV4" },
          flags: [],
          openParkIt: false,
          verdict: "fair",
          score: 50,
        },
      },
    });

    const response = await POST(
      req({
        mode: "personal",
        surface: "find",
        cta: "find_card_full_analysis",
        vin: VIN,
        url: VDP,
        zip: "68114",
        miles: 21_001,
        selectedVin: VIN,
        selectedVdp: VDP,
      }),
    );
    expect(response.status).toBe(200);
    expect(assemble).toHaveBeenCalledTimes(1);
    const assembleInput = assemble.mock.calls[0]?.[0] as { vin?: string; url?: string };
    expect(assembleInput.vin).toBe(VIN);
    expect(assembleInput.url).toBe(VDP);
    expect(spend).toHaveBeenCalledTimes(1);
    expect(spend.mock.calls[0]?.[1]).toBe("report:report-1");
  });

  it("does not charge when assemble fails after a valid selected listing", async () => {
    assemble.mockResolvedValue({
      ok: false,
      status: 502,
      error: "listings_error",
      message: "Listings unavailable",
    });
    const response = await POST(
      req({
        mode: "personal",
        surface: "find",
        cta: "find_card_full_analysis",
        vin: VIN,
        url: VDP,
        selectedVin: VIN,
      }),
    );
    expect(response.status).toBe(502);
    expect(spend).not.toHaveBeenCalled();
  });

  it("returns credits_required without assemble when balance is zero (after identity ok)", async () => {
    balance.mockResolvedValue(0);
    const response = await POST(
      req({
        mode: "personal",
        surface: "find",
        cta: "find_card_full_analysis",
        vin: VIN,
        url: VDP,
        selectedVin: VIN,
      }),
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("credits_required");
    expect(body.cta).toBe("find_card_full_analysis");
    expect(assemble).not.toHaveBeenCalled();
    expect(spend).not.toHaveBeenCalled();
  });

  it("idempotent retry: already-saved report does not spend again", async () => {
    findReport.mockResolvedValue("report-1");
    reusable.mockReturnValue(true);
    readReport.mockResolvedValue({
      id: "report-1",
      computed: { subject: { year: 2021, make: "Toyota", model: "RAV4", priceUsd: 17900 } },
    });

    const response = await POST(
      req({
        mode: "personal",
        surface: "find",
        cta: "find_pending_retry",
        vin: VIN,
        url: VDP,
        selectedVin: VIN,
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.alreadySaved).toBe(true);
    expect(assemble).not.toHaveBeenCalled();
    expect(spend).not.toHaveBeenCalled();
  });

  it("manual URL path still works when the link embeds a VIN", async () => {
    assemble.mockResolvedValue({
      ok: true,
      report: {
        id: "report-2",
        computed: {
          subject: { year: 2021, make: "Toyota", model: "RAV4" },
          flags: [],
          openParkIt: false,
          verdict: "fair",
          score: 50,
        },
      },
    });
    const response = await POST(
      req({
        mode: "personal",
        surface: "check",
        cta: "check_manual_url",
        url: `https://dealer.example/vdp/${VIN}`,
        vin: VIN,
        selectedVin: VIN,
      }),
    );
    expect(response.status).toBe(200);
    expect(spend).toHaveBeenCalledTimes(1);
  });

  it("counterfeit surface:find + VIN-only cannot skip typed ask/miles/ZIP before charge", async () => {
    const response = await POST(
      req({
        mode: "personal",
        surface: "find",
        vin: VIN,
      }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("vin_needs_details");
    expect(body.missing).toEqual(expect.arrayContaining(["asking price", "mileage", "ZIP"]));
    expect(balance).not.toHaveBeenCalled();
    expect(assemble).not.toHaveBeenCalled();
    expect(spend).not.toHaveBeenCalled();
  });

  it("counterfeit surface:find + selectedVin without VDP/miles/ZIP still requires details", async () => {
    const response = await POST(
      req({
        mode: "personal",
        surface: "find",
        cta: "find_card_full_analysis",
        vin: VIN,
        selectedVin: VIN,
      }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("vin_needs_details");
    expect(assemble).not.toHaveBeenCalled();
    expect(spend).not.toHaveBeenCalled();
  });

  it("trusted find handoff with VDP does not demand typed ask before assemble", async () => {
    assemble.mockResolvedValue({
      ok: true,
      report: {
        id: "report-find-ok",
        computed: {
          subject: { year: 2021, make: "Toyota", model: "RAV4", priceUsd: null },
          flags: [],
          openParkIt: false,
          verdict: "insufficient_data",
          score: null,
        },
      },
    });
    const response = await POST(
      req({
        mode: "personal",
        surface: "find",
        cta: "find_card_full_analysis",
        vin: VIN,
        url: VDP,
        selectedVin: VIN,
        selectedVdp: VDP,
        zip: "68114",
        miles: 21_001,
        budgetUsd: 20_000,
        budgetKnown: true,
      }),
    );
    expect(response.status).toBe(200);
    expect(assemble).toHaveBeenCalledTimes(1);
    const assembleInput = assemble.mock.calls[0]?.[0] as { askingPriceUsd?: number; vin?: string };
    expect(assembleInput.vin).toBe(VIN);
    expect(assembleInput.askingPriceUsd).toBeUndefined();
    expect(spend).toHaveBeenCalledTimes(1);
  });

  it("manual VIN path still requires ask/miles/ZIP (guards preserved)", async () => {
    const response = await POST(
      req({
        mode: "personal",
        surface: "check",
        cta: "check_manual_vin",
        vin: VIN,
        selectedVin: VIN,
      }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("vin_needs_details");
    expect(assemble).not.toHaveBeenCalled();
    expect(spend).not.toHaveBeenCalled();
  });
});
