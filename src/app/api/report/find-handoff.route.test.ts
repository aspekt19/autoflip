/**
 * End-to-end /api/report boundaries for selected-listing handoff.
 * Mocks provider + credit spend — no real Autodev/SERV/Stripe charges.
 * Failure-first: every tamper class must 0-charge before balance/assemble/spend.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKv } from "@/io/kv";
import {
  mintFindAnalysisContextRecord,
  storeFindAnalysisContext,
} from "@/server/find-analysis-context";

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

const kvHolder: { kv: MemoryKv } = { kv: new MemoryKv() };

vi.mock("@/server/session", () => ({
  userId: () => uid(),
  balanceOf: () => balance(),
  spendCredit: (id: string, key: string) => spend(id, key),
  grantCredit: (id: string, n: number, key: string) => grant(id, n, key),
  // Handoff suite mocks spend/grant; compensate is unused on the happy/refusal paths under test.
  compensateSpendCredit: async () => ({ ok: true, balance: 0, compensated: false }),
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

vi.mock("@/io/kv", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/io/kv")>();
  return {
    ...actual,
    getKv: () => kvHolder.kv,
  };
});

vi.mock("@/server/telegram-notify", () => ({
  sendLinkedTelegram: (id: string, text: string, button?: unknown) => telegram(id, text, button),
}));

vi.mock("@/server/secrets", () => ({
  originOf: () => "https://lemonless.test",
}));

import { POST } from "./route";

const VIN = "2T3N1RFV6MC246998";
const VDP = "https://www.joemachenstoyota.com/auto/used-2021-toyota-rav4-limited/126661218/";
const EVIL = "https://evil.example/auto/forged-rav4";

function req(body: unknown) {
  return new Request("https://lemonless.test/api/report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function okReport(over?: {
  id?: string;
  priceUsd?: number | null;
  miles?: number | null;
  dataNotes?: string[];
  verdict?: string;
}) {
  return {
    ok: true as const,
    report: {
      id: over?.id ?? "report-1",
      computed: {
        subject: {
          year: 2021,
          make: "Toyota",
          model: "RAV4",
          priceUsd: over?.priceUsd === undefined ? 18_900 : over.priceUsd,
          miles: over?.miles === undefined ? 21_001 : over.miles,
        },
        flags: [],
        openParkIt: false,
        verdict: over?.verdict ?? "fair",
        score: 50,
        dataNotes: over?.dataNotes ?? [],
        reasons: [],
      },
    },
  };
}

async function mintToken(over?: { vdp?: string | null; miles?: number | null; zip?: string | null; userId?: string }) {
  const record = mintFindAnalysisContextRecord(
    over?.userId ?? "user-test",
    {
      vin: VIN,
      year: 2021,
      make: "Toyota",
      model: "RAV4",
      miles: over?.miles === undefined ? 21_001 : over.miles,
      priceUsd: 18_900,
      vdp: over?.vdp === undefined ? VDP : over.vdp,
      priceView: { usableForBudget: true },
    },
    over?.zip === undefined ? "68114" : over.zip,
  );
  await storeFindAnalysisContext(kvHolder.kv, record);
  return record.token;
}

describe("POST /api/report find handoff (mocked credits/provider)", () => {
  beforeEach(() => {
    kvHolder.kv = new MemoryKv();
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

  it("TAMPER: forged HTTPS evil VDP + matching selectedVin + CTA fails closed 0 charge", async () => {
    const response = await POST(
      req({
        mode: "personal",
        surface: "find",
        cta: "find_card_full_analysis",
        vin: VIN,
        url: EVIL,
        selectedVin: VIN,
        selectedVdp: EVIL,
        zip: "68114",
        miles: 21_001,
      }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("find_context_invalid");
    expect(body.charge).toBe(false);
    expect(balance).not.toHaveBeenCalled();
    expect(assemble).not.toHaveBeenCalled();
    expect(spend).not.toHaveBeenCalled();
  });

  it("TAMPER: zip 00000 + miles without server token fails closed", async () => {
    const response = await POST(
      req({
        mode: "personal",
        surface: "find",
        cta: "find_card_full_analysis",
        vin: VIN,
        selectedVin: VIN,
        zip: "00000",
        miles: 21_001,
      }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("find_context_invalid");
    expect(assemble).not.toHaveBeenCalled();
    expect(spend).not.toHaveBeenCalled();
  });

  it("TAMPER: wrong user cannot use another owner's token", async () => {
    const token = await mintToken({ userId: "owner-other" });
    const response = await POST(
      req({
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
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("find_context_invalid");
    expect(spend).not.toHaveBeenCalled();
  });

  it("TAMPER: VDP swap against minted context fails before assemble", async () => {
    const token = await mintToken({ vdp: VDP });
    const response = await POST(
      req({
        mode: "personal",
        surface: "find",
        cta: "find_card_full_analysis",
        vin: VIN,
        url: EVIL,
        selectedVin: VIN,
        selectedVdp: EVIL,
        findContextToken: token,
        zip: "68114",
        miles: 21_001,
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).reason).toBe("vdp_mismatch");
    expect(assemble).not.toHaveBeenCalled();
    expect(spend).not.toHaveBeenCalled();
  });

  it("legit single card: token+VIN+VDP charges once after deliverable assemble", async () => {
    const token = await mintToken();
    assemble.mockResolvedValue(okReport());

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
        findContextToken: token,
      }),
    );
    expect(response.status).toBe(200);
    expect(assemble).toHaveBeenCalledTimes(1);
    const assembleInput = assemble.mock.calls[0]?.[0] as { vin?: string; url?: string; miles?: number; zip?: string };
    expect(assembleInput.vin).toBe(VIN);
    expect(assembleInput.url).toBe(VDP);
    expect(assembleInput.miles).toBe(21_001);
    expect(assembleInput.zip).toBe("68114");
    expect(spend).toHaveBeenCalledTimes(1);
    expect(spend.mock.calls[0]?.[1]).toBe(`report:analysis:findctx:user-test:${token}`);
  });

  it("legit multi-card: each token binds its own VDP (cross-token rejected)", async () => {
    const tokenA = await mintToken({ vdp: VDP });
    const vinB = "1HGCM82633A004352";
    const vdpB = "https://dealer.example/vdp/b";
    const recordB = mintFindAnalysisContextRecord(
      "user-test",
      {
        vin: vinB,
        year: 2019,
        make: "Honda",
        model: "Accord",
        miles: 40_000,
        priceUsd: 16_500,
        vdp: vdpB,
        priceView: { usableForBudget: true },
      },
      "68114",
    );
    await storeFindAnalysisContext(kvHolder.kv, recordB);
    assemble.mockResolvedValue(okReport({ id: "report-b" }));

    const response = await POST(
      req({
        mode: "personal",
        surface: "find",
        cta: "find_card_full_analysis",
        vin: vinB,
        url: vdpB,
        selectedVin: vinB,
        selectedVdp: vdpB,
        findContextToken: recordB.token,
        zip: "68114",
        miles: 40_000,
      }),
    );
    expect(response.status).toBe(200);
    expect(spend).toHaveBeenCalledTimes(1);

    assemble.mockClear();
    spend.mockClear();
    const cross = await POST(
      req({
        mode: "personal",
        surface: "find",
        cta: "find_card_full_analysis",
        vin: vinB,
        url: vdpB,
        selectedVin: vinB,
        selectedVdp: vdpB,
        findContextToken: tokenA,
      }),
    );
    expect(cross.status).toBe(400);
    expect(spend).not.toHaveBeenCalled();
  });

  it("pending retry / back-refresh: same token same car assemble-once spend-once via alreadySaved", async () => {
    const token = await mintToken();
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
        selectedVdp: VDP,
        findContextToken: token,
        zip: "68114",
        miles: 21_001,
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.alreadySaved).toBe(true);
    expect(assemble).not.toHaveBeenCalled();
    expect(spend).not.toHaveBeenCalled();
  });

  it("does not charge when assemble fails after a valid selected listing", async () => {
    const token = await mintToken();
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
        selectedVdp: VDP,
        findContextToken: token,
        zip: "68114",
        miles: 21_001,
      }),
    );
    expect(response.status).toBe(502);
    expect(spend).not.toHaveBeenCalled();
  });

  it("FEE REFUSAL: unusable purchase ask report ⇒ no ask economics AND 0 debit", async () => {
    const token = await mintToken();
    assemble.mockResolvedValue(
      okReport({
        priceUsd: null,
        verdict: "withheld",
        dataNotes: [
          "Feed/stated figure $587 is not treated as a verified vehicle purchase ask (known non purchase). Report economics use unknown asking price; price not invented.",
        ],
      }),
    );
    const response = await POST(
      req({
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
        budgetUsd: 20_000,
        budgetKnown: true,
      }),
    );
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error).toBe("unusable_purchase_ask");
    expect(body.charge).toBe(false);
    expect(body.outcome).toBe("refused_unusable_purchase_ask");
    expect(body.message).toMatch(/No credit was charged/i);
    expect(assemble).toHaveBeenCalledTimes(1);
    expect(spend).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("returns credits_required without assemble when balance is zero (after identity+context ok)", async () => {
    const token = await mintToken();
    balance.mockResolvedValue(0);
    const response = await POST(
      req({
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
      }),
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("credits_required");
    expect(body.cta).toBe("find_card_full_analysis");
    expect(assemble).not.toHaveBeenCalled();
    expect(spend).not.toHaveBeenCalled();
  });

  it("manual URL path still works when the link embeds a VIN (unsigned path unchanged)", async () => {
    assemble.mockResolvedValue(okReport({ id: "report-2" }));
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

  it("counterfeit surface:find + VIN-only without token cannot skip details / does not charge", async () => {
    const response = await POST(
      req({
        mode: "personal",
        surface: "find",
        vin: VIN,
      }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("find_context_invalid");
    expect(balance).not.toHaveBeenCalled();
    expect(assemble).not.toHaveBeenCalled();
    expect(spend).not.toHaveBeenCalled();
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

  /**
   * t309 — production PR74 incident: 2016 Mazda CX-5 Touring Gateway Omaha.
   * Dealer retail.zip ≠ search ZIP 68114; Full analysis claimed need.zip and was
   * refused find_context_invalid / 0 charge. Must succeed with checks intact.
   */
  it("t309 Gateway Mazda CX-5: dealer zip ≠ search zip Full analysis charges once", async () => {
    const GATEWAY_VIN = "JM3KE4CY7G0753111";
    const GATEWAY_VDP =
      "https://www.gatewayautosalesomaha.com/inventory/used-2016-mazda-cx-5-touring-sport-utility-4d-jm3ke4cy7g0753111-in-omaha-ne";
    const SEARCH_ZIP = "68114";
    const DEALER_ZIP = "68107";

    const record = mintFindAnalysisContextRecord(
      "user-test",
      {
        vin: GATEWAY_VIN,
        year: 2016,
        make: "Mazda",
        model: "CX-5",
        miles: 94_057,
        priceUsd: 15_995,
        vdp: GATEWAY_VDP,
        zip: DEALER_ZIP,
        priceView: { usableForBudget: true },
      },
      SEARCH_ZIP,
    );
    await storeFindAnalysisContext(kvHolder.kv, record);
    assemble.mockResolvedValue(
      okReport({
        id: "report-gateway-mazda",
        priceUsd: 15_995,
        miles: 94_057,
        verdict: "good_deal",
      }),
    );

    const response = await POST(
      req({
        mode: "personal",
        surface: "find",
        cta: "find_card_full_analysis",
        vin: GATEWAY_VIN,
        url: GATEWAY_VDP,
        selectedVin: GATEWAY_VIN,
        selectedVdp: GATEWAY_VDP,
        findContextToken: record.token,
        zip: SEARCH_ZIP,
        miles: 94_057,
        askingPriceUsd: 15_995,
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.id).toBe("report-gateway-mazda");
    expect(assemble).toHaveBeenCalledTimes(1);
    const assembleInput = assemble.mock.calls[0]?.[0] as {
      vin?: string;
      url?: string;
      miles?: number;
      zip?: string;
      askingPriceUsd?: number;
    };
    expect(assembleInput.vin).toBe(GATEWAY_VIN);
    expect(assembleInput.url).toBe(GATEWAY_VDP);
    expect(assembleInput.miles).toBe(94_057);
    expect(assembleInput.zip).toBe(SEARCH_ZIP);
    expect(assembleInput.askingPriceUsd).toBe(15_995);
    expect(spend).toHaveBeenCalledTimes(1);
    expect(spend.mock.calls[0]?.[1]).toBe(`report:analysis:findctx:user-test:${record.token}`);
  });

  it("t309 still refuses forged ZIP against find-session binding", async () => {
    const GATEWAY_VIN = "JM3KE4CY7G0753111";
    const GATEWAY_VDP =
      "https://www.gatewayautosalesomaha.com/inventory/used-2016-mazda-cx-5-touring-sport-utility-4d-jm3ke4cy7g0753111-in-omaha-ne";
    const record = mintFindAnalysisContextRecord(
      "user-test",
      {
        vin: GATEWAY_VIN,
        year: 2016,
        make: "Mazda",
        model: "CX-5",
        miles: 94_057,
        priceUsd: 15_995,
        vdp: GATEWAY_VDP,
        zip: "68107",
        priceView: { usableForBudget: true },
      },
      "68114",
    );
    await storeFindAnalysisContext(kvHolder.kv, record);

    const response = await POST(
      req({
        mode: "personal",
        surface: "find",
        cta: "find_card_full_analysis",
        vin: GATEWAY_VIN,
        url: GATEWAY_VDP,
        selectedVin: GATEWAY_VIN,
        selectedVdp: GATEWAY_VDP,
        findContextToken: record.token,
        zip: "00000",
        miles: 94_057,
      }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("find_context_invalid");
    expect(body.reason).toBe("tampered_facts");
    expect(body.charge).toBe(false);
    expect(assemble).not.toHaveBeenCalled();
    expect(spend).not.toHaveBeenCalled();
  });
});
