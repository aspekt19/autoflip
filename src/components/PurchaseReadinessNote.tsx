import type { PurchaseReadiness } from "@/domain/purchase-readiness";

/** Shared buyer copy for a Find pick and a paid report. */
export function PurchaseReadinessNote({ view }: { view: PurchaseReadiness }) {
  return (
    <div className="purchase-readiness">
      <p>{view.otd.headline}</p>
      {view.otd.lines.map((line, index) => (
        <p key={`${index}-${line.slice(0, 24)}`}>{line}</p>
      ))}
      {view.sources.length > 0 ? (
        <p>
          Sources:{" "}
          {view.sources.map((source, index) => (
            <span key={source.href}>
              {index > 0 ? " · " : null}
              <a href={source.href} target="_blank" rel="noreferrer">
                {source.label}
              </a>
              {` (as of ${source.asOf})`}
            </span>
          ))}
        </p>
      ) : null}
      <p>{view.offer.openingLabel}</p>
      <p>{view.offer.walkAwayLabel}</p>
      <p>{view.offer.sentence}</p>
      {view.talkingPoints.length > 0 ? (
        <>
          <p>Negotiation</p>
          <ul>
            {view.talkingPoints.map((point) => (
              <li key={`${point.topic}-${point.text.slice(0, 40)}`}>{point.text}</li>
            ))}
          </ul>
        </>
      ) : null}
      {view.talkingPointsNote ? <p>{view.talkingPointsNote}</p> : null}
    </div>
  );
}
