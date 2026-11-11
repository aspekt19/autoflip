export type PaymentRequirements = {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra: { facilitator: string; session?: "kite-passport" | string; name?: string; version?: string };
};

/** x402 v2 PaymentRequired body (also base64 in PAYMENT-REQUIRED header). */
export type PaymentRequiredV2 = {
  x402Version: 2;
  error: string;
  resource: { url: string; description: string; mimeType: string };
  accepts: Array<{
    scheme: string;
    network: string;
    maxAmountRequired: string;
    amount?: string;
    asset: string;
    payTo: string;
    maxTimeoutSeconds: number;
    extra?: Record<string, unknown>;
  }>;
};

export type X402Config = {
  payTo: string;
  scheme: string;
  network: string;
  asset: string;
  facilitatorUrl: string;
  priceAtomic: string;
  timeoutSeconds: number;
  description: string;
  /** Protocol version for agent check/find payments. Default 2. */
  version: 1 | 2;
  /**
   * Agent pay-per-check / pay-per-find via x402.
   * OFF by default until Yura approves enabling (`X402_AGENT_PAYMENTS_ENABLED=1`).
   */
  agentPaymentsEnabled: boolean;
};

function flagOn(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** USDC on Base mainnet — default asset when configuring agent x402 v2. */
export const X402_USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const X402_NETWORK_BASE = "eip155:8453";

export function readX402Config(env: Record<string, string | undefined> = process.env): X402Config {
  const versionRaw = env.X402_VERSION?.trim();
  const version: 1 | 2 = versionRaw === "1" ? 1 : 2;
  return {
    payTo: env.X402_PAY_TO?.trim() ?? "",
    scheme: env.X402_SCHEME?.trim() || (version === 2 ? "exact" : "gokite-aa"),
    network: env.X402_NETWORK?.trim() || (version === 2 ? X402_NETWORK_BASE : ""),
    asset: env.X402_ASSET?.trim() || (version === 2 ? X402_USDC_BASE : ""),
    facilitatorUrl: (env.X402_FACILITATOR_URL?.trim() || "https://facilitator.pieverse.io").replace(/\/$/, ""),
    priceAtomic: env.X402_PRICE_ATOMIC?.trim() || "1000000",
    timeoutSeconds: Number(env.X402_TIMEOUT_SECONDS ?? 120) || 120,
    description: env.X402_DESCRIPTION?.trim() || "Lemonless full vehicle report",
    version,
    agentPaymentsEnabled: flagOn(env.X402_AGENT_PAYMENTS_ENABLED),
  };
}

export function paymentsConfigured(config: X402Config): boolean {
  return Boolean(config.payTo && config.network && config.asset && config.facilitatorUrl && config.scheme);
}

/** True only when Yura-approved flag is on AND payee/network/asset are set. */
export function agentX402PaymentsLive(config: X402Config = readX402Config()): boolean {
  return config.agentPaymentsEnabled && paymentsConfigured(config);
}

export function requirementsFor(resource: string, config: X402Config): PaymentRequirements {
  return {
    scheme: config.scheme,
    network: config.network,
    maxAmountRequired: config.priceAtomic,
    resource,
    description: config.description,
    mimeType: "application/json",
    payTo: config.payTo,
    maxTimeoutSeconds: config.timeoutSeconds,
    asset: config.asset,
    extra:
      config.version === 2
        ? {
            facilitator: config.facilitatorUrl,
            name: "USDC",
            version: "2",
          }
        : { facilitator: config.facilitatorUrl, session: "kite-passport" },
  };
}

/** Build x402 v2 PaymentRequired for HTTP 402 + PAYMENT-REQUIRED header. */
export function paymentRequiredV2(
  resourceUrl: string,
  config: X402Config,
  error = "Payment required to continue.",
): PaymentRequiredV2 {
  const accept = {
    scheme: config.scheme || "exact",
    network: config.network || X402_NETWORK_BASE,
    maxAmountRequired: config.priceAtomic,
    amount: config.priceAtomic,
    asset: config.asset || X402_USDC_BASE,
    payTo: config.payTo,
    maxTimeoutSeconds: config.timeoutSeconds,
    extra: {
      facilitator: config.facilitatorUrl,
      name: "USDC",
      version: "2",
    },
  };
  return {
    x402Version: 2,
    error,
    resource: {
      url: resourceUrl,
      description: config.description,
      mimeType: "application/json",
    },
    accepts: [accept],
  };
}

/** Encode PaymentRequired for the PAYMENT-REQUIRED response header (x402 v2). */
export function encodePaymentRequiredHeader(body: PaymentRequiredV2): string {
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64");
}

/**
 * Standard 402 response for agent check/find when x402 agent payments are enabled
 * and no payment signature was supplied. Disabled by default.
 */
export function paymentRequiredResponse(
  resourceUrl: string,
  config: X402Config,
  message = "Payment required.",
): Response {
  const body = paymentRequiredV2(resourceUrl, config, message);
  const encoded = encodePaymentRequiredHeader(body);
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: {
      "Content-Type": "application/json",
      "PAYMENT-REQUIRED": encoded,
      "X-Payment-Required": encoded,
      "Cache-Control": "no-store",
    },
  });
}

