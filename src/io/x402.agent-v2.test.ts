import { describe, expect, it, vi } from "vitest";
import {
  agentX402PaymentsLive,
  encodePaymentRequiredHeader,
  paymentRequiredV2,
  readX402Config,
  settlePayment,
  verifyPayment,
  X402_NETWORK_BASE,
  X402_USDC_BASE,
} from "./x402";
import {
  beginAgentX402FromPayload,
  settleAgentX402Payment,
} from "@/server/agent-x402";

describe("x402 agent v2 (flag-gated, mock facilitator)", () => {
  it("keeps agent payments disabled by default", () => {
    const config = readX402Config({
      X402_PAY_TO: "0x1111111111111111111111111111111111111111",
      X402_FACILITATOR_URL: "https://facilitator.example",
      X402_VERSION: "2",
    });
    expect(config.agentPaymentsEnabled).toBe(false);
    expect(agentX402PaymentsLive(config)).toBe(false);
    expect(config.network).toBe(X402_NETWORK_BASE);
    expect(config.asset).toBe(X402_USDC_BASE);
    expect(config.scheme).toBe("exact");
  });

  it("enables only when X402_AGENT_PAYMENTS_ENABLED is on and payee is set", () => {
    const config = readX402Config({
      X402_AGENT_PAYMENTS_ENABLED: "1",
      X402_PAY_TO: "0x1111111111111111111111111111111111111111",
      X402_FACILITATOR_URL: "https://facilitator.example",
      X402_VERSION: "2",
    });
    expect(agentX402PaymentsLive(config)).toBe(true);
  });

  it("builds a v2 PaymentRequired challenge with PAYMENT-REQUIRED encoding", () => {
    const config = readX402Config({
      X402_AGENT_PAYMENTS_ENABLED: "1",
      X402_PAY_TO: "0x1111111111111111111111111111111111111111",
      X402_FACILITATOR_URL: "https://facilitator.example",
      X402_VERSION: "2",
      X402_PRICE_ATOMIC: "250000",
    });
    const body = paymentRequiredV2("https://lemonless.example/api/v1/check", config);
    expect(body.x402Version).toBe(2);
    expect(body.accepts[0]?.network).toBe(X402_NETWORK_BASE);
    expect(body.accepts[0]?.asset).toBe(X402_USDC_BASE);
    expect(body.accepts[0]?.maxAmountRequired).toBe("250000");
    const encoded = encodePaymentRequiredHeader(body);
    expect(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")).x402Version).toBe(2);
  });

  it("verifies then settles via mock facilitator (no real payments)", async () => {
    const header = Buffer.from(JSON.stringify({ accepted: true })).toString("base64");
    const requirement = {
      scheme: "exact",
      network: X402_NETWORK_BASE,
      maxAmountRequired: "1000000",
      resource: "https://lemonless.example/api/v1/check",
      description: "test",
      mimeType: "application/json",
      payTo: "0x1111111111111111111111111111111111111111",
      maxTimeoutSeconds: 120,
      asset: X402_USDC_BASE,
      extra: { facilitator: "https://facilitator.example", name: "USDC", version: "2" },
    };

    const verifyFetch = vi.fn(async () => Response.json({ isValid: true }));
    const verified = await verifyPayment(header, requirement, {
      fetch: verifyFetch as typeof fetch,
      facilitatorUrl: "https://facilitator.example",
      x402Version: 2,
    });
    expect(verified.ok).toBe(true);
    expect(verifyFetch).toHaveBeenCalled();
    const verifyCall = verifyFetch.mock.calls[0] as unknown as [string, RequestInit?];
    expect(JSON.parse(String(verifyCall[1]?.body))).toMatchObject({
      x402Version: 2,
    });

    const settleFetch = vi.fn(async () => Response.json({ success: true, txHash: "0xmock" }));
    if (!verified.ok) return;
    const settled = await settlePayment(verified.verified, requirement, {
      fetch: settleFetch as typeof fetch,
      facilitatorUrl: "https://facilitator.example",
      x402Version: 2,
    });
    expect(settled).toEqual({ ok: true, txHash: "0xmock" });
  });

  it("beginAgentX402FromPayload stays off when the flag is unset", async () => {
    const result = await beginAgentX402FromPayload(
      Buffer.from(JSON.stringify({ accepted: true })).toString("base64"),
      "https://lemonless.example/api/v1/check",
      {
        env: {
          X402_PAY_TO: "0x1111111111111111111111111111111111111111",
          X402_FACILITATOR_URL: "https://facilitator.example",
          X402_VERSION: "2",
          // flag intentionally omitted
        },
        fetch: vi.fn() as unknown as typeof fetch,
      },
    );
    expect(result.kind).toBe("off");
  });

  it("settleAgentX402Payment uses mock facilitator after delivery", async () => {
    const settleFetch = vi.fn(async () => Response.json({ success: true, txHash: "0xabc" }));
    const settled = await settleAgentX402Payment(
      {
        verified: { paymentPayload: { accepted: true } },
        requirement: {
          scheme: "exact",
          network: X402_NETWORK_BASE,
          maxAmountRequired: "1000000",
          resource: "https://lemonless.example/api/v1/find",
          description: "test",
          mimeType: "application/json",
          payTo: "0x1111111111111111111111111111111111111111",
          maxTimeoutSeconds: 120,
          asset: X402_USDC_BASE,
          extra: { facilitator: "https://facilitator.example" },
        },
        resourceUrl: "https://lemonless.example/api/v1/find",
        config: readX402Config({
          X402_AGENT_PAYMENTS_ENABLED: "1",
          X402_PAY_TO: "0x1111111111111111111111111111111111111111",
          X402_FACILITATOR_URL: "https://facilitator.example",
          X402_VERSION: "2",
        }),
      },
      { fetch: settleFetch as typeof fetch },
    );
    expect(settled).toEqual({ ok: true, txHash: "0xabc" });
  });
});
