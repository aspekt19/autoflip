import { PRICE_RATING_HOW, type PriceBadge } from "@/domain/price-badge";

export function PriceBadgeView({ badge }: { badge: PriceBadge }) {
  return (
    <p className={`price-badge ${badge.tone}`}>
      <strong>{badge.label}</strong>
      {badge.deltaLabel ? <span> · {badge.deltaLabel}</span> : null}
      {badge.sampleNote ? <span className="hint"> · {badge.sampleNote}</span> : null}
    </p>
  );
}

export function PriceRatingHow() {
  return (
    <details className="decision">
      <summary className="type-brand">How we rate prices</summary>
      <p>{PRICE_RATING_HOW}</p>
    </details>
  );
}
