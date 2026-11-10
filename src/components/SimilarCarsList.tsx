import { formatNumber, formatUsd } from "@/domain/format";
import type { SimilarCarView } from "@/domain/purchase-readiness";

/** Compact list of similar cars. Collapsed until the shopper opens it. No VINs. */
export function SimilarCarsList({
  cars,
  open = false,
  /** Total comps used for the price rating when the list is capped for display. */
  totalUsed,
}: {
  cars: readonly SimilarCarView[];
  /** Open on the report section, where this list is the point of the section. */
  open?: boolean;
  totalUsed?: number;
}) {
  const shown = cars.length;
  const total = typeof totalUsed === "number" && totalUsed > shown ? totalUsed : shown;
  const noun = total === 1 ? "car" : "cars";
  const summary =
    total > shown
      ? `Compared with ${total} similar ${noun} (showing ${shown})`
      : `Compared with ${total} similar ${noun}`;
  return (
    <details className="similar-cars" open={open}>
      <summary>{summary}</summary>
      {shown === 0 ? <p className="hint">No similar cars in this search were close enough to adjust.</p> : null}
      {shown > 0 ? (
        <ul>
          {cars.map((car, index) => (
            <li key={`${car.year}-${car.trim ?? "trim"}-${car.miles}-${car.askingUsd}-${index}`}>
              <p>
                {car.year} {car.trim ?? "trim not listed"}, {formatNumber(car.miles)} miles, asking {formatUsd(car.askingUsd)}
                . Adjusted to this car: {formatUsd(car.adjustedUsd)}.
                {car.sourceUrl ? (
                  <>
                    {" "}
                    <a href={car.sourceUrl} target="_blank" rel="noreferrer">
                      Source
                    </a>
                  </>
                ) : null}
              </p>
              {car.reasons.length > 0 ? (
                <ul>
                  {car.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}
