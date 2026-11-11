/** Nav chip listens for this so a Find debit updates without a route change. */
export const CREDIT_BALANCE_EVENT = "af-credit-balance";

export function publishCreditBalance(balance: number): void {
  if (typeof window === "undefined" || !Number.isFinite(balance)) return;
  window.dispatchEvent(new CustomEvent(CREDIT_BALANCE_EVENT, { detail: balance }));
}

/**
 * Re-read GET /api/account and push the real balance to the header chip.
 * Prefer this after Find/Check settle so the nav count matches the ledger
 * even when the action response omitted `balance`.
 */
export async function refreshPublishedCreditBalance(): Promise<number | null> {
  if (typeof window === "undefined") return null;
  try {
    const response = await fetch("/api/account", { cache: "no-store" });
    const body = (await response.json()) as { credits?: number };
    if (typeof body.credits === "number" && Number.isFinite(body.credits)) {
      publishCreditBalance(body.credits);
      return body.credits;
    }
  } catch {
    /* header keeps prior count */
  }
  return null;
}
