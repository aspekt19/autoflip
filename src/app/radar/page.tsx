"use client";

import Link from "next/link";
import type { DecisionProof } from "@/domain/decision-note";
import { CoverageLine } from "@/components/CoverageNote";
import { DecisionNote } from "@/components/DecisionNote";
import { PriceBadgeView } from "@/components/PriceBadge";
import { ResaleDecisionJournalView } from "@/components/ResaleDecisionJournal";
import type { PriceBadge } from "@/domain/price-badge";
import type { ResaleDecisionJournal } from "@/domain/resale-decision-journal";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { SignInGate } from "@/components/SignInGate";
import { formatUsd } from "@/domain/format";
import { criteriaParseLabel, watchCriteriaSummary } from "@/domain/radar-criteria-provenance";
import { buildRadarReportPayload } from "@/domain/radar-report-handoff";
import type { WatchCriteria } from "@/domain/radar-watch";
import type { Mode } from "@/domain/types";

function RadarInner() {
  const params = useSearchParams();
  const [busyVin, setBusyVin] = useState<string | null>(null);
  const [demo, setDemo] = useState(false);
  const [searches, setSearches] = useState<
    Array<{
      id: string;
      name: string;
      mode: string;
      criteria: WatchCriteria;
      enabled: boolean;
      preset: boolean;
      lastCheckedAt: string | null;
    }>
  >([]);
  const [alerts, setAlerts] = useState<Array<{ id: string; vin: string; why: string; createdAt: string; mode: string; priceUsd: number; miles: number | null; year: number; make: string; model: string; checks?: DecisionProof[]; coverage?: string; coverageLevel?: "low" | "medium" | "high"; badge?: PriceBadge }>>([]);
  const [skippedReviews, setSkippedReviews] = useState<typeof alerts>([]);
  const [notReviewed, setNotReviewed] = useState<typeof alerts>([]);
  const [watchNote, setWatchNote] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [telegramNote, setTelegramNote] = useState<string | null>(null);
  const [telegramUi, setTelegramUi] = useState(false);
  const [credits, setCredits] = useState<number | null>(null);
  const [feedReady, setFeedReady] = useState(false);
  const [savedReportId, setSavedReportId] = useState<string | null>(null);
  const [lastRunAt, setLastRunAt] = useState<string | null>(null);
  const [nextRunAt, setNextRunAt] = useState<string | null>(null);
  const [listingCounts, setListingCounts] = useState<Array<{ searchId: string; listingsSeen: number }>>([]);
  const [freeWatchLimit, setFreeWatchLimit] = useState(3);
  const [emailNote, setEmailNote] = useState<string | null>(null);
  const [activity, setActivity] = useState<{
    runId: string;
    startedAt: string;
    finishedAt: string;
    alertsSent: number;
    listings: number;
    servActivity: Array<{
      at: string;
      vin: string;
      profile: string;
      modelReported: string;
      responseId: string | null;
      decision: string | null;
      note: string | null;
      alerted: boolean;
      latencyMs: number;
    }>;
    decisionJournal?: ResaleDecisionJournal;
    notes: string[];
  } | null>(null);
  const confirmId = params.get("confirm");

  async function loadFeed() {
    const response = await fetch("/api/radar/feed");
    if (!response.ok) return;
    const body = (await response.json()) as {
      demo?: boolean;
      searches?: typeof searches;
      alerts?: typeof alerts;
      skippedReviews?: typeof alerts;
      notReviewed?: typeof alerts;
      lastRunAt?: string | null;
      nextRunAt?: string | null;
      listingCounts?: typeof listingCounts;
      freeWatchLimit?: number;
      emailNote?: string;
      activity?: typeof activity;
    };
    setDemo(Boolean(body.demo));
    setSearches(body.searches ?? []);
    setAlerts(body.alerts ?? []);
    setSkippedReviews(body.skippedReviews ?? []);
    setNotReviewed(body.notReviewed ?? []);
    setLastRunAt(body.lastRunAt ?? null);
    setNextRunAt(body.nextRunAt ?? null);
    setListingCounts(body.listingCounts ?? []);
    if (typeof body.freeWatchLimit === "number") setFreeWatchLimit(body.freeWatchLimit);
    setEmailNote(body.emailNote ?? null);
    setActivity(body.activity ?? null);
    setFeedReady(true);
  }

  useEffect(() => {
    void loadFeed();
    fetch("/api/account")
      .then((response) => response.json())
      .then((body: { credits?: number }) => {
        if (typeof body.credits === "number") setCredits(body.credits);
      })
      .catch(() => setCredits(null));
    fetch("/api/product-flags")
      .then((response) => response.json())
      .then((body: { flags?: { telegram?: boolean } }) => {
        setTelegramUi(Boolean(body.flags?.telegram));
      })
      .catch(() => setTelegramUi(false));
  }, []);

  // Resume Radar full-report after credit purchase (mirrors Find af-pending-analysis).
  const radarResume = useRef(false);
  useEffect(() => {
    if (radarResume.current || credits === null || credits < 1) return;
    try {
      const raw = sessionStorage.getItem("af-radar-pending");
      if (!raw) return;
      const saved = JSON.parse(raw) as {
        mode?: Mode;
        vin?: string;
        askingPriceUsd?: number;
        miles?: number;
      };
      if (!saved?.vin) return;
      radarResume.current = true;
      void openReport(
        { vin: saved.vin, priceUsd: saved.askingPriceUsd ?? null, miles: saved.miles ?? null },
        saved.mode === "flip" ? "flip" : "personal",
      );
    } catch {
      /* ignore corrupt pending payload */
    }
  }, [credits]);

  useEffect(() => {
    if (!feedReady) return;
    const id = window.location.hash.replace(/^#/, "");
    if (id.startsWith("alert-")) document.getElementById(id)?.scrollIntoView({ block: "center" });
  }, [feedReady, alerts]);

  const confirmAlert = alerts.find((item) => item.id === confirmId) ?? null;

  useEffect(() => {
    if (!confirmAlert) {
      setSavedReportId(null);
      return;
    }
    fetch(`/api/report/by-vin?vin=${encodeURIComponent(confirmAlert.vin)}`)
      .then(async (response) => {
        const body = (await response.json()) as { id?: string | null };
        setSavedReportId(body.id ?? null);
      })
      .catch(() => setSavedReportId(null));
  }, [confirmAlert]);

  type ReportTarget = {
    vin: string;
    priceUsd?: number | null;
    miles?: number | null;
  };

  async function openReport(target: ReportTarget, reportMode: Mode = "personal") {
    setBusyVin(target.vin);
    setWatchNote(null);
    const payload = buildRadarReportPayload({
      vin: target.vin,
      mode: reportMode,
      zip: null,
      priceUsd: target.priceUsd,
      miles: target.miles,
    });
    try {
      const response = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json()) as { id?: string; message?: string; error?: string };
      if (response.status === 403 && body.error === "credits_required") {
        try {
          sessionStorage.setItem("af-radar-pending", JSON.stringify(payload));
        } catch {
          /* ignore */
        }
        window.location.href = "/credits?need=1&return=%2Fradar";
        return;
      }
      if (!response.ok || !body.id) {
        setWatchNote(body.message || "The report could not be built.");
        return;
      }
      try {
        sessionStorage.removeItem("af-radar-pending");
      } catch {
        /* ignore */
      }
      window.location.href = `/report/${body.id}`;
    } catch {
      setWatchNote("The report request did not finish.");
    } finally {
      setBusyVin(null);
    }
  }

  async function checkNow() {
    if (!demo && searches.length === 0) {
      setWatchNote("Watch a Find or Resale search first. A check with nothing saved does not look up listings.");
      return;
    }
    setChecking(true);
    setWatchNote(null);
    try {
      const response = await fetch("/api/radar/check", { method: "POST" });
      const body = (await response.json()) as { message?: string; alertsSent?: number };
      setWatchNote(body.message || (response.ok ? `Check finished. ${body.alertsSent ?? 0} new alerts.` : "The check did not run."));
      await loadFeed();
    } catch {
      setWatchNote("The check did not finish.");
    } finally {
      setChecking(false);
    }
  }

  async function skipAlert(alertId: string) {
    await fetch("/api/radar/skip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alertId }),
    });
    await loadFeed();
  }

  async function toggleSearch(searchId: string, enabled: boolean) {
    setWatchNote(null);
    const response = await fetch(`/api/radar/searches/${encodeURIComponent(searchId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    if (!response.ok) {
      setWatchNote(body?.message || "Could not update that watch.");
      return;
    }
    await loadFeed();
  }

  async function deleteSearch(searchId: string) {
    setWatchNote(null);
    const response = await fetch(`/api/radar/searches/${encodeURIComponent(searchId)}`, { method: "DELETE" });
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    if (!response.ok) {
      setWatchNote(body?.message || "Could not delete that watch.");
      return;
    }
    await loadFeed();
  }

  async function connectTelegram() {
    const response = await fetch("/api/telegram/link", { method: "POST" });
    const body = (await response.json()) as { configured?: boolean; url?: string; message?: string };
    if (!body.configured || !body.url) {
      setTelegramNote(body.message || "Telegram is not configured. Alerts stay in this app.");
      return;
    }
    window.open(body.url, "_blank", "noopener,noreferrer");
  }

  return (
    <div className="sub">
      <div className="wrap site-frame">
        <p className="kicker">{demo ? "Guided preview" : "Subscriptions"}</p>
        <h1>Deal Radar</h1>
        <p className="lead">
          Deal Radar watches searches you already set in Find (Drive it) or Resale (flip). Criteria are not edited here — start a search, then choose Watch with Deal Radar. Lemonless re-checks Auto.dev listings on a schedule and runs SERV on up to {freeWatchLimit} good/fair candidates per radar per run. Opening a full report costs 1 report credit.
        </p>
        <p className="hint">
          <Link href="/activity">Activity log</Link>
          {" · "}
          <Link href="/pricing">Pricing</Link>
        </p>
        <ul className="refuse">
          <li>
            Last run finished:{" "}
            {lastRunAt ? `${new Date(lastRunAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC` : "No run yet"}
            {activity?.startedAt
              ? ` · started ${new Date(activity.startedAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC`
              : ""}
          </li>
          <li>Next run: {nextRunAt ? `${new Date(nextRunAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC` : "No run yet"}</li>
          <li>
            Alerts on this page: {alerts.length}
            {activity ? ` · ${activity.alertsSent} new in last check` : ""}
            {skippedReviews.length > 0 ? ` · ${skippedReviews.length} reviewed — skipped` : ""}
            {notReviewed.length > 0 ? ` · ${notReviewed.length} not reviewed` : ""}
          </li>
        </ul>
        {emailNote ? <p className="hint">{emailNote}</p> : null}
        <div className="hero-actions">
          <button className="action" type="button" onClick={checkNow} disabled={checking || !feedReady || (!demo && searches.length === 0)}>
            {checking ? "Checking…" : !feedReady ? "Loading…" : !demo && searches.length === 0 ? "Watch a search first" : "Check now"}
          </button>
          {telegramUi ? (
            <button className="quiet" type="button" onClick={connectTelegram}>
              Connect Telegram
            </button>
          ) : null}
        </div>
        {watchNote ? <p className="warn">{watchNote}</p> : null}
        {telegramUi && telegramNote ? <p className="warn-box">{telegramNote}</p> : null}
        <h2>Subscribed searches</h2>
        {searches.length === 0 ? (
          <article className="warn-box">
            <h3>No radars yet</h3>
            <p>
              Set criteria in Find (Drive it) or Resale (flip), run a search, then choose Watch with Deal Radar. Personal
              watches are free with your account (up to {freeWatchLimit}).
            </p>
            <p className="btn-row">
              <Link className="action" href="/find">
                Find a car
              </Link>
              <Link className="quiet" href="/resale">
                Resale
              </Link>
            </p>
          </article>
        ) : null}
        <div className="radar-list">
          {searches.map((search) => {
            const seen = listingCounts.find((row) => row.searchId === search.id)?.listingsSeen ?? 0;
            const summary = watchCriteriaSummary(search.criteria, search.mode === "flip" ? "flip" : "personal");
            const parseLabel = criteriaParseLabel(
              search.criteria.criteriaParseSource
                ? {
                    source: search.criteria.criteriaParseSource,
                    responseId: search.criteria.criteriaResponseId ?? null,
                  }
                : null,
            );
            return (
              <article className="radar-row" key={search.id}>
                <div>
                  <span className="file-chip">{search.mode === "flip" ? "Flip" : "Drive it"}</span>
                  {search.enabled ? null : <span className="file-chip">Paused</span>}
                  {search.preset ? <span className="file-chip">preset</span> : null}
                </div>
                <div />
                <div>
                  <h3 className="car-title">{search.name}</h3>
                  <p>{summary}</p>
                  <p className="hint">{parseLabel}</p>
                  <p className="hint">
                    Listings seen: {seen}
                    {" · "}
                    Last check:{" "}
                    {search.lastCheckedAt
                      ? `${new Date(search.lastCheckedAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC`
                      : "No run yet"}
                    {" · "}
                    Next check:{" "}
                    {nextRunAt ? `${new Date(nextRunAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC` : "After the next run"}
                  </p>
                </div>
                <div className="row-actions">
                  <button
                    className="quiet"
                    type="button"
                    onClick={() => void toggleSearch(search.id, !search.enabled)}
                  >
                    {search.enabled ? "Pause" : "Resume"}
                  </button>
                  <button className="quiet" type="button" onClick={() => void deleteSearch(search.id)}>
                    Delete
                  </button>
                </div>
              </article>
            );
          })}
        </div>
        {confirmAlert ? (
          <article className="warn-box" id="confirm-analysis">
            <h2>Full analysis — 1 credit</h2>
            <p>
              {confirmAlert.year} {confirmAlert.make} {confirmAlert.model}. A full analysis uses 1 credit only after you confirm. Viewing the alert does not.
            </p>
            {savedReportId ? (
              <p>
                <Link className="action" href={`/report/${savedReportId}`}>
                  Open full report
                </Link>
              </p>
            ) : (
              <button
                className="action"
                type="button"
                onClick={() =>
                  openReport(
                    { vin: confirmAlert.vin, priceUsd: confirmAlert.priceUsd, miles: confirmAlert.miles },
                    confirmAlert.mode === "flip" ? "flip" : "personal",
                  )
                }
                disabled={busyVin === confirmAlert.vin}
              >
                {busyVin === confirmAlert.vin ? "Working…" : "Confirm — 1 credit"}
              </button>
            )}
          </article>
        ) : null}
        <h2>Activity (last run)</h2>
        {!activity ? (
          <p>No run yet.</p>
        ) : (
          <article className="warn-box">
            <p className="sheet-label">{activity.runId}</p>
            <p>
              Started {new Date(activity.startedAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC
              {" · "}
              finished {new Date(activity.finishedAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC
              {" · "}
              listings {activity.listings} · alerts {activity.alertsSent}
            </p>
            <ResaleDecisionJournalView journal={activity.decisionJournal} defaultOpen />
            {activity.servActivity.length === 0 ? (
              <p className="hint">No SERV calls in this run (no new good/fair candidates, or SERV was not configured).</p>
            ) : null}
            {activity.notes.length > 0 ? (
              <ul className="refuse">
                {activity.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            ) : null}
          </article>
        )}
        <h2>Alerts</h2>
        {alerts.length === 0 ? <p>No new matches yet. New good/fair listings SERV rates alert will appear here after a scheduled check.</p> : null}
        <div className="radar-list">
          {alerts.map((alert) => {
            const codeOnly = /uses the code price rating only/i.test(alert.why);
            return (
            <article className="radar-row" key={alert.id} id={`alert-${alert.id}`}>
              <div>
                <div className="score">{formatUsd(alert.priceUsd)}</div>
                <span className="file-chip">{alert.mode === "flip" ? "Flip" : "Drive it"}</span>
                {codeOnly ? <span className="file-chip">Code rating only</span> : null}
              </div>
              <div />
              <div>
                <h2 className="car-title">
                  {alert.year} {alert.make} {alert.model}
                </h2>
                {alert.badge ? <PriceBadgeView badge={alert.badge} /> : null}
                <p><strong>Why this car. </strong>{alert.why}</p>
                {codeOnly ? (
                  <p className="hint">Alert uses the code price rating only — SERV did not complete a review for this car.</p>
                ) : null}
                {alert.coverage && alert.coverageLevel ? (
                  <CoverageLine confidence={alert.coverageLevel} sentence={alert.coverage} />
                ) : (
                  <p className="hint">{alert.coverage ?? "Coverage was not recorded for this alert."}</p>
                )}
                <DecisionNote scene={alert.mode === "flip" ? "flip" : "personal_alert"} proofs={alert.checks ?? []} />
                <p className="hint">{new Date(alert.createdAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC · {alert.vin}</p>
              </div>
              <div className="row-actions">
                <button
                  className="action"
                  type="button"
                  onClick={() =>
                    openReport(
                      { vin: alert.vin, priceUsd: alert.priceUsd, miles: alert.miles },
                      alert.mode === "flip" ? "flip" : "personal",
                    )
                  }
                  disabled={busyVin === alert.vin}
                >
                  {busyVin === alert.vin ? "Working…" : "Analyze — 1 credit"}
                </button>
                <button className="quiet" type="button" onClick={() => skipAlert(alert.id)}>
                  Skip
                </button>
              </div>
            </article>
            );
          })}
        </div>
        {skippedReviews.length > 0 ? (
          <section className="onboarding-note" aria-labelledby="radar-serv-skipped-heading">
            <h2 id="radar-serv-skipped-heading">
              Reviewed — skipped ({skippedReviews.length})
            </h2>
            <p className="hint">
              SERV reviewed these cars and chose skip — not alerts. You can still run Analyze; there is no dismiss action here.
            </p>
            <div className="radar-list">
              {skippedReviews.map((row) => (
                <article className="radar-row" key={row.id}>
                  <div>
                    <div className="score">{formatUsd(row.priceUsd)}</div>
                    <span className="file-chip">Reviewed — skipped</span>
                    <span className="file-chip">{row.mode === "flip" ? "Flip" : "Drive it"}</span>
                  </div>
                  <div />
                  <div>
                    <h3 className="car-title">
                      {row.year} {row.make} {row.model}
                    </h3>
                    <p>{row.why}</p>
                    <p className="hint">{new Date(row.createdAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC · {row.vin}</p>
                  </div>
                  <div className="row-actions">
                    <button
                      className="action"
                      type="button"
                      onClick={() =>
                        openReport(
                          { vin: row.vin, priceUsd: row.priceUsd, miles: row.miles },
                          row.mode === "flip" ? "flip" : "personal",
                        )
                      }
                      disabled={busyVin === row.vin}
                    >
                      {busyVin === row.vin ? "Working…" : "Analyze — 1 credit"}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        ) : null}
        {notReviewed.length > 0 ? (
          <section className="onboarding-note" aria-labelledby="radar-not-reviewed-heading">
            <h2 id="radar-not-reviewed-heading">
              Not reviewed ({notReviewed.length})
            </h2>
            <p className="hint">
              No SERV decision for these cars on the last run — they will retry on the next check. Not counted as alerts.
            </p>
            <div className="radar-list">
              {notReviewed.map((row) => (
                <article className="radar-row" key={row.id}>
                  <div>
                    <div className="score">{formatUsd(row.priceUsd)}</div>
                    <span className="file-chip">Not reviewed</span>
                    <span className="file-chip">{row.mode === "flip" ? "Flip" : "Drive it"}</span>
                  </div>
                  <div />
                  <div>
                    <h3 className="car-title">
                      {row.year} {row.make} {row.model}
                    </h3>
                    <p>{row.why}</p>
                    <p className="hint">{new Date(row.createdAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC · {row.vin}</p>
                  </div>
                  <div className="row-actions">
                    <button
                      className="action"
                      type="button"
                      onClick={() =>
                        openReport(
                          { vin: row.vin, priceUsd: row.priceUsd, miles: row.miles },
                          row.mode === "flip" ? "flip" : "personal",
                        )
                      }
                      disabled={busyVin === row.vin}
                    >
                      {busyVin === row.vin ? "Working…" : "Analyze — 1 credit"}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        ) : null}
        {credits === null || credits === 0 ? (
          <p className="hint">
            <Link href="/credits">Buy credits</Link> for a full report.
          </p>
        ) : null}
      </div>
    </div>
  );
}

export default function RadarPage() {
  return (
    <Suspense fallback={<div className="wrap site-frame page">Loading Deal Radar…</div>}>
      <SignInGate callbackPath="/radar">
        <RadarInner />
      </SignInGate>
    </Suspense>
  );
}
