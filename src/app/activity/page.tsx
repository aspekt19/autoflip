"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAccountLoad } from "@/components/use-account-load";
import { plainDecisionEngineText } from "@/domain/find-buyer-copy";
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

function when(iso: string): string {
  return `${new Date(iso).toLocaleString("en-US", { timeZone: "UTC" })} UTC`;
}

export default function ActivityPage() {
  const account = useAccountLoad();
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (account.phase === "loading") return;
    if (account.phase === "failed") {
      setMessage("The activity log did not load.");
      setRuns([]);
      return;
    }
    const signedIn = account.body?.authenticated === true;
    const authOn = account.body?.auth?.configured !== false;
    if (!signedIn) {
      setRuns([]);
      setMessage(
        authOn
          ? "Sign in to see checks that have run on your account. Nothing is listed until a real check has run."
          : "Sign-in is not available right now, so this log is empty.",
      );
      return;
    }

    let cancelled = false;
    fetch("/api/radar/activity")
      .then(async (response) => {
        const body = (await response.json()) as { runs?: Run[]; message?: string };
        if (cancelled) return;
        if (!response.ok) {
          setMessage(body.message || "The activity log could not be loaded.");
          setRuns([]);
          return;
        }
        setMessage(null);
        setRuns(body.runs ?? []);
      })
      .catch(() => {
        if (!cancelled) {
          setMessage("The activity log did not load.");
          setRuns([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [account.phase, account.body]);

  const signedIn = account.phase === "loaded" && account.body?.authenticated === true;

  return (
    <div className="sub">
      <div className="sheet-page site-frame">
        <p className="kicker">Deal Radar</p>
        <h1>Activity log</h1>
        <p className="lead">
          Checks that have actually run for your watches. If this page is empty, no check has run yet. Nothing is
          filled in to look finished.
        </p>
        {message ? <p className="warn">{message}</p> : null}
        {signedIn ? null : account.phase === "loaded" && account.body?.auth?.configured !== false ? (
          <p>
            <Link className="action" href="/login?callbackUrl=/activity">
              Sign in
            </Link>
          </p>
        ) : null}
        {runs === null ? <p>Loading…</p> : null}
        {(runs ?? []).map((run) => (
          <article key={run.id} className="warn-box">
            <h2>
              Started {when(run.startedAt)}
              {" · "}
              finished {when(run.finishedAt)}
            </h2>
            <ul className="refuse">
              <li>
                {run.listings} listing{run.listings === 1 ? "" : "s"} looked at, {run.passed} passed the filters,{" "}
                {run.alertsSent} alert{run.alertsSent === 1 ? "" : "s"} sent.
              </li>
              {run.notes.map((note) => (
                <li key={note}>{plainDecisionEngineText(note)}</li>
              ))}
            </ul>
            <ResaleDecisionJournalView journal={run.decisionJournal} defaultOpen={false} />
            <details className="onboarding-note">
              <summary>Technical details</summary>
              <ul className="refuse">
                <li>Run {run.id}</li>
                <li>Trigger: {run.trigger}</li>
                <li>Storage: {run.storage}</li>
                <li>
                  Unique searches {run.uniqueSearches}, interval {run.intervalHours}h, skipped because not due{" "}
                  {run.skippedDue}
                </li>
                <li>
                  Filtered out {run.filteredOut}, listing calls {run.autodevCalls}
                </li>
                {run.filterBreakdown ? <li>Filtered out: {run.filterBreakdown}</li> : null}
                {(run.steps ?? []).map((step) => (
                  <li key={step.id}>
                    {step.id}: {step.status}
                    {step.detail ? ` · ${step.detail}` : ""}
                  </li>
                ))}
                <li>Input check: {run.serv.promptGuard}</li>
                <li>Review path: {run.serv.shadow}</li>
                {(run.servChecks ?? []).map((check, index) => (
                  <li key={`${check.purpose}-${index}`}>
                    {check.purpose}: finished in {check.latencyMs} ms · model {check.modelReported}
                  </li>
                ))}
                <li>
                  Agent payment: {run.payment.status}
                  {run.payment.tx ? ` · ${run.payment.tx}` : ""} · {run.payment.detail}
                  {run.payment.costAtomic ? ` · amount ${run.payment.costAtomic}` : ""}
                  {run.payment.network ? ` · ${run.payment.network}` : ""}
                </li>
              </ul>
            </details>
          </article>
        ))}
        {runs && runs.length === 0 && !message ? <p>No check has run yet.</p> : null}
      </div>
    </div>
  );
}
