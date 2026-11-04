import { coverageNote } from "@/domain/coverage";
import { fitHeadline, midProfitUsd, walkAwayAskingUsd } from "@/domain/fit";
import { formatNumber, formatPct, formatUsd, verdictLabel } from "@/domain/format";
import type { DecisionScene } from "@/domain/decision-note";
import type { FullReport } from "@/domain/types";
import { DecisionNote } from "./DecisionNote";

export function ReportView({ report }: { report: FullReport }) {
  const { computed } = report;
  const car = computed.subject;
  const title = `${car.year} ${car.make} ${car.model}${car.trim ? ` ${car.trim}` : ""}`;

  return (
    <article>
      {computed.sample ? (
        <p className="warn-box">
          <span className="file-chip">Sample</span> This report is built from the labeled evaluation fixture, not a live listings search.
        </p>
      ) : null}
      <p className="kicker">{computed.mode === "flip" ? "Resale view" : "Drive-it view"}</p>
      <h1>{title}</h1>
      <p className="support">
        {car.priceUsd === null ? "Price not listed" : formatUsd(car.priceUsd)}
        {" · "}
        {car.miles === null ? "Mileage not listed" : `${formatNumber(car.miles)} miles`}
        {car.city ? ` · ${car.city}, ${car.state ?? ""}` : ""}
        {car.dealer ? ` · ${car.dealer}` : ""}
      </p>
      <p className={`verdict-level badge ${computed.verdict}`}>{verdictLabel(computed.verdict)}</p>
      <p className="hint">
        {coverageNote({
          mode: computed.mode,
          sample: computed.sample,
          dealerListingCount: computed.comps.length,
          radiusMiles: null,
          historyOnListing: computed.subject.accidentCount !== null && computed.subject.ownerCount !== null,
        })}
      </p>
      <h2>{computed.mode === "flip" ? "Does this deal fit?" : "Does this car fit?"}</h2>
      <p>{fitHeadline(computed)}</p>
      <div className="split">
        <section>
          <h3>Facts</h3>
          <ul className="refuse">
            <li>Asking price and mileage come from the listing{computed.sample ? " fixture" : ""} or from what you typed for a VIN.</li>
            <li>
              {computed.recalls.length} NHTSA recall campaign{computed.recalls.length === 1 ? "" : "s"} for this year, make, and model. Source: NHTSA. This is not a count of open repairs on this VIN.
            </li>
            <li>
              {computed.complaintCount === null
                ? "NHTSA complaint count was unavailable."
                : `${computed.complaintCount} NHTSA complaints for this year, make, and model. Source: NHTSA. That is the model year, not this car's history.`}
            </li>
          </ul>
        </section>
        <section>
          <h3>Estimates</h3>
          <ul className="refuse">
            <li>
              {computed.fairValueUsd === null
                ? "No fair-value estimate. Not enough comparable listings."
                : `Fair value ${formatUsd(computed.fairValueUsd)} is an estimate from comparable asking prices, adjusted for mileage.`}
            </li>
            {computed.flip ? (
              <li>
                Conservative margin {formatUsd(computed.flip.marginUsd)} and a midpoint margin of {formatUsd(midProfitUsd(computed.flip))} use example fee and reconditioning assumptions, not a quote for this car.
              </li>
            ) : null}
          </ul>
          <h3>Still unknown</h3>
          {computed.dataNotes.length === 0 ? <p>Nothing else was flagged as missing.</p> : null}
          <ul className="refuse">
            {computed.dataNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </section>
      </div>
      {computed.score !== null ? <p className="hint">Price score {computed.score} / 100</p> : null}
      <div className="facts-row">
        <article>
          <b>{computed.fairValueUsd === null ? "—" : formatUsd(computed.fairValueUsd)}</b>
          <span>Fair value</span>
        </article>
        <article>
          <b>{computed.priceGap === null ? "—" : formatPct(computed.priceGap)}</b>
          <span>Asking vs fair value</span>
        </article>
        <article>
          <b>{computed.comps.length}</b>
          <span>Comparables</span>
        </article>
        <article>
          <b>
            {computed.fuel?.annualFuelCostUsd
              ? formatUsd(computed.fuel.annualFuelCostUsd)
              : computed.fuel?.annualFuelCostLowUsd != null && computed.fuel.annualFuelCostHighUsd != null
                ? `${formatUsd(computed.fuel.annualFuelCostLowUsd)}–${formatUsd(computed.fuel.annualFuelCostHighUsd)}`
                : "—"}
          </b>
          <span>EPA annual fuel</span>
        </article>
      </div>

      <div className="split" style={{ marginTop: 36 }}>
        <section>
          <h2>Plain-English read</h2>
          <p>{report.explanation}</p>
          <h3>Why this verdict</h3>
          <ul className="refuse">
            {computed.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </section>
        <section>
          <h2>Flags</h2>
          {computed.flags.length === 0 ? <p>No flags were raised from the fields we had.</p> : null}
          {computed.flags.map((flag) => (
            <p className={flag.level === "stop" ? "warn" : "warn-box"} key={`${flag.source}-${flag.text}`}>
              {flag.text}
            </p>
          ))}
          <h3>Questions for the dealer</h3>
          <ol className="refuse">
            {computed.questions.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ol>
        </section>
      </div>

      {computed.flip ? (
        <section>
          <h2>Resale math</h2>
          <p className="hint">
            The resale range is from current comparable asking prices, not closed sales. Fees and reconditioning are example assumptions, not a quote for this car.
          </p>
          <div className="facts-row">
            <article>
              <b>{formatUsd(computed.flip.targetBuyUsd)}</b>
              <span>Buy-at price for the target margin</span>
            </article>
            <article>
              <b>
                {formatUsd(computed.flip.resaleLowUsd)}–{formatUsd(computed.flip.resaleHighUsd)}
              </b>
              <span>Resale range from asking prices</span>
            </article>
            <article>
              <b>{formatUsd(computed.flip.marginUsd)}</b>
              <span>Conservative profit</span>
            </article>
            <article>
              <b>{formatUsd(walkAwayAskingUsd(computed.flip))}</b>
              <span>Walk-away asking price</span>
            </article>
          </div>
          <ul className="refuse">
            <li>Example title and fee assumption: {formatUsd(computed.flip.titleFeeUsd)}.</li>
            <li>Example reconditioning reserve: {formatUsd(computed.flip.reconUsd)}. Not an inspection.</li>
            <li>Sell-friction example: {Math.round(computed.flip.sellFriction * 100)}% off the comparable asking price.</li>
            <li>If you sell near the low end, profit is {formatUsd(computed.flip.marginUsd)}. Near the midpoint of asking prices, it is {formatUsd(midProfitUsd(computed.flip))}.</li>
          </ul>
          <p>{computed.flip.timeToSellNote}</p>
        </section>
      ) : null}

      <section>
        <h2>Comparables</h2>
        <p className="hint">Scope: {computed.compScope.replaceAll("_", " ")}. Prices are adjusted to this car’s mileage.</p>
        {computed.comps.length === 0 ? <p>No comparables qualified.</p> : null}
        {computed.comps.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Vehicle</th>
                <th>Miles</th>
                <th>Asking</th>
                <th>At this mileage</th>
                <th>Where</th>
              </tr>
            </thead>
            <tbody>
              {computed.comps.map((comp) => (
                <tr key={comp.vin}>
                  <td>
                    {comp.year} {comp.trim ?? "trim n/a"}
                    <div className="mono">{comp.vin}</div>
                  </td>
                  <td>{formatNumber(comp.miles)}</td>
                  <td>{formatUsd(comp.priceUsd)}</td>
                  <td>{formatUsd(comp.adjustedPriceUsd)}</td>
                  <td>{[comp.city, comp.state].filter(Boolean).join(", ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>

      <section>
        <h2>This car&apos;s history</h2>
        <p className="hint">Source: history flags on the listing. This is not the recall list and not the complaint count.</p>
        <ul className="refuse">
          {computed.history.lines.length === 0 ? <li>No history flags were on the listing.</li> : null}
          {computed.history.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <h2>Recall campaigns</h2>
        <p className="hint">Source: NHTSA. These campaigns match the year, make, and model. They are not a record of what was fixed on this VIN.</p>
        <ul className="refuse">
          <li>
            {computed.recalls.length === 0
              ? "NHTSA returned no campaigns for this year, make, and model."
              : `${computed.recalls.length} NHTSA campaign${computed.recalls.length === 1 ? "" : "s"}.`}
          </li>
        </ul>
        <h2>Complaints about this model year</h2>
        <p className="hint">Source: NHTSA complaints. This is a count for the model year, not this car.</p>
        <ul className="refuse">
          {computed.complaintCount === null ? (
            <li>Complaint count was unavailable.</li>
          ) : (
            <li>NHTSA complaint count for this year, make, and model: {computed.complaintCount}. This is not a failure rate.</li>
          )}
        </ul>
        <p className="hint">
          {computed.distanceToSearchZipMiles === null
            ? "Distance from the search ZIP was not calculated."
            : `About ${formatNumber(computed.distanceToSearchZipMiles)} miles from the search ZIP. Source: Census geocoder.`}
        </p>
        {computed.recalls.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Component</th>
                <th>Park outside</th>
              </tr>
            </thead>
            <tbody>
              {computed.recalls.map((recall) => (
                <tr key={recall.campaignNumber}>
                  <td>{recall.campaignNumber}</td>
                  <td>
                    {recall.component}
                    <div className="hint">{recall.summary}</div>
                  </td>
                  <td>{recall.parkIt || recall.parkOutSide ? "Yes" : "No"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {car.vdp ? (
          <p>
            <a href={car.vdp}>Open the dealer listing</a>
          </p>
        ) : null}
        {computed.dataNotes.length > 0 ? (
          <>
            <h3>Missing or unused data</h3>
            <ul className="refuse">
              {computed.dataNotes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </>
        ) : null}
      </section>

      <section className="ask">
        <h2>How to read this</h2>
        <p className="hint">
          We show which data the verdict is based on. We separate facts from estimates. We flag what still needs checking before you buy.
        </p>
        <DecisionNote scene={reportScene(report)} proofs={report.proof.servChecks ?? []} />
      </section>
    </article>
  );
}

function reportScene(report: FullReport): DecisionScene {
  const purposes = (report.proof.servChecks ?? []).map((item) => item.purpose);
  if (purposes.includes("check_guard")) return "check";
  return "report";
}
