"use client";

import Link from "next/link";
import type { DecisionProof } from "@/domain/decision-note";
import { CoverageLine } from "@/components/CoverageNote";
import { DecisionNote } from "@/components/DecisionNote";
import { PriceBadgeView, PriceRatingHow } from "@/components/PriceBadge";
import { ResaleDecisionJournalView } from "@/components/ResaleDecisionJournal";
import type { PriceBadge } from "@/domain/price-badge";
import type { ResaleDecisionJournal } from "@/domain/resale-decision-journal";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import { MakeModelFields } from "@/components/MakeModelFields";
import { SignInGate } from "@/components/SignInGate";
import { ZipRadiusFields } from "@/components/ZipRadiusFields";
import { parseUsdInput } from "@/domain/budget";
import { parseDistanceMiles } from "@/domain/need";
import { formatNumber, formatUsd, verdictLabel } from "@/domain/format";
import { buildRadarReportPayload } from "@/domain/radar-report-handoff";
import type { Mode } from "@/domain/types";

type Row = {
  vin: string;
  year: number;
  make: string;
  model: string;
  trim: string | null;
  priceUsd: number | null;
  miles: number | null;
  city: string | null;
  state: string | null;
  primaryImage: string | null;
  score: number | null;
  verdict: string;
  reason: string;
  source: string;
  badge?: PriceBadge;
};

