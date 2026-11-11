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
          Scaffold for comparing one real buyer request across Lemonless (with SERV reasoning), a plain model call, and
          other agents — user result quality and cost per run. Rows render only from committed run files with
          provenance (run id, model, timestamp, raw response when recorded).
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
                <p className="hint">
                  <span className="mono">{row.caseId}</span>
                </p>
                <ul className="refuse">
                  {row.arms.map((arm) => (
                    <li key={`${row.caseId}-${arm.arm}`}>
                      <strong>{arm.arm}</strong>
                      {" · "}
                      {arm.status}
                      {arm.model ? ` · model ${arm.model}` : ""}
                      {arm.runId ? ` · run ${arm.runId}` : ""}
                      {arm.timestamp ? ` · ${arm.timestamp}` : ""}
                      {typeof arm.costUsd === "number" ? ` · $${arm.costUsd.toFixed(4)}` : " · cost not recorded"}
                      {arm.qualityNote ? ` — ${arm.qualityNote}` : ""}
                      {arm.rawResponse ? (
                        <details className="onboarding-note">
                          <summary>Raw response</summary>
                          <p className="hint" style={{ whiteSpace: "pre-wrap" }}>
                            {arm.rawResponse}
                          </p>
                        </details>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </article>
            ))
          )}
          {data.generatedAt ? (
            <p className="hint">Comparison file generatedAt {data.generatedAt} (shown only when live scores exist).</p>
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
                  <strong>{trace.id}</strong>
                  {trace.runId ? ` · response ${trace.runId}` : ""}
                  {trace.model ? ` · model ${trace.model}` : ""}
                  {` · ${trace.generatedAt}`}
                  {trace.decision ? ` · decision ${trace.decision}` : ""}
                  <p className="hint">{trace.disclosure}</p>
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
            Older compare page
          </Link>
          <Link className="ghost" href="/developers">
            Agent API
          </Link>
        </p>
      </div>
    </div>
  );
}
