import { formatNumber, formatUsd } from "@/domain/format";
import type { SimilarCarView } from "@/domain/purchase-readiness";

/** Compact list of similar cars. Collapsed until the shopper opens it. No VINs. */
export function SimilarCarsList({
  cars,
  open = false,
}: {
  cars: readonly SimilarCarView[];
  /** Open on the report section, where this list is the point of the section. */
  open?: boolean;
}) {
  const count = cars.length;
  const noun = count === 1 ? "car" : "cars";
  return (
    <details className="similar-cars" open={open}>
      <summary>{`Compared with ${count} similar ${noun}`}</summary>
      {count === 0 ? <p className="hint">No similar cars in this search were close enough to adjust.</p> : null}
      {count > 0 ? (
        <ul>
          {cars.map((car, index) => (
            <li key={`${car.year}-${car.trim ?? "trim"}-${car.miles}-${car.askingUsd}-${index}`}>
              <p>
                {car.year} {car.trim ?? "trim not listed"}, {formatNumber(car.miles)} miles, asking {formatUsd(car.askingUsd)}
                . Adjusted to this car: {formatUsd(car.adjustedUsd)}.
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
