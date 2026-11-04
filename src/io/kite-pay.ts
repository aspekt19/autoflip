export const KITE_PAYMENT_ENV = [
  "KITE_PASSPORT_BASE_URL",
  "KITE_SESSION_ID",
  "KITE_SESSION_TOKEN",
  "X402_PAY_TO",
  "X402_ASSET",
  "X402_NETWORK",
] as const;

export type PaymentLog = {
  status: "not_configured" | "paid" | "failed";
  missing: string[];
  tx: string | null;
  detail: string;
  costAtomic: string | null;
  network: string | null;
};

export function missingPaymentEnv(env: Record<string, string | undefined>): string[] {
  return KITE_PAYMENT_ENV.filter((name) => !env[name]?.trim());
}

function pickTx(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["txHash", "tx_hash", "transactionHash", "transaction_hash", "hash"]) {
    if (typeof record[key] === "string" && record[key]) return record[key] as string;
  }
  for (const nested of [record.payment, record.result, record.data]) {
    const found = pickTx(nested);
    if (found) return found;
  }
  return null;
}

export async function payRadarTicket(input: {
  ticketUrl: string;
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
}): Promise<PaymentLog> {
  const missing = missingPaymentEnv(input.env);
  const network = input.env.X402_NETWORK?.trim() ?? null;
  const costAtomic = input.env.X402_PRICE_ATOMIC?.trim() || "1000000000000000000";
  if (missing.length > 0) {
    return {
      status: "not_configured",
      missing,
      tx: null,
      detail: "The testnet session payment was not attempted.",
      costAtomic: null,
      network,
    };
  }
  if (network !== "kite-testnet") {
    return {
      status: "failed",
      missing: [],
      tx: null,
      detail: "Refused: X402_NETWORK must be kite-testnet. No payment was sent.",
      costAtomic,
      network,
    };
  }
  const base = input.env.KITE_PASSPORT_BASE_URL!.replace(/\/$/, "");
  try {
    const response = await input.fetchImpl(`${base}/v1/agent/session/execute`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.env.KITE_SESSION_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session_id: input.env.KITE_SESSION_ID,
        url: input.ticketUrl,
        method: "POST",
      }),
      signal: AbortSignal.timeout(45_000),
    });
    const body: unknown = await response.json().catch(() => null);
    const tx = pickTx(body);
    if (!response.ok) {
      return {
        status: "failed",
        missing: [],
        tx,
        detail: `Session execute returned ${response.status}.`,
        costAtomic,
        network,
      };
    }
    return {
      status: "paid",
      missing: [],
      tx,
      detail: tx ? "Session execute returned a transaction reference." : "Session execute succeeded. It did not include a transaction reference.",
      costAtomic,
      network,
    };
  } catch {
    return {
      status: "failed",
      missing: [],
      tx: null,
      detail: "Session execute did not respond.",
      costAtomic,
      network,
    };
  }
}
