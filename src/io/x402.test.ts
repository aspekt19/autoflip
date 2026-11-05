import { describe, expect, it, vi } from "vitest";
import {
  settlePayment,
  verifyPayment,
  type PaymentRequirements,
} from "./x402";

const requirement: PaymentRequirements = {
  scheme: "gokite-aa",
  network: "kite-testnet",
  maxAmountRequired: "1000000",
  resource: "https://autoflip.example/api/v1/report",
  description: "AutoFlip full vehicle report",
  mimeType: "application/json",
  payTo: "0x1111111111111111111111111111111111111111",
  maxTimeoutSeconds: 120,
  asset: "USDC",
  extra: { facilitator: "https://facilitator.example", session: "kite-passport" },
};

const header = Buffer.from(JSON.stringify({ accepted: true })).toString("base64");

describe("x402 payment lifecycle", () => {
  it("verifies without settling so the caller can build the paid resource first", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => Response.json({ isValid: true }));
    const result = await verifyPayment(header, requirement, {
      fetch: fetcher as typeof fetch,
      facilitatorUrl: "https://facilitator.example",
    });

    expect(result.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://facilitator.example/verify");
  });

  it("does not expose a verified payment when the facilitator rejects it", async () => {
    const fetcher = vi.fn(async () => Response.json({ isValid: false, invalidReason: "expired" }));
    const result = await verifyPayment(header, requirement, {
      fetch: fetcher as typeof fetch,
      facilitatorUrl: "https://facilitator.example",
    });

    expect(result).toEqual({ ok: false, error: "expired" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("settles only after the caller explicitly requests settlement", async () => {
    const verified = await verifyPayment(header, requirement, {
      fetch: (async () => Response.json({ isValid: true })) as typeof fetch,
      facilitatorUrl: "https://facilitator.example",
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;

    const fetcher = vi.fn(async (_input: RequestInfo | URL) => Response.json({ success: true, txHash: "0xabc" }));
    const result = await settlePayment(verified.verified, requirement, {
      fetch: fetcher as typeof fetch,
      facilitatorUrl: "https://facilitator.example",
    });

    expect(result).toEqual({ ok: true, txHash: "0xabc" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://facilitator.example/settle");
  });

  it("rejects an unreadable payment header without contacting the facilitator", async () => {
    const fetcher = vi.fn();
    const result = await verifyPayment("not-json", requirement, {
      fetch: fetcher as typeof fetch,
      facilitatorUrl: "https://facilitator.example",
    });

    expect(result).toEqual({ ok: false, error: "Payment header was not valid JSON." });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
