/**
 * Buyer-facing Resale journal copy — never dump raw evidence tags or camelCase fields.
 */

/** Human label for a journal inputsUsed id. */
export function formatResaleJournalInputId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("pnl:")) return `P&L for ${trimmed.slice(4)}`;
  if (trimmed.startsWith("vin:")) return `VIN ${trimmed.slice(4)}`;
  if (trimmed.startsWith("check:")) return trimmed.slice(6).replace(/_/g, " ");
  if (trimmed.startsWith("direction:")) {
    const rest = trimmed.slice("direction:".length);
    const parts = rest.split(":");
    if (parts.length >= 2) return `Search direction ${parts.slice(1).join(":")}`;
    return `Search direction ${rest}`;
  }
  if (trimmed.startsWith("budgetUsd:")) {
    const amount = trimmed.slice("budgetUsd:".length);
    return `Budget $${amount}`;
  }
  switch (trimmed) {
    case "profitMidUsd":
      return "mid profit";
    case "compCount":
      return "similar listing count";
    case "flipDesiredProfitUsd":
      return "target profit";
    case "flipThinMarginUsd":
      return "thin margin";
    default:
      return trimmed;
  }
}

/** Strip raw tags / camelCase field names from decided/why lines shown to buyers. */
export function buyerSafeResaleJournalText(text: string): string {
  return text
    .replace(/\bvin:([A-Za-z0-9]+)/gi, "VIN $1")
    .replace(/\bpnl:([A-Za-z0-9]+)/gi, "P&L for $1")
    .replace(/\bcheck:([a-z0-9_]+)/gi, (_m, id: string) => id.replace(/_/g, " "))
    .replace(/\bdirection:([A-Za-z0-9_-]+(?::[^\s,;]+)?)/gi, (_m, rest: string) => {
      const parts = String(rest).split(":");
      return parts.length >= 2
        ? `search direction ${parts.slice(1).join(":")}`
        : `search direction ${rest}`;
    })
    .replace(/\bprofitMidUsd\b/g, "mid profit")
    .replace(/\bcompCount\b/g, "similar listing count")
    .replace(/\bflipDesiredProfitUsd\b/g, "target profit")
    .replace(/\bflipThinMarginUsd\b/g, "thin margin");
}
