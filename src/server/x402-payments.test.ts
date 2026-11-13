import { afterEach, describe, expect, it, vi } from "vitest";
import {
  X402_DEFAULT_PAY_TO,
  X402_NETWORK,
  X402_REPORT_PRICE_USD,
  X402_USDC,
  agentPaymentInfo,
  isX402Configured,
} from "./x402-payments";

afterEach(() => vi.unstubAllEnvs());

describe("Lemonless x402 agent payment catalog", () => {
  it("publishes the Base USDC rail and the configured treasury", () => {
    const info = agentPaymentInfo("https://autoflip-umber.vercel.app");
    expect(X402_NETWORK).toBe("eip155:8453");
    expect(X402_USDC).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(X402_DEFAULT_PAY_TO).toBe("0x250aC40Ab38E4f023c33C1c3DFD0Cd07357Fbf79");
    expect(info.pay_to).toBe(X402_DEFAULT_PAY_TO);
    expect(info.registration.price_usd).toBe(0.01);
    expect(info.single_report.price_usd).toBe(X402_REPORT_PRICE_USD);
    expect(info.credits.packs).toEqual([
      { id: "pack_3", credits: 3, price_usd: 9 },
      { id: "pack_10", credits: 10, price_usd: 25 },
    ]);
    expect(info.plans.auto_renew).toBe(false);
  });

  it("reports the facilitator unavailable until CDP credentials exist", () => {
    vi.stubEnv("CDP_API_KEY_ID", "");
    vi.stubEnv("CDP_API_KEY_SECRET", "");
    expect(isX402Configured()).toBe(false);
    expect(agentPaymentInfo("https://example.test").available).toBe(false);
  });
});
