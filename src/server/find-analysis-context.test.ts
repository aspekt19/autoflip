import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import {
  mintFindAnalysisContextRecord,
  rememberFindAnalysisContexts,
  storeFindAnalysisContext,
  verifyFindAnalysisContext,
  claimsFindAnalysisHandoff,
} from "./find-analysis-context";

const VIN = "2T3N1RFV6MC246998";
const VDP = "https://www.joemachenstoyota.com/auto/used-2021-toyota-rav4-limited/126661218/";
const EVIL = "https://evil.example/vdp/forged";

describe("find analysis context (server-stored)", () => {
  it("mints owner-bound context and verifies matching VIN+VDP", async () => {
    const kv = new MemoryKv();
    const tokens = await rememberFindAnalysisContexts(
      kv,
      "user-a",
      [
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
      ],
      "68114",
    );
    const token = tokens.get(VIN)!;
    const verified = await verifyFindAnalysisContext(kv, {
      userId: "user-a",
      token,
      vin: VIN,
      claimedVdp: VDP,
      claimedMiles: 21_001,
      claimedZip: "68114",
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.record.vdp).toBe(VDP);
    expect(verified.record.askingPriceUsd).toBe(18_900);
  });

  it("rejects forged evil VDP even with matching VIN", async () => {
    const kv = new MemoryKv();
    const record = mintFindAnalysisContextRecord("user-a", {
      vin: VIN,
      year: 2021,
      make: "Toyota",
      model: "RAV4",
      miles: 21_001,
      priceUsd: 18_900,
      vdp: VDP,
      priceView: { usableForBudget: true },
    }, "68114");
    await storeFindAnalysisContext(kv, record);

    const forged = await verifyFindAnalysisContext(kv, {
      userId: "user-a",
      token: record.token,
      vin: VIN,
      claimedVdp: EVIL,
    });
    expect(forged.ok).toBe(false);
    if (forged.ok) return;
    expect(forged.reason).toBe("vdp_mismatch");
  });

  it("rejects zip 00000 / miles tamper against stored facts", async () => {
    const kv = new MemoryKv();
    const record = mintFindAnalysisContextRecord("user-a", {
      vin: VIN,
      year: 2021,
      make: "Toyota",
      model: "RAV4",
      miles: 21_001,
      priceUsd: 18_900,
      vdp: VDP,
      priceView: { usableForBudget: true },
    }, "68114");
    await storeFindAnalysisContext(kv, record);

    const zipTamper = await verifyFindAnalysisContext(kv, {
      userId: "user-a",
      token: record.token,
      vin: VIN,
      claimedVdp: VDP,
      claimedZip: "00000",
    });
    expect(zipTamper.ok).toBe(false);
    if (zipTamper.ok) return;
    expect(zipTamper.reason).toBe("tampered_facts");
  });

  it("rejects wrong user, expired, missing token, VIN mismatch", async () => {
    const kv = new MemoryKv();
    const now = Date.now();
    const record = mintFindAnalysisContextRecord(
      "user-a",
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
      now,
    );
    await storeFindAnalysisContext(kv, record);

    const wrongUser = await verifyFindAnalysisContext(kv, {
      userId: "user-b",
      token: record.token,
      vin: VIN,
      claimedVdp: VDP,
    });
    expect(wrongUser.ok).toBe(false);
    if (!wrongUser.ok) expect(wrongUser.reason).toBe("not_found");

    const expired = await verifyFindAnalysisContext(
      kv,
      { userId: "user-a", token: record.token, vin: VIN, claimedVdp: VDP },
      now + 3 * 60 * 60 * 1000,
    );
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.reason).toBe("expired");

    const missing = await verifyFindAnalysisContext(kv, {
      userId: "user-a",
      token: "",
      vin: VIN,
      claimedVdp: VDP,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe("missing_token");

    const vinMismatch = await verifyFindAnalysisContext(kv, {
      userId: "user-a",
      token: record.token,
      vin: "1HGCM82633A004352",
      claimedVdp: VDP,
    });
    expect(vinMismatch.ok).toBe(false);
    if (!vinMismatch.ok) expect(vinMismatch.reason).toBe("vin_mismatch");
  });

  it("rejects client-invented VDP when server stored null VDP", async () => {
    const kv = new MemoryKv();
    const record = mintFindAnalysisContextRecord("user-a", {
      vin: VIN,
      year: 2021,
      make: "Toyota",
      model: "RAV4",
      miles: 21_001,
      priceUsd: 18_900,
      vdp: null,
      priceView: { usableForBudget: true },
    }, "68114");
    await storeFindAnalysisContext(kv, record);
    const invented = await verifyFindAnalysisContext(kv, {
      userId: "user-a",
      token: record.token,
      vin: VIN,
      claimedVdp: EVIL,
    });
    expect(invented.ok).toBe(false);
    if (!invented.ok) expect(invented.reason).toBe("vdp_mismatch");
  });

  it("claimsFindAnalysisHandoff detects find intent without trusting it", () => {
    expect(claimsFindAnalysisHandoff({ surface: "find" })).toBe(true);
    expect(claimsFindAnalysisHandoff({ cta: "find_card_full_analysis" })).toBe(true);
    expect(claimsFindAnalysisHandoff({ findContextToken: "abc" })).toBe(true);
    expect(claimsFindAnalysisHandoff({ surface: "check", cta: "check_manual_url" })).toBe(false);
  });
});
