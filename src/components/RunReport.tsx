"use client";

import Link from "next/link";
import { useEffect } from "react";
import type { RunView } from "@/domain/run-view";
import { runReportModel } from "@/domain/run-view";
import { pickHeading } from "@/domain/run-view";
import { formatNumber, formatUsd } from "@/domain/format";
import { RunClarificationForm } from "./RunClarificationForm";

function newSearchHref(kind: RunView["kind"]): string {
  if (kind === "resale") return "/resale";
  if (kind === "check") return "/check";
  return "/find";
}

export function RunReport({ run }: { run: RunView }) {
  const model = runReportModel(run);
  useEffect(() => {
    document.getElementById("main")?.scrollIntoView({ block: "start" });
  }, [run.id]);
  return (
    <article className="run-report">
      <p className="kicker">{model.kicker}</p>
      <h1>{model.title}</h1>
      <p className="hint">{model.phaseLine}</p>
      {model.verdictLine ? <p className="verdict-level badge">{model.verdictLine}</p> : null}
      {model.buyerMessage ? <p>{model.buyerMessage}</p> : null}
      {model.confidenceLine ? <p>{model.confidenceLine}</p> : null}
      {model.failureLines.map((line) => (
        <p key={line}>{line}</p>
      ))}
      <p className="hint">{model.chargeLine}</p>
      {model.note ? <p>{model.note}</p> : null}
      {model.clarifications.length > 0 ? (
        <ul>
          {model.clarifications.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {model.limits.length > 0 ? (
        <ul>
          {model.limits.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {model.journal.length > 0 ? (
        <details className="agent-decision-trail onboarding-note serv-decision-journal" open>
          <summary>
            <strong>How this decision was made</strong>
          </summary>
          <ol>
            {model.journal.map((step, index) => (
              <li key={`${step.title}-${index}`}>
                <strong>{step.title}</strong> {step.sentence}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      {model.sources.length > 0 ? (
        <section>
          <h2>Sources</h2>
          <ul>
            {model.sources.map((source) => (
              <li key={source}>{source}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {model.listings.length > 0 ? (
        <div className="run-listings">
          {model.listings.map((car) => {
            const guidance = pickHeading(run, Boolean(car.picked));
            return (
              <article key={car.vin} className="run-car" data-vin={car.vin}>
                {guidance ? <p className="run-pick-label">{guidance}</p> : null}
                <h2 className="run-car-title">{car.title}</h2>
                {car.summary ? <p>{car.summary}</p> : null}
                <p className="support">
                  {car.priceUsd == null ? "Price not listed" : formatUsd(car.priceUsd)}
                  {car.miles == null ? "" : ` · ${formatNumber(car.miles)} miles`}
                  {car.distanceMiles != null && Number.isFinite(car.distanceMiles)
                    ? ` · ${Math.round(car.distanceMiles)} mi away`
                    : ""}
                  {car.drivetrain ? ` · ${car.drivetrain}` : car.drivetrainUnknown ? " · Drivetrain not listed" : ""}
                  {car.place ? ` · ${car.place}` : ""}
                  {car.dealer ? ` · ${car.dealer}` : ""}
                </p>
                {car.vdp && car.linkLabel ? (
                  <p>
                    <a href={car.vdp}>{car.linkLabel}</a>
                  </p>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : null}
      <div className="run-report-footer">
        <p className="btn-row">
          <Link className="quiet" href={newSearchHref(run.kind)}>
            New search
          </Link>
          <a className="quiet" href={model.permalink}>
            Open this search
          </a>
        </p>
        {model.viewerIsOwner ? <RunClarificationForm runId={run.id} /> : null}
      </div>
      <details className="technical-details">
        <summary>Reference codes</summary>
        {model.technicalIds.length === 0 ? <p className="hint">No response id was recorded.</p> : null}
        {model.technicalIds.map((id) => (
          <p key={id} className="response-id">
            {id}
          </p>
        ))}
      </details>
    </article>
  );
}
