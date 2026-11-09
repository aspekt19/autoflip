import {
  formatBuyerProofLine,
  formatBuyerServCheckSummary,
  plainBuyerPhrase,
  plainCompScope,
  plainDecisionAction,
  plainDecisionSource,
  plainExplanationSource,
  plainFlagSource,
  plainGateStatus,
} from "@/domain/find-buyer-copy";
import { CoverageNote } from "./CoverageNote";
import { fitHeadline, midProfitUsd, walkAwayAskingUsd } from "@/domain/fit";
import { summaryLine } from "@/domain/summary-line";
import { formatNumber, formatPct, formatUsd, verdictLabel } from "@/domain/format";
import type { DecisionScene } from "@/domain/decision-note";
import type { FullReport } from "@/domain/types";
import { DecisionNote } from "./DecisionNote";
import { resolveProductFlags } from "@/domain/product-flags";
import { FavoriteButton } from "./FavoriteButton";
import { PurchaseReadinessNote } from "./PurchaseReadinessNote";
import { SimilarCarsList } from "./SimilarCarsList";
import { omitQuestionsCoveredByTalkingPoints, purchaseReadinessForReport } from "@/domain/purchase-readiness";

export function ReportView({ report }: { report: FullReport }) {
  const { computed } = report;
  const readinessNow = Number.isNaN(Date.parse(report.createdAt))
    ? new Date("2026-11-09T00:00:00Z")
    : new Date(report.createdAt);
  const purchaseReadiness = purchaseReadinessForReport(computed, readinessNow);
  const dealerQuestions = omitQuestionsCoveredByTalkingPoints(
    computed.questions,
    purchaseReadiness.talkingPoints,
  );
  const car = computed.subject;
  const title = `${car.year} ${car.make} ${car.model}${car.trim ? ` ${car.trim}` : ""}`;
  const decision = summaryLine({
    mode: computed.mode,
    verdict: computed.verdict,
    fairValueUsd: computed.fairValueUsd,
    flip: computed.flip,
    openParkIt: computed.openParkIt,
    withholdReason: computed.decision?.withholdReason,
  });
  const missingData = computed.dataNotes;
  const nhtsaRecallCheck = computed.sourceChecks?.find((item) => item.source === "NHTSA recalls by model year");
  const nhtsaComplaintCheck = computed.sourceChecks?.find((item) => item.source === "NHTSA complaints");
  const formatCheckedAt = (iso: string | null | undefined) =>
    iso
      ? new Intl.DateTimeFormat("en-US", { dateStyle: "short", timeStyle: "short", timeZone: "UTC" }).format(new Date(iso))
      : "Not recorded";

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
        <a href="#report-risks">Risks</a>
        <a href="#report-summary">Verdict</a>
        <a href="#report-checked">How checked</a>
        <a href="#report-facts">Facts &amp; estimates</a>
        <a href="#report-comparables">Similar listings</a>
        <a href="#report-history">History &amp; recalls</a>
        <a href="#report-sources">Sources</a>
        <a href="#report-proof">Proof of AI</a>
        <a href="/reports">My reports</a>
      </nav>
      <p className={`verdict-level badge ${computed.verdict}`}>{verdictLabel(computed.verdict)}</p>
      <p className="hint lemonless-disclaimer">
        Lemonless helps you avoid lemons. It is not a guarantee, an inspection, or a vehicle history report — always get a
        pre-purchase inspection.
      </p>
      {computed.verdict === "withheld" ? (
        <p className="risk-primary" role="alert">
          {plainBuyerPhrase(
            computed.decision?.withholdReason ??
              "Verdict withheld: there is not enough verified evidence for a buy, negotiate, or pass decision.",
          )}
        </p>
      ) : null}
      {computed.decision ? (
        <div className="decision-provenance" aria-label="How this verdict was chosen">
          <p className="hint">
            {computed.decision.source === "gates_withheld"
              ? "Ordered checks found insufficient evidence. Lemonless withheld a verdict instead of guessing."
              : computed.decision.source === "serv"
                ? "AI review chose this action from the computed facts. Code checked hard safety gates afterward."
                : computed.decision.source === "guardrail_clamp"
                  ? "AI review proposed an action that code clamped under hard safety gates."
                  : computed.decision.source === "deterministic_fallback"
                    ? "AI review did not finish in time. This action is the labeled code fallback under the same gates."
                    : "AI review was not configured for this report. This action is the labeled code baseline under hard gates."}
          </p>
          {computed.decision.servChoice && computed.decision.servChoice !== computed.decision.action ? (
            <p className="hint">
              AI review chose {plainDecisionAction(computed.decision.servChoice)}; final action is {plainDecisionAction(computed.decision.action)}.
            </p>
          ) : null}
          {computed.decision.overrideReasons.length > 0 ? (
            <ul className="refuse">
              {computed.decision.overrideReasons.map((reason) => (
                <li key={reason}>{plainBuyerPhrase(reason)}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <CoverageNote
        input={{
          mode: computed.mode,
          sample: computed.sample,
          dealerListingCount: computed.comps.length,
          radiusMiles: null,
          historyOnListing: computed.subject.accidentCount !== null && computed.subject.ownerCount !== null,
        }}
      />
      <RiskSummary
        flags={computed.flags}
        openParkIt={computed.openParkIt}
        openParkOutside={Boolean(computed.openParkOutside)}
        missingData={missingData}
      />
      <h2 id="report-summary">{computed.mode === "flip" ? "Does this deal fit?" : "Does this car fit?"}</h2>
      <p className="summary-line">{decision.line}</p>
      <p>{decision.detail}</p>
      {computed.verdict !== "withheld" ? <p>{fitHeadline(computed)}</p> : null}

      <section id="report-checked" className="how-checked" aria-labelledby="how-checked-title">
        <h2 id="how-checked-title">How this was checked</h2>
        <p className="hint">
          Dollar amounts, percentages, and scores come from code. AI review may choose an action and write the explanation; it cannot invent a number.{" "}
          <a href="#report-proof">Open this report&apos;s Proof of AI record</a>.
        </p>
        <ul className="refuse">
          <li>
            <b>From code:</b> fair value {computed.fairValueUsd === null ? "Not enough similar cars" : formatUsd(computed.fairValueUsd)}, asking gap{" "}
            {computed.priceGap === null ? "—" : formatPct(computed.priceGap)}, {computed.comps.length} similar listings
            {computed.score !== null ? `, price score ${computed.score}/100` : ""}.
          </li>
          <li>
            <b>Ordered gates:</b>{" "}
            {computed.decision?.gates?.length
              ? computed.decision.gates.map((gate) => `${plainBuyerPhrase(gate.id)} (${plainGateStatus(gate.status)})`).join(" → ")
              : "not recorded on this saved report"}
            .
          </li>
          <li>
            <b>AI review:</b>{" "}
            {(report.proof.servChecks ?? []).map((check) => formatBuyerServCheckSummary(check)).join("; ") ||
              "no AI review steps recorded (template or offline report)"}
            .
          </li>
          <li>
            <b>Final action:</b> {plainDecisionAction(computed.decision?.action ?? computed.verdict)}
            {computed.decision?.source ? ` (${plainDecisionSource(computed.decision.source)})` : ""}.
          </li>
        </ul>
      </section>

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
                ? "No fair-value estimate. Not enough similar listings, or the adjusted prices are too far apart."
                : `Fair value ${formatUsd(computed.fairValueUsd)} is the middle of similar asking prices from this search, adjusted for mileage, model year, trim, and listing history flags. ${
                    computed.fairRangeLowUsd != null && computed.fairRangeHighUsd != null
                      ? `The middle half runs from ${formatUsd(computed.fairRangeLowUsd)} to ${formatUsd(computed.fairRangeHighUsd)}. `
                      : ""
                  }${computed.fairConfidence === "rough" ? "This estimate is rough. " : ""}These are asking prices, not sold prices. The Find price badge, the ranking, the offer, Compare, and alerts use this same fair value.`}
            </li>
            {computed.flip ? (
              <li>
                Conservative margin {formatUsd(computed.flip.marginUsd)} and a midpoint margin of {formatUsd(midProfitUsd(computed.flip))} use example fee and reconditioning assumptions, not a quote for this car.
              </li>
            ) : null}
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
          <span>Similar listings</span>
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
          <h3>Out-the-door estimate</h3>
          <PurchaseReadinessNote view={purchaseReadiness} />
          <h3>Questions for the dealer</h3>
          <ol className="refuse">
            {dealerQuestions.map((question) => (
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
            <li>Sell-friction example: {Math.round(computed.flip.sellFriction * 100)}% off the similar-listing asking price.</li>
            <li>If you sell near the low end, profit is {formatUsd(computed.flip.marginUsd)}. Near the midpoint of asking prices, it is {formatUsd(midProfitUsd(computed.flip))}.</li>
          </ul>
          <p>{computed.flip.timeToSellNote}</p>
        </section>
      ) : null}

      <section id="report-comparables">
        <h2>Similar listings</h2>
        <p className="hint">
          Scope: {plainCompScope(computed.compScope)}. Each asking price is adjusted to this car. These are asking prices, not sold prices.
        </p>
        {computed.compMethodNote ? <p>{computed.compMethodNote}</p> : null}
        <SimilarCarsList
          open
          cars={computed.comps.map((comp) => ({
            year: comp.year,
            trim: comp.trim,
            miles: comp.miles,
            askingUsd: comp.priceUsd,
            adjustedUsd: comp.adjustedPriceUsd,
            reasons: comp.adjustmentNotes ?? [],
            sourceUrl: comp.sourceUrl ?? null,
          }))}
        />
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
        <p className="hint">
          Source: NHTSA
          {nhtsaRecallCheck?.checkedAt ? ` · fetched ${formatCheckedAt(nhtsaRecallCheck.checkedAt)} UTC` : ""}. The numbers below are official recall numbers you can look up on NHTSA. They match the year, make, and model. They are not a record of what was fixed on this VIN.
        </p>
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
        <p className="hint">Lemonless does not have a complete title, theft, flood, or service-history database. Run the VIN through these independent sources before purchase.</p>
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
        <p className="hint">
          Source: NHTSA complaints
          {nhtsaComplaintCheck?.checkedAt ? ` · fetched ${formatCheckedAt(nhtsaComplaintCheck.checkedAt)} UTC` : ""}. This is a count for the model year, not this car.
        </p>
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
                <th>Official recall number</th>
                <th>Component</th>
                <th>Park-it (do not drive)</th>
                <th>Outdoor parking guidance</th>
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
                  <td>{recall.parkIt ? "Yes" : "No"}</td>
                  <td>{recall.parkOutSide ? "Yes" : "No"}</td>
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


      <section id="report-sources">
        <h2>Sources &amp; data status</h2>
        <p className="hint">
          Report assembled {new Intl.DateTimeFormat("en-US", {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone: "UTC",
          }).format(new Date(report.createdAt))} UTC. This is Lemonless&apos;s request/report time, not the date a provider last updated its records. Auto.dev may return cached listings for up to 6 hours.
        </p>
        {computed.sourceChecks?.length ? (
          <div className="table-scroll">
            <table className="source-check-table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Status</th>
                  <th>What was returned</th>
                  <th>Request time (UTC)</th>
                </tr>
              </thead>
              <tbody>
                {computed.sourceChecks.map((check) => (
                  <tr key={check.source}>
                    <td>{check.source}</td>
                    <td><span className={`source-status ${check.status}`}>{sourceStatusLabel(check.status)}</span></td>
                    <td>{check.detail}</td>
                    <td>{check.checkedAt ? new Intl.DateTimeFormat("en-US", {
                      dateStyle: "short",
                      timeStyle: "short",
                      timeZone: "UTC",
                    }).format(new Date(check.checkedAt)) : "Not recorded"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="hint">This saved report predates per-source provenance. Its source limitations are listed in the facts and history sections.</p>
        )}
      </section>

      <section className="ask" id="report-proof">
        <h2>Proof of AI</h2>
        <p className="hint">
          This record shows which numbers came from code and which AI review steps ran for this report. AI review never writes a price, mileage, or score into the decision.
        </p>
        <DecisionNote scene={reportScene(report)} proofs={report.proof.servChecks ?? []} />
        <ul className="refuse">
          <li>Inputs hash: <span className="mono">{report.proof.inputsHash.slice(0, 16)}…</span></li>
          <li>Explanation source: {plainExplanationSource(report.proof.explanationSource)}</li>
          {(report.proof.steps ?? []).map((step) => (
            <li key={`${step.id}-${step.status}`}>{formatBuyerProofLine(step)}</li>
          ))}
        </ul>
        {report.proof.steps?.some((step) => step.id === "number_audit" && step.status === "failed") ? (
          <p className="hint">
            The number audit blocked model prose that did not stay inside computed facts (or used buy language on a negative / needs-inspection verdict). That text was not published — the template explanation is shown instead. This is a protection, not a successful AI write.
          </p>
        ) : null}
      </section>

      <section className="ask" id="report-method">
        <h2>How to read this</h2>
        <p className="hint">
          We show which data the verdict is based on. We separate facts from estimates. We flag what still needs checking before you buy.
        </p>
        <p className="btn-row">
          <a className="quiet" href="#report-proof">Proof of AI for this report</a>
          <a className="quiet" href="/reports">My report history</a>
          <a className="quiet" href="/find">Find another car</a>
          <a className="quiet" href="/check">Check another listing</a>
          {resolveProductFlags().dealRadar ? <a className="ghost" href="/radar">Deal Radar</a> : null}
        </p>
      </section>
    </article>
  );
}

function sourceStatusLabel(status: import("@/domain/types").SourceCheckStatus): string {
  switch (status) {
    case "available": return "Available";
    case "partial": return "Partial";
    case "unavailable": return "Unavailable";
    case "not_checked": return "Not checked";
    case "sample": return "Sample";
    case "not_connected": return "Not connected";
  }
}

function reportScene(report: FullReport): DecisionScene {
  const purposes = (report.proof.servChecks ?? []).map((item) => item.purpose);
  if (purposes.includes("check_guard")) return "check";
  return "report";
}


function RiskSummary({
  flags,
  openParkIt,
  openParkOutside,
  missingData,
}: {
  flags: FullReport["computed"]["flags"];
  openParkIt: boolean;
  openParkOutside: boolean;
  missingData: string[];
}) {
  const stop = flags.filter((flag) => flag.level === "stop");
  const caution = flags.filter((flag) => flag.level === "caution");
  const notes = flags.filter((flag) => flag.level === "note");
  const prominent = [...stop, ...caution];
  return (
    <section
      id="report-risks"
      className={`risk-summary ${stop.length ? "risk-has-stop" : caution.length ? "risk-has-caution" : ""}`}
      aria-labelledby="risk-summary-title"
    >
      <h2 id="risk-summary-title">Risks &amp; missing data</h2>
      <div className="risk-counts" aria-label="Risk flag counts">
        <span className="risk-count stop">{stop.length} stop</span>
        <span className="risk-count caution">{caution.length} caution</span>
        <span className="risk-count note">{notes.length} notes</span>
        <span className="risk-count note">{missingData.length} missing</span>
      </div>
      {openParkIt ? (
        <p className="risk-primary">A park-it campaign matched this model year, make and model. Do not drive until the exact VIN&apos;s recall status and completed repair are confirmed — model coverage is not VIN unrepaired proof.</p>
      ) : openParkOutside ? (
        <p className="risk-primary">An outdoor-parking guidance campaign matched this model year, make and model. That is not a park-it / do-not-drive stop by itself — verify VIN applicability.</p>
      ) : null}
      {prominent.length > 0 ? (
        <ul className="risk-flag-list">
          {prominent.map((flag) => (
            <li key={`${flag.source}-${flag.text}`} className={`risk-flag ${flag.level}`}>
              <span className="risk-flag-level">{flag.level}</span>
              <span>{flag.text}</span>
              <span className="hint">Source: {plainFlagSource(flag.source)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">No stop or caution flags were returned from the available data. Missing records, undisclosed damage and mechanical issues may still exist.</p>
      )}
      {missingData.length > 0 ? (
        <>
          <h3 className="risk-missing-title">Missing or unused data</h3>
          <ul className="risk-missing-list">
            {missingData.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className="hint">No additional missing-data notes for this report.</p>
      )}
      <p className="hint">These are screening signals, not a physical inspection or a complete vehicle-history report.</p>
    </section>
  );
}