function RadarInner() {
  const params = useSearchParams();
  const router = useRouter();
  const make = params.get("make") ?? "";
  const model = params.get("model") ?? "";
  const zip = params.get("zip") ?? "";
  const yearMin = params.get("yearMin") ?? params.get("year") ?? "";
  const yearMax = params.get("yearMax") ?? params.get("year") ?? "";
  const mode = (params.get("mode") === "flip" ? "flip" : "personal") as Mode;
  const priceMax = params.get("priceMax") ?? "";
  const distanceParam = parseDistanceMiles(params.get("distanceMiles") ?? params.get("radiusMiles"));
  const distanceMiles = distanceParam.ok && distanceParam.miles != null ? distanceParam.miles : undefined;
  const [rows, setRows] = useState<Row[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [sample, setSample] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyVin, setBusyVin] = useState<string | null>(null);
  const [demo, setDemo] = useState(false);
  const [searches, setSearches] = useState<Array<{ id: string; name: string; mode: string; criteria: { priceMax: number; zip: string; radiusMiles: number; make?: string; model?: string; notes?: string }; preset: boolean; lastCheckedAt: string | null }>>([]);
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

  const flipReady = mode === "flip" && Boolean(priceMax) && Boolean(zip);
  useEffect(() => {
    if (!feedReady || demo || (mode === "flip" ? !flipReady : !make)) {
      if (mode === "flip" ? !flipReady : !make) setRows(null);
      return;
    }
    let cancelled = false;
    setError(null);
    setRows(null);
    fetch("/api/radar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        make: make || undefined,
        model: model || undefined,
        zip: zip || undefined,
        distanceMiles,
        priceMax: priceMax ? Number(priceMax) : undefined,
        yearMin: yearMin ? Number(yearMin) : undefined,
        yearMax: yearMax ? Number(yearMax) : undefined,
        mode,
      }),
    })
      .then(async (response) => {
        const body = (await response.json()) as { message?: string; sample?: boolean; listings?: Row[]; error?: string };
        if (cancelled) return;
        if (!response.ok) {
          setError(body.message || "The scan failed.");
          setRows([]);
          return;
        }
        setSample(Boolean(body.sample));
        setMessage(body.message ?? null);
        setRows(body.listings ?? []);
      })
      .catch(() => {
        if (!cancelled) setError("The scan did not finish.");
      });
    return () => {
      cancelled = true;
    };
  }, [feedReady, demo, make, model, zip, yearMin, yearMax, mode, priceMax, flipReady, distanceMiles]);

  type ReportTarget = {
    vin: string;
    priceUsd?: number | null;
    miles?: number | null;
  };

  async function openReport(target: ReportTarget, reportMode: Mode = mode) {
    setBusyVin(target.vin);
    setError(null);
    const payload = buildRadarReportPayload({
      vin: target.vin,
      mode: reportMode,
      zip: zip || null,
      year: yearMin && yearMin === yearMax ? Number(yearMin) : undefined,
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
        router.push("/credits?need=1&return=%2Fradar");
        return;
      }
      if (!response.ok || !body.id) {
        setError(body.message || "The report could not be built.");
        return;
      }
      try {
        sessionStorage.removeItem("af-radar-pending");
      } catch {
        /* ignore */
      }
      router.push(`/report/${body.id}`);
    } catch {
      setError("The report request did not finish.");
    } finally {
      setBusyVin(null);
    }
  }

  async function checkNow() {
    if (!demo && searches.length === 0) {
      setWatchNote("Save a search before checking. A check with nothing saved does not look up listings.");
      return;
    }
    setChecking(true);
    setWatchNote(null);
    // Drop the previous run's journal before the new check finishes so a stale
    // role=status / warn line (e.g. http_error) is not still live-announced.
    setActivity(null);
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
        <p className="kicker">{demo ? "Guided preview" : "Saved search"}</p>
        <h1>Deal Radar</h1>
        <p className="lead">
          Save a Find search (model, budget, ZIP, radius, notes). Lemonless re-checks Auto.dev listings on a schedule, diffs new listing ids, and runs SERV only on up to {freeWatchLimit} good/fair candidates per radar per run. Free with a signed-in account up to {freeWatchLimit} personal radars. Opening a full report costs 1 report credit.
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
            {checking ? "Checking…" : !feedReady ? "Loading…" : !demo && searches.length === 0 ? "Save a search first" : "Check now"}
          </button>
          {telegramUi ? (
            <button className="quiet" type="button" onClick={connectTelegram}>
              Connect Telegram
            </button>
          ) : null}
        </div>
        {watchNote ? <p className="warn">{watchNote}</p> : null}
        {telegramUi && telegramNote ? <p className="warn-box">{telegramNote}</p> : null}
        <h2>Saved searches</h2>
        {searches.length === 0 ? (
          <article className="warn-box">
            <h3>No radars yet</h3>
            <p>Save a search from Find or the form below. Personal Deal Radar watches are free with your account (up to {freeWatchLimit}).</p>
            <p><Link href="/find">Start by finding a car</Link></p>
          </article>
        ) : null}
        <ul className="refuse">
          {searches.map((search) => {
            const seen = listingCounts.find((row) => row.searchId === search.id)?.listingsSeen ?? 0;
            return (
              <li key={search.id}>
                <strong>{search.name}</strong>
                {search.preset ? " · preset" : ""}
                {" · "}
                {search.mode === "flip" ? "Flip" : "Drive it"}
                {" · "}
                up to {formatUsd(search.criteria.priceMax)} near {search.criteria.zip}, {search.criteria.radiusMiles} mi
                {search.criteria.make ? ` · ${search.criteria.make} ${search.criteria.model ?? ""}` : ""}
                {" · "}
                listings seen: {seen}
                {" · "}
                last checked: {search.lastCheckedAt ? `${new Date(search.lastCheckedAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC` : "No run yet"}
                {search.criteria.notes ? ` · notes: ${search.criteria.notes}` : ""}
              </li>
            );
          })}
        </ul>
        {!demo || !searches.some((search) => !search.preset) ? (
          <SaveSearchForm onSaved={() => void loadFeed()} />
        ) : (
          <p className="hint">The shared preview already has its one extra saved search.</p>
        )}
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
        {rows && rows.length > 0 ? (
          <>
            <h2 id="scan-results">Scan results</h2>
            <PriceRatingHow />
          </>
        ) : null}
        {sample ? (
          <p className="warn-box">
            <span className="file-chip">Sample</span> {message}
          </p>
        ) : null}
        {!sample && message ? <p className="warn-box">{message}</p> : null}
        {error ? <p className="warn">{error}</p> : null}
        {(mode === "flip" ? flipReady : Boolean(make)) && rows === null && !error ? <p>Scanning…</p> : null}
        <div className="radar-list">
          {(rows ?? []).map((row) => (
            <article className="radar-row" key={row.vin}>
              {row.primaryImage ? <img src={row.primaryImage} alt="" width={128} height={84} /> : <div className="photo-fallback" />}
              <div>
                <div className="score">{row.score === null ? "—" : row.score}</div>
                <span className={`badge ${row.verdict}`}>{verdictLabel(row.verdict === "not_scored" ? "insufficient_data" : row.verdict)}</span>
                {row.source === "sample" ? (
                  <div style={{ marginTop: 8 }}>
                    <span className="file-chip">Sample</span>
                  </div>
                ) : null}
              </div>
              <div>
                <h2 className="car-title">
                  {row.year} {row.make} {row.model} {row.trim ?? ""}
                </h2>
                <p className="hint">
                  {row.priceUsd === null ? "No price" : formatUsd(row.priceUsd)}
                  {" · "}
                  {row.miles === null ? "No mileage" : `${formatNumber(row.miles)} miles`}
                  {row.city ? ` · ${row.city}, ${row.state ?? ""}` : ""}
                </p>
                {row.badge ? <PriceBadgeView badge={row.badge} /> : null}
                <p><strong>Why this car. </strong>{row.reason}</p>
                <p className="mono">{row.vin}</p>
              </div>
              <div className="row-actions">
                <button
                  className="action"
                  type="button"
                  onClick={() => openReport({ vin: row.vin, priceUsd: row.priceUsd, miles: row.miles })}
                  disabled={busyVin === row.vin}
                >
                  {busyVin === row.vin ? "Working…" : "Full report · 1 credit"}
                </button>
              </div>
            </article>
          ))}
        </div>
        {credits === null || credits === 0 ? (
          <p className="hint">
            <Link href="/credits">Buy credits</Link> for a full report.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function SaveSearchForm({ onSaved }: { onSaved: () => void }) {
  const router = useRouter();
  const params = useSearchParams();
  const seedPrice = params.get("priceMax")?.trim() || "";
  const seedZip = params.get("zip")?.trim() || "";
  const seedMode = params.get("mode") === "flip" ? "flip" : params.get("mode") === "personal" ? "personal" : null;
  const seedRadiusRaw = params.get("distanceMiles") ?? params.get("radiusMiles");
  const seedNationwide = params.get("nationwide") === "1";
  const seedRadius = seedRadiusRaw != null && seedRadiusRaw !== "" ? Number(seedRadiusRaw) : null;
  const [name, setName] = useState("Saved search");
  const [searchMode, setSearchMode] = useState<Mode>(seedMode ?? "personal");
  const [make, setMake] = useState(params.get("make")?.trim() || "");
  const [model, setModel] = useState(params.get("model")?.trim() || "");
  const [yearMin, setYearMin] = useState("");
  const [yearMax, setYearMax] = useState("");
  // Prefer the actual budget from Resale/Find handoff — never invent 18000 over a known budget.
  const [priceMax, setPriceMax] = useState(seedPrice);
  const [zip, setZip] = useState(seedZip);
  const [distanceMiles, setDistanceMiles] = useState<number | null>(() => {
    if (seedMode === "flip" && seedNationwide) return null;
    if (seedRadius != null && Number.isFinite(seedRadius)) return seedRadius;
    return seedMode === "flip" && !seedZip ? null : 50;
  });
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const budget = parseUsdInput(priceMax);
    if (searchMode === "personal" && !make) {
      setError("Choose a make for a drive-it watch. Flip watches can stay on Any.");
      return;
    }
    if (budget === null) {
      setError("Add a maximum price.");
      return;
    }
    const nationwideFlip = searchMode === "flip" && (distanceMiles == null || distanceMiles === 0);
    if (!nationwideFlip && !zip.trim()) {
      setError("Add a ZIP and a maximum price.");
      return;
    }
    const radiusParsed = nationwideFlip ? { ok: true as const, miles: null } : parseDistanceMiles(distanceMiles);
    if (!nationwideFlip && (!radiusParsed.ok || radiusParsed.miles == null)) {
      setError(
        radiusParsed.ok
          ? "Deal Radar watches need a seller-distance radius (not nationwide)."
          : radiusParsed.message,
      );
      return;
    }
    setPending(true);
    try {
      const response = await fetch("/api/radar/searches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          mode: searchMode,
          criteria: {
            make,
            model: model || undefined,
            yearMin: yearMin ? Number(yearMin) : undefined,
            yearMax: yearMax ? Number(yearMax) : undefined,
            priceMax: budget,
            zip: zip.trim(),
            radiusMiles: nationwideFlip ? null : radiusParsed.ok ? radiusParsed.miles : null,
            nationwide: nationwideFlip || undefined,
            minProfitUsd: searchMode === "flip" ? 1500 : undefined,
            notes: notes.trim() || undefined,
          },
        }),
      });
      const body = (await response.json()) as { message?: string };
      if (!response.ok) {
        setError(body.message || "The search was not saved.");
        return;
      }
      onSaved();
    } catch {
      setError("The search was not saved.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="panel" onSubmit={submit}>
      <h2>Create a saved search</h2>
      <div className="field">
        <label htmlFor="search-name">Name</label>
        <input id="search-name" value={name} onChange={(event) => setName(event.target.value)} />
      </div>
      <fieldset className="field">
        <legend>Mode</legend>
        <div className="pills">
          <label className="pill">
            <input type="radio" name="search-mode" checked={searchMode === "personal"} onChange={() => setSearchMode("personal")} />
            Drive it
          </label>
          <label className="pill">
            <input type="radio" name="search-mode" checked={searchMode === "flip"} onChange={() => setSearchMode("flip")} />
            Flip it
          </label>
        </div>
      </fieldset>
      {searchMode === "flip" ? (
        <p className="hint">
          Flip uses the budget (and optional ZIP/radius). Leave radius empty for nationwide — same as Resale. Make stays
          Any.
        </p>
      ) : (
        <MakeModelFields
          make={make}
          model={model}
          yearMin={yearMin}
          yearMax={yearMax}
          onMake={setMake}
          onModel={setModel}
          onYearMin={setYearMin}
          onYearMax={setYearMax}
        />
      )}
      <div className="field">
        <label htmlFor="search-price">Maximum price</label>
        <input id="search-price" inputMode="numeric" value={priceMax} onChange={(event) => setPriceMax(event.target.value)} />
      </div>
      <ZipRadiusFields
        idPrefix="radar-save"
        zip={zip}
        distanceMiles={distanceMiles}
        onZipChange={setZip}
        onDistanceChange={setDistanceMiles}
        allowNationwide={searchMode === "flip"}
      />
      <div className="field">
        <label htmlFor="search-notes">Notes (optional)</label>
        <textarea id="search-notes" rows={2} value={notes} onChange={(event) => setNotes(event.target.value.slice(0, 500))} />
      </div>
      <div className="btn-row">
        <button className="action" type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save search"}
        </button>
        <button
          className="quiet"
          type="button"
          onClick={() => {
            const budget = parseUsdInput(priceMax);
            if (searchMode === "personal" && !make) {
              setError("Choose a make for a drive-it scan. Flip scans can stay on Any.");
              return;
            }
            if (!zip.trim() || budget === null) {
              setError("Add a ZIP and a maximum price.");
              return;
            }
            const radiusParsed = parseDistanceMiles(distanceMiles);
            if (!radiusParsed.ok || radiusParsed.miles == null) {
              setError(
                radiusParsed.ok
                  ? "Deal Radar scans need a seller-distance radius (not nationwide)."
                  : radiusParsed.message,
              );
              return;
            }
            const next = new URLSearchParams({
              mode: searchMode,
              zip: zip.trim(),
              priceMax: String(budget),
              distanceMiles: String(radiusParsed.miles),
            });
            if (make) next.set("make", make);
            if (model) next.set("model", model);
            if (yearMin) next.set("yearMin", yearMin);
            if (yearMax) next.set("yearMax", yearMax);
            router.push(`/radar?${next.toString()}#scan-results`);
          }}
        >
          Scan once
        </button>
      </div>
      {error ? (
        <p className="warn" role="alert">
          {error} {/plan|watch|radar/i.test(error) ? <Link href="/pricing">See pricing</Link> : null}
        </p>
      ) : null}
    </form>
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
