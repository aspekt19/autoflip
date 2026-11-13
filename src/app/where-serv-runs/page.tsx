import type { Metadata } from "next";
import Link from "next/link";
import { emptyServRunAggregateStats } from "@/domain/decision-audit-chain";
import { PIPELINE_STEPS } from "@/domain/serv-pipeline";
import { loadServRunAggregateStats } from "@/io/decision-audit-store";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Where SERV runs" };

export default async function WhereServRunsPage() {
  let stats = emptyServRunAggregateStats();
  try {
    stats = await loadServRunAggregateStats();
  } catch {
    stats = emptyServRunAggregateStats();
  }
  const empty = stats.trailCount === 0;

  return (
    <div className="sub">
      <div className="sheet-page site-frame prose">
        <p className="kicker">Transparency</p>
        <h1>Where SERV runs</h1>
        <p className="lead">
          SERV is the review step. It reads facts Lemonless already calculated and chooses an action, such as buy,
          negotiate, or pass. It does not invent prices. This page lists where that review runs, and counts from real
          sealed reports. If the counts are empty, nothing has been sealed in this environment yet.
        </p>

        <section>
          <h2>Pipeline</h2>
          <p className="hint">
            Each step is marked SERV (the review) or code (the calculation). The calculation owns the numbers. SERV may only quote them.{" "}
            <Link href="/verify">Verify a sealed trail</Link>.
          </p>
          <ol className="steps-3 story-steps">
            {PIPELINE_STEPS.map((step) => (
              <li key={step.id}>
                <strong>
                  [{step.by}] {step.surface} — {step.name}
                </strong>
                <span>{step.detail}</span>
              </li>
            ))}
          </ol>
        </section>

        <section>
          <h2>Live stats from sealed runs</h2>
          {empty ? (
            <p className="lead">
              No sealed decision trails are stored in this environment yet. Counts stay empty until a real Find, Check,
              Resale, or report run is sealed — nothing is filled in to look finished.
            </p>
          ) : (
            <ul className="refuse">
              <li>
                Sealed trails: <strong>{stats.trailCount}</strong>
              </li>
              <li>
                SERV review steps recorded: <strong>{stats.servCallCount}</strong>
              </li>
              <li>
                Calculation steps recorded: <strong>{stats.codeStepCount}</strong>
              </li>
              <li>
                Second-check agreements: <strong>{stats.secondCheckAgreements}</strong>
              </li>
              <li>
                Second-check disagreements: <strong>{stats.secondCheckDisagreements}</strong>
              </li>
              {stats.newestSealedAt ? (
                <li>
                  Newest sealed at{" "}
                  {new Date(stats.newestSealedAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC
                </li>
              ) : null}
            </ul>
          )}
          <p className="hint">
            Source: hash-linked audit trails written when reports and runs are sealed.{" "}
            <Link href="/api/serv-stats">JSON</Link>.
          </p>
        </section>

        <p className="btn-row">
          <Link className="quiet" href="/proof">
            Proof comparisons
          </Link>
          <Link className="quiet" href="/agents">
            Agent API
          </Link>
          <Link className="ghost" href="/">
            Home
          </Link>
        </p>
      </div>
    </div>
  );
}
