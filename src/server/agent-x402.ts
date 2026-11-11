/**
 * Optional x402 v2 pay-per-check / pay-per-find for agents (USDC on Base).
 * Disabled by default (`X402_AGENT_PAYMENTS_ENABLED` must be explicitly on).
 * Verify before work; settle only after a successful delivery.
 */
import {
  agentX402PaymentsLive,
  paymentHeader,
  paymentRequiredResponse,
  readX402Config,
  requirementsFor,
  settlePayment,
  verifyPayment,
  type PaymentRequirements,
  type SettleResult,
  type VerifiedPayment,
  type X402Config,
} from "@/io/x402";

export type AgentX402Verified = {
  verified: VerifiedPayment;
  requirement: PaymentRequirements;
  config: X402Config;
  resourceUrl: string;
};

export type AgentX402Begin =
  | { kind: "off" }
  | { kind: "none" }
  | { kind: "verified"; value: AgentX402Verified }
  | { kind: "rejected"; status: number; body: Record<string, unknown>; headers?: HeadersInit };

export function agentX402ChallengeResponse(resourceUrl: string, config: X402Config = readX402Config()): Response {
  return paymentRequiredResponse(
    resourceUrl,
    config,
    "Payment required. Pay USDC on Base (x402 v2), then retry with PAYMENT-SIGNATURE. Or buy site report credits.",
  );
}

/**
 * Begin optional agent x402: off → none; no header → none; header → verify (not settle).
 */
export async function beginAgentX402Payment(
  request: Request,
  resourceUrl: string,
  deps?: { fetch?: typeof fetch; env?: Record<string, string | undefined> },
): Promise<AgentX402Begin> {
  const config = readX402Config(deps?.env ?? process.env);
  if (!agentX402PaymentsLive(config)) return { kind: "off" };

  const header = paymentHeader(request.headers);
  if (!header) {
    // Also accept MCP/tool body field when callers pass payment in JSON (handled by callers).
    return { kind: "none" };
  }

  const requirement = requirementsFor(resourceUrl, config);
  const verified = await verifyPayment(header, requirement, {
    fetch: deps?.fetch ?? fetch,
    facilitatorUrl: config.facilitatorUrl,
    x402Version: config.version,
  });
  if (!verified.ok) {
    return {
      kind: "rejected",
      status: 402,
      body: {
        error_code: "payment_rejected",
        error: "payment_rejected",
        message: verified.error,
        credit_spent: false,
        retry_safe: true,
        accepts: [requirement],
        next_steps: {
          action: "fix_payment_and_retry",
          summary: "Obtain a fresh x402 PAYMENT-SIGNATURE for this resource, then retry.",
          request: { method: "POST", url: resourceUrl },
        },
      },
    };
  }
  return {
    kind: "verified",
    value: { verified: verified.verified, requirement, config, resourceUrl },
  };
}

/** Verify a raw payment header/string (MCP `arguments.payment`). */
export async function beginAgentX402FromPayload(
  paymentRaw: string,
  resourceUrl: string,
  deps?: { fetch?: typeof fetch; env?: Record<string, string | undefined> },
): Promise<AgentX402Begin> {
  const config = readX402Config(deps?.env ?? process.env);
  if (!agentX402PaymentsLive(config)) return { kind: "off" };
  const requirement = requirementsFor(resourceUrl, config);
  const verified = await verifyPayment(paymentRaw, requirement, {
    fetch: deps?.fetch ?? fetch,
    facilitatorUrl: config.facilitatorUrl,
    x402Version: config.version,
  });
  if (!verified.ok) {
    return {
      kind: "rejected",
      status: 402,
      body: {
        error_code: "payment_rejected",
        error: "payment_rejected",
        message: verified.error,
        credit_spent: false,
        retry_safe: true,
        accepts: [requirement],
      },
    };
  }
  return {
    kind: "verified",
    value: { verified: verified.verified, requirement, config, resourceUrl },
  };
}

/** Settle only after the paid resource was produced. Never call on failure. */
export async function settleAgentX402Payment(
  payment: AgentX402Verified,
  deps?: { fetch?: typeof fetch },
): Promise<SettleResult> {
  return settlePayment(payment.verified, payment.requirement, {
    fetch: deps?.fetch ?? fetch,
    facilitatorUrl: payment.config.facilitatorUrl,
    x402Version: payment.config.version,
  });
}

export function serializeAgentX402ForStore(payment: AgentX402Verified): {
  paymentPayload: unknown;
  requirement: PaymentRequirements;
  resourceUrl: string;
  version: 1 | 2;
  facilitatorUrl: string;
} {
  return {
    paymentPayload: payment.verified.paymentPayload,
    requirement: payment.requirement,
    resourceUrl: payment.resourceUrl,
    version: payment.config.version,
    facilitatorUrl: payment.config.facilitatorUrl,
  };
}

export function restoreAgentX402FromStore(raw: {
  paymentPayload: unknown;
  requirement: PaymentRequirements;
  resourceUrl: string;
  version: 1 | 2;
  facilitatorUrl: string;
}): AgentX402Verified {
  return {
    verified: { paymentPayload: raw.paymentPayload },
    requirement: raw.requirement,
    resourceUrl: raw.resourceUrl,
    config: {
      ...readX402Config(),
      version: raw.version,
      facilitatorUrl: raw.facilitatorUrl,
      payTo: raw.requirement.payTo,
      scheme: raw.requirement.scheme,
      network: raw.requirement.network,
      asset: raw.requirement.asset,
      priceAtomic: raw.requirement.maxAmountRequired,
      timeoutSeconds: raw.requirement.maxTimeoutSeconds,
      description: raw.requirement.description,
      agentPaymentsEnabled: true,
    },
  };
}
