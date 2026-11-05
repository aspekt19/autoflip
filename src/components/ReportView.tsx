import { CoverageNote } from "./CoverageNote";
import { fitHeadline, midProfitUsd, walkAwayAskingUsd } from "@/domain/fit";
import { summaryLine } from "@/domain/summary-line";
import { formatNumber, formatPct, formatUsd, verdictLabel } from "@/domain/format";
import type { DecisionScene } from "@/domain/decision-note";
import type { FullReport } from "@/domain/types";
import { DecisionNote } from "./DecisionNote";
import { FavoriteButton } from "./FavoriteButton";

export function ReportView({ report }: { report: FullReport }) {
  const { computed } = report;
  const car = computed.subject;
  const title = `${car.year} ${car.make} ${car.model}${car.trim ? ` ${car.trim}` : ""}`;
  const decision = summaryLine({
    mode: computed.mode,
    verdict: computed.verdict,
    fairValueUsd: computed.fairValueUsd,
    flip: computed.flip,
  });

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
      {!computed.sample ? <FavoriteButton reportId={report.id} /> : null}
      <nav className="report-toc" aria-label="Report sections">
        <a href="#report-summary">Verdict</a>
        <a href="#report-facts">Facts &amp; estimates</a>
        <a href="#report-comparables">Comparables</a>
        <a href="#report-history">History &amp; recalls</a>
        <a href="#report-method">Method</a>
        <a href="/reports">My reports</a>
      </nav>
      <p className={`verdict-level badge ${computed.verdict}`}>{verdictLabel(computed.verdict)}</p>
      <CoverageNote
        input={{
          mode: computed.mode,
          sample: computed.sample,
          dealerListingCount: computed.comps.length,
          radiusMiles: null,
          historyOnListing: computed.subject.accidentCount !== null && computed.subject.ownerCount !== null,
        }}
      />
      <RiskSummary flags={computed.flags} openParkIt={computed.openParkIt} />
      <h2 id="report-summary">{computed.mode === "flip" ? "Does this deal fit?" : "Does this car fit?"}</h2>
      <p className="summary-line">{decision.line}</p>
      <p>{decision.detail}</p>
      <p>{fitHeadline(computed)}</p>
      <div className="split" id="report-facts">
        <section>
          <h3>Facts</h3>
          <ul className="refuse">
            <li>Asking price and mileage come from the listing{computed.sample ? " fixture" : ""} or from what you typed for a VIN.</li>
            <li>
              {!computed.recallsAvailable
                ? "NHTSA recall lookup was unavailable. No campaign count can be reported."
                : `${computed.recalls.length} NHTSA recall campaign${computed.recalls.length === 1 ? "" : "s"} for this year, make, and model. This is not a count of open repairs on this VIN.`}
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
          {report.proof.explanationSource === "unavailable" ? (
            <p className="hint">The written check did not finish. This verdict is calculated from the listing figures.</p>
          ) : null}
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

      <section id="report-comparables">
        <h2>Comparables</h2>
        <p className="hint">Scope: {computed.compScope.replaceAll("_", " ")}. Prices are adjusted to this car’s mileage.</p>
        {computed.comps.length === 0 ? <p>No comparables qualified.</p> : null}
        {computed.comps.length > 0 ? (
          <div className="table-scroll"><table>
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
          </table></div>
        ) : null}
      </section>

      <section id="report-history">
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
            {!computed.recallsAvailable
              ? "NHTSA could not return usable recall data. Check this VIN directly with NHTSA and the dealer before purchase."
              : computed.recalls.length === 0
                ? "NHTSA returned no campaigns for this year, make, and model."
                : `${computed.recalls.length} NHTSA campaign${computed.recalls.length === 1 ? "" : "s"}.`}
          </li>
        </ul>
        <h2>Verify this VIN with outside records</h2>
        <p className="hint">AutoFlip does not have a complete title, theft, flood, or service-history database. Run the VIN through these independent sources before purchase.</p>
        <ul className="refuse">
          <li>
            <a href={`https://www.nhtsa.gov/recalls?vin=${encodeURIComponent(car.vin)}`} target="_blank" rel="noreferrer">
              NHTSA VIN recall lookup
            </a>
            {" — checks unrepaired recalls associated with this specific VIN."}
          </li>
          <li>
            <a href="https://www.nicb.org/vincheck" target="_blank" rel="noreferrer">
              NICB VINCheck (free)
            </a>
            {" — checks participating insurers’ reports of theft not recovered, salvage, and flood damage. Coverage is limited; a clean result is not a complete history report."}
          </li>
          <li>
            <a href="https://vehiclehistory.bja.ojp.gov/nmvtis_vehiclehistory" target="_blank" rel="noreferrer">
              DOJ NMVTIS-approved history providers
            </a>
            {" — offers paid reports with title-brand, odometer, and salvage information from approved providers."}
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
          <div className="table-scroll"><table>
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
          </table></div>
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

      <section className="ask" id="report-method">
        <h2>How to read this</h2>
        <p className="hint">
          We show which data the verdict is based on. We separate facts from estimates. We flag what still needs checking before you buy.
        </p>
        <DecisionNote scene={reportScene(report)} proofs={report.proof.servChecks ?? []} />
        <p className="btn-row">
          <a className="quiet" href="/reports">My report history</a>
          <a className="quiet" href="/find">Find another car</a>
          <a className="quiet" href="/check">Check another listing</a>
          <a className="ghost" href="/radar">Deal Radar</a>
        </p>
      </section>
    </article>
  );
}

function reportScene(report: FullReport): DecisionScene {
  const purposes = (report.proof.servChecks ?? []).map((item) => item.purpose);
  if (purposes.includes("check_guard")) return "check";
  return "report";
}


function RiskSummary({ flags, openParkIt }: { flags: FullReport["computed"]["flags"]; openParkIt: boolean }) {
  const stop = flags.filter((flag) => flag.level === "stop").length;
  const caution = flags.filter((flag) => flag.level === "caution").length;
  const notes = flags.filter((flag) => flag.level === "note").length;
  return (
    <section className={`risk-summary ${stop ? "risk-has-stop" : caution ? "risk-has-caution" : ""}`} aria-labelledby="risk-summary-title">
      <h2 id="risk-summary-title">Risk &amp; warning summary</h2>
      <div className="risk-counts" aria-label="Risk flag counts">
        <span className="risk-count stop">{stop} stop</span>
        <span className="risk-count caution">{caution} caution</span>
        <span className="risk-count note">{notes} notes</span>
      </div>
      {openParkIt ? (
        <p className="risk-primary">A park-it or park-outside campaign matched this model year, make and model. Do not drive until the exact VIN's recall status and completed repair are confirmed.</p>
      ) : null}
      {flags.length === 0 ? (
        <p className="hint">No risk flags were returned from the available data. Missing records, undisclosed damage and mechanical issues may still exist.</p>
      ) : (
        <p className="hint">The detailed flags and their sources appear below. These are screening signals, not a physical inspection or a complete vehicle-history report.</p>
      )}
    </section>
  );
}