export function paymentHeader(headers: Headers): string | null {
  return (
    headers.get("payment-signature") ??
    headers.get("PAYMENT-SIGNATURE") ??
    headers.get("x-payment") ??
    headers.get("X-PAYMENT")
  );
}

export function decodePayment(header: string): unknown | null {
  try {
    const json = Buffer.from(header, "base64").toString("utf8");
    return JSON.parse(json) as unknown;
  } catch {
    try {
      return JSON.parse(header) as unknown;
    } catch {
      return null;
    }
  }
}

export type VerifiedPayment = { paymentPayload: unknown };
export type SettleResult =
  | { ok: true; txHash: string | null }
  | { ok: false; error: string };
export type VerifyResult =
  | { ok: true; verified: VerifiedPayment }
  | { ok: false; error: string };

/** Verify first; callers should only settle after the paid resource has been produced successfully. */
export async function verifyPayment(
  header: string,
  requirement: PaymentRequirements,
  deps: { fetch: typeof fetch; facilitatorUrl: string; x402Version?: 1 | 2 },
): Promise<VerifyResult> {
  const paymentPayload = decodePayment(header);
  if (!paymentPayload) return { ok: false, error: "Payment header was not valid JSON." };
  const x402Version = deps.x402Version ?? 1;
  const verify = await postFacilitator(deps, "/verify", {
    x402Version,
    paymentPayload,
    paymentRequirements: requirement,
  });
  if (!verify.ok) return verify;
  const verifyBody = verify.body as { isValid?: boolean; invalidReason?: string };
  if (!verifyBody.isValid) return { ok: false, error: verifyBody.invalidReason || "Payment was not valid." };
  return { ok: true, verified: { paymentPayload } };
}

/** Settlement is deliberately separate so failed report generation does not charge the caller. */
export async function settlePayment(
  verified: VerifiedPayment,
  requirement: PaymentRequirements,
  deps: { fetch: typeof fetch; facilitatorUrl: string; x402Version?: 1 | 2 },
): Promise<SettleResult> {
  const x402Version = deps.x402Version ?? 1;
  const settle = await postFacilitator(deps, "/settle", {
    x402Version,
    paymentPayload: verified.paymentPayload,
    paymentRequirements: requirement,
  });
  if (!settle.ok) return settle;
  const settleBody = settle.body as { success?: boolean; txHash?: string; error?: string };
  if (!settleBody.success) return { ok: false, error: settleBody.error || "Payment could not be settled." };
  return { ok: true, txHash: settleBody.txHash ?? null };
}

/** Backwards-compatible helper for callers that intentionally need immediate settlement. */
export async function verifyAndSettle(
  header: string,
  requirement: PaymentRequirements,
  deps: { fetch: typeof fetch; facilitatorUrl: string },
): Promise<SettleResult> {
  const verified = await verifyPayment(header, requirement, deps);
  if (!verified.ok) return verified;
  return settlePayment(verified.verified, requirement, deps);
}

async function postFacilitator(
  deps: { fetch: typeof fetch; facilitatorUrl: string },
  path: string,
  body: unknown,
): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  try {
    const response = await deps.fetch(`${deps.facilitatorUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok || json === null) {
      return { ok: false, error: "The payment facilitator rejected the request." };
    }
    return { ok: true, body: json };
  } catch {
    return { ok: false, error: "The payment facilitator did not respond." };
  }
}
