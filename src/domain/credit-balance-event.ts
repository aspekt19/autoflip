/** Nav chip listens for this so a Find debit updates without a route change. */
export const CREDIT_BALANCE_EVENT = "af-credit-balance";

export function publishCreditBalance(balance: number): void {
  if (typeof window === "undefined" || !Number.isFinite(balance)) return;
  window.dispatchEvent(new CustomEvent(CREDIT_BALANCE_EVENT, { detail: balance }));
}
