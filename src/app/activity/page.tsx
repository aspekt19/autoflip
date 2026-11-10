"use client";

import { useEffect, useState } from "react";
import { ResaleDecisionJournalView } from "@/components/ResaleDecisionJournal";
import type { ResaleDecisionJournal } from "@/domain/resale-decision-journal";

type Run = {
  id: string;
  startedAt: string;
  finishedAt: string;
  trigger: string;
  storage: string;
  uniqueSearches: number;
  intervalHours: number;
  listings: number;
  passed: number;
  filteredOut: number;
  filterBreakdown?: string;
  alertsSent: number;
  autodevCalls: number;
  skippedDue: number;
  notes: string[];
  steps?: { id: string; status: string; detail?: string }[];
  serv: { promptGuard: string; shadow: string };
  servChecks?: Array<{
    purpose: string;
    modelReported: string;
    tools: string[];
    features: string[];
    promptGuard: string;
    shadowOutcome: string;
    shadowMaxIterations: number | null;
    latencyMs: number;
  }>;
  decisionJournal?: ResaleDecisionJournal;
  payment: { status: string; missing: string[]; tx: string | null; detail: string; costAtomic: string | null; network: string | null };
};

export default function ActivityPage() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/radar/activity")
      .then(async (response) => {
        const body = (await response.json()) as { runs?: Run[]; message?: string };
        if (!response.ok) {
          setMessage(body.message || "The activity log is part of the shared preview.");
          setRuns([]);
          return;
        }
        setRuns(body.runs ?? []);
      })
      .catch(() => setMessage("The activity log did not load."));
  }, []);

  return (
    <div className="sub">
      <div className="sheet-page site-frame">
        <p className="kicker">Deal Radar</p>
        <h1>Activity log</h1>
        <p className="lead">Real scheduled and check-now runs for your radars. Empty means no run has happened yet — nothing is seeded.</p>
        {message ? <p className="warn">{message}</p> : null}
        {runs === null ? <p>Loading…</p> : null}
        {(runs ?? []).map((run) => (
          <article key={run.id} className="warn-box">
            <p className="sheet-label">{run.trigger}</p>
            <h2>
              Started {new Date(run.startedAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC
              {" · "}
              finished {new Date(run.finishedAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC
            </h2>
            <ul className="refuse">
              <li>Storage: {run.storage}</li>
              <li>
                Unique searches {run.uniqueSearches}, interval {run.intervalHours}h, skipped because not due {run.skippedDue}
              </li>
              <li>
                Listings {run.listings}, passed {run.passed}, filtered out {run.filteredOut}, alerts {run.alertsSent}, listing calls {run.autodevCalls}
              </li>
              {run.filterBreakdown ? <li>Filtered out: {run.filterBreakdown}</li> : null}
              {(run.steps ?? []).map((step) => (
                <li key={step.id}>
                  {step.id}: {step.status}
                  {step.detail ? ` · ${step.detail}` : ""}
                </li>
              ))}
              <li>Input check: {run.serv.promptGuard}</li>
              <li>SERV path: {run.serv.shadow}</li>
              {(run.servChecks ?? []).map((check, index) => (
                <li key={`${check.purpose}-${index}`}>
                  SERV {check.purpose}: finished in {check.latencyMs} ms · model {check.modelReported}
                </li>
              ))}
              <li>
                Agent payment: {run.payment.status}
                {run.payment.tx ? ` · ${run.payment.tx}` : ""} · {run.payment.detail}
                {run.payment.costAtomic ? ` · amount ${run.payment.costAtomic}` : ""}
                {run.payment.network ? ` · ${run.payment.network}` : ""}
              </li>
              {run.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
            <ResaleDecisionJournalView journal={run.decisionJournal} defaultOpen={false} />
          </article>
        ))}
        {runs && runs.length === 0 && !message ? <p>No run yet.</p> : null}
      </div>
    </div>
  );
}
