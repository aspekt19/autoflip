import { formatNumber, formatPct, formatUsd, verdictLabel } from "@/domain/format";
import type { FullReport } from "@/domain/types";

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
            Range comes from current comparable asking prices, not closed sales. Fees and reconditioning are model assumptions, printed below.
          </p>
          <div className="facts-row">
            <article>
              <b>
                {formatUsd(computed.flip.resaleLowUsd)}–{formatUsd(computed.flip.resaleHighUsd)}
              </b>
              <span>Asking-price range</span>
            </article>
            <article>
              <b>{formatUsd(computed.flip.marginUsd)}</b>
              <span>Conservative margin</span>
            </article>
            <article>
              <b>{formatUsd(computed.flip.targetBuyUsd)}</b>
              <span>Buy target</span>
            </article>
            <article>
              <b>{computed.flip.timeToSellRisk}</b>
              <span>Time-to-sell risk</span>
            </article>
          </div>
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
        <h2>History, recalls, fuel</h2>
        <ul className="refuse">
          {computed.history.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
          <li>
            {computed.recalls.length === 0
              ? "NHTSA returned no campaigns for this year, make, and model."
              : `${computed.recalls.length} NHTSA campaign${computed.recalls.length === 1 ? "" : "s"}.`}
          </li>
          {computed.complaintCount === null ? (
            <li>Complaint count was unavailable.</li>
          ) : (
            <li>NHTSA complaint count for this year, make, and model: {computed.complaintCount}. This is not a failure rate.</li>
          )}
          {computed.distanceToSearchZipMiles === null ? (
            <li>Distance from the search ZIP was not calculated.</li>
          ) : (
            <li>About {formatNumber(computed.distanceToSearchZipMiles)} miles from the search ZIP.</li>
          )}
        </ul>
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
        <h2>Proof of AI</h2>
        <p className="hint">
          The verdict and every dollar figure come from the tools below. The written summary is allowed to explain those figures and is dropped if it introduces a number that is not in the tool output.
        </p>
        <p>
          Inputs hash <code>{report.proof.inputsHash}</code>
        </p>
        <p>
          Model <code>{report.proof.model ?? "none — template summary"}</code> · prompt <code>{report.proof.promptVersion}</code> · summary source{" "}
          <code>{report.proof.explanationSource}</code>
        </p>
        <p>
          Shadow check: requested {report.proof.shadow.requested ? "yes" : "no"}, outcome <code>{report.proof.shadow.outcome}</code>, max iterations{" "}
          {report.proof.shadow.maxIterations}.
        </p>
        <ul className="step-list">
          {report.proof.steps.map((step) => (
            <li key={`${step.id}-${step.status}`}>
              {step.id}: {step.status}
            </li>
          ))}
        </ul>
        <details>
          <summary>Tool outputs</summary>
          <pre className="doc">{JSON.stringify(report.proof.toolOutputs, null, 2)}</pre>
        </details>
        <details>
          <summary>Model assumptions used</summary>
          <pre className="doc">{JSON.stringify(computed.assumptions, null, 2)}</pre>
        </details>
      </section>
    </article>
  );
}
