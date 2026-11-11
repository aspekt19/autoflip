import type { Metadata } from "next";
import Link from "next/link";
import { loadProofPageData } from "@/domain/proof-page-runs";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Proof" };

export default function ProofPage() {
  const data = loadProofPageData();
  const hasComparison = data.hasLiveComparisons;
  const hasTrace = data.committedTraces.length > 0;

  return (
    <div className="sub">
      <div className="sheet-page site-frame prose">
        <p className="kicker">Proof</p>
        <h1>Same request, three ways</h1>
        <p className="lead">
          This page compares one real buyer request three ways: Lemonless with its review step, a plain model call, and
          other agents. It shows result quality and cost only when a real run was saved. Nothing is filled in to look
          finished.
        </p>

        <section>
          <h2>Live multi-arm comparison</h2>
          {!hasComparison ? (
            <p className="lead">
              No live comparison scoreboard is committed yet. Fixture harness output is not shown as a finished result.
              A paid live run is required before this table fills in — this page does not invent scores or costs.
            </p>
          ) : (
            data.cases.map((row) => (
              <article key={row.caseId}>
                <p className="kicker">{row.synthetic ? "Synthetic case" : "Real case"}</p>
                <h3>{row.title}</h3>
                <ul className="refuse">
                  {row.arms.map((arm) => (
                    <li key={`${row.caseId}-${arm.arm}`}>
                      <strong>{arm.arm}</strong>
                      {arm.qualityNote ? ` — ${arm.qualityNote}` : ""}
                      {typeof arm.costUsd === "number" ? ` Cost recorded: $${arm.costUsd.toFixed(4)}.` : " Cost was not recorded."}
                      <details className="onboarding-note">
                        <summary>Technical details</summary>
                        <p className="hint">
                          Status {arm.status}
                          {arm.model ? ` · model ${arm.model}` : ""}
                          {arm.runId ? ` · response ${arm.runId}` : " · no response id"}
                          {arm.timestamp ? ` · ${arm.timestamp}` : ""}
                          {` · case ${row.caseId}`}
                        </p>
                        {arm.rawResponse ? (
                          <p className="hint" style={{ whiteSpace: "pre-wrap" }}>
                            {arm.rawResponse}
                          </p>
                        ) : (
                          <p className="hint">No raw response was saved for this arm.</p>
                        )}
                      </details>
                    </li>
                  ))}
                </ul>
              </article>
            ))
          )}
          {hasComparison && data.generatedAt ? (
            <p className="hint">Recorded {data.generatedAt}.</p>
          ) : data.generatedAt ? (
            <details className="onboarding-note">
              <summary>Technical details</summary>
              <p className="hint">
                A comparison file was saved at {data.generatedAt}. It is a fixture, so it is not shown as a finished
                scoreboard.
              </p>
            </details>
          ) : null}
        </section>

        <section>
          <h2>Committed single-run traces</h2>
          {!hasTrace ? (
            <p>No committed proof traces with run id, model, and timestamp are present in this checkout.</p>
          ) : (
            <ul className="refuse">
              {data.committedTraces.map((trace) => (
                <li key={trace.id}>
                  <p>
                    A recorded review from {trace.generatedAt}. This is not a customer report.
                    {trace.decision ? ` Decision recorded: ${trace.decision}.` : ""}
                  </p>
                  <details className="onboarding-note">
                    <summary>Technical details</summary>
                    <p className="hint">{trace.disclosure}</p>
                    <p className="hint">
                      {trace.id}
                      {trace.runId ? ` · response ${trace.runId}` : " · no response id"}
                      {trace.model ? ` · model ${trace.model}` : ""}
                    </p>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className="btn-row">
          <Link className="quiet" href="/where-serv-runs">
            Where SERV runs
          </Link>
          <Link className="quiet" href="/compare">
            Saved comparison
          </Link>
          <Link className="ghost" href="/developers">
            Agent API
          </Link>
        </p>
      </div>
    </div>
  );
}
