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
  extra: { facilitator: string; session: "kite-passport" };
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
};

export function readX402Config(env: Record<string, string | undefined> = process.env): X402Config {
  return {
    payTo: env.X402_PAY_TO?.trim() ?? "",
    scheme: env.X402_SCHEME?.trim() || "gokite-aa",
    network: env.X402_NETWORK?.trim() ?? "",
    asset: env.X402_ASSET?.trim() ?? "",
    facilitatorUrl: (env.X402_FACILITATOR_URL?.trim() || "https://facilitator.pieverse.io").replace(/\/$/, ""),
    priceAtomic: env.X402_PRICE_ATOMIC?.trim() || "1000000",
    timeoutSeconds: Number(env.X402_TIMEOUT_SECONDS ?? 120) || 120,
    description: env.X402_DESCRIPTION?.trim() || "AutoFlip full vehicle report",
  };
}

export function paymentsConfigured(config: X402Config): boolean {
  return Boolean(config.payTo && config.network && config.asset && config.facilitatorUrl && config.scheme);
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
    extra: { facilitator: config.facilitatorUrl, session: "kite-passport" },
  };
}

export function paymentHeader(headers: Headers): string | null {
  return headers.get("payment-signature") ?? headers.get("x-payment");
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
  deps: { fetch: typeof fetch; facilitatorUrl: string },
): Promise<VerifyResult> {
  const paymentPayload = decodePayment(header);
  if (!paymentPayload) return { ok: false, error: "Payment header was not valid JSON." };
  const verify = await postFacilitator(deps, "/verify", { x402Version: 1, paymentPayload, paymentRequirements: requirement });
  if (!verify.ok) return verify;
  const verifyBody = verify.body as { isValid?: boolean; invalidReason?: string };
  if (!verifyBody.isValid) return { ok: false, error: verifyBody.invalidReason || "Payment was not valid." };
  return { ok: true, verified: { paymentPayload } };
}

/** Settlement is deliberately separate so failed report generation does not charge the caller. */
export async function settlePayment(
  verified: VerifiedPayment,
  requirement: PaymentRequirements,
  deps: { fetch: typeof fetch; facilitatorUrl: string },
): Promise<SettleResult> {
  const settle = await postFacilitator(deps, "/settle", {
    x402Version: 1,
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
