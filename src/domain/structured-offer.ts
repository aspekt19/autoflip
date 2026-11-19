/**
 * submit_picks openingOffer and walkAway are the only offer figures rendered
 * on the run, the report, Radar, and Telegram.
 */
import { formatUsd } from "./format";

export type StructuredOffer = {
  openingOffer: number | null;
  walkAway: number | null;
};

export function renderStructuredOffer(offer: StructuredOffer): string {
  const opening =
    offer.openingOffer == null
      ? "Opening offer: not given."
      : `Opening offer: ${formatUsd(offer.openingOffer)}.`;
  const walk =
    offer.walkAway == null ? "" : ` Walk-away: ${formatUsd(offer.walkAway)}.`;
  return `${opening}${walk}`;
}

/** True when prose names a dollar offer (or a walk-away) instead of only repeating the ask. */
export function proseStatesOffer(text: string): boolean {
  if (!text.trim()) return false;
  const hasMoney = /\$\s?\d/.test(text) || /\b\d{2,3}\s?k\b/i.test(text);
  if (!hasMoney) return false;
  return /\b(offer|walk[-\s]?away|opening|i(?:'d| would) pay)\b/i.test(text);
}

export function structuredOfferRepairIssue(input: {
  prose: string;
  openingOffer: number | null;
  walkAway: number | null;
  field: string;
}): { field: string; message: string } | null {
  if (input.openingOffer != null || input.walkAway != null) return null;
  if (!proseStatesOffer(input.prose)) return null;
  return {
    field: input.field,
    message:
      "The prose names an offer but openingOffer and walkAway are empty. Set those structured fields and call submit_picks again. Rendered text, the report, Radar, and Telegram read only those fields.",
  };
}

function offerDollars(text: string): number[] {
  const amounts: number[] = [];
  const pattern = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    amounts.push(Number(match[1]!.replace(/,/g, "")));
  }
  return amounts;
}

/**
 * The structured offer is the only offer the shopper sees.
 * A prose sentence that names a different dollar offer is dropped.
 * Budget sentences that do not name an offer stay.
 */
export function alignRenderedOfferMessage(
  message: string | null | undefined,
  offerLabels: ReadonlyArray<string | null | undefined>,
): string | null {
  if (!message?.trim()) return message ?? null;
  const allowed = new Set(offerLabels.flatMap((label) => offerDollars(label ?? "")));
  const kept = message
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => {
      if (!proseStatesOffer(sentence)) return true;
      const amounts = offerDollars(sentence);
      if (amounts.length === 0) return false;
      return amounts.every((amount) => allowed.has(amount));
    });
  const next = kept.join(" ").trim();
  return next || null;
}

/** Same sentence on every surface that shows the offer. */
export function offerOnSurfaces(offer: StructuredOffer): {
  report: string;
  radar: string;
  telegram: string;
  rendered: string;
} {
  const rendered = renderStructuredOffer(offer);
  return { report: rendered, radar: rendered, telegram: rendered, rendered };
}
