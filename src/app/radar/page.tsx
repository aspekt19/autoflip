"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { SearchPanel } from "@/components/SearchPanel";
import { formatNumber, formatUsd, verdictLabel } from "@/domain/format";
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
};

function RadarInner() {
  const params = useSearchParams();
  const router = useRouter();
  const make = params.get("make") ?? "";
  const model = params.get("model") ?? "";
  const zip = params.get("zip") ?? "";
  const year = params.get("year") ?? "";
  const mode = (params.get("mode") === "flip" ? "flip" : "personal") as Mode;
  const [rows, setRows] = useState<Row[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [sample, setSample] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyVin, setBusyVin] = useState<string | null>(null);
  const [demo, setDemo] = useState(false);
  const [searches, setSearches] = useState<Array<{ id: string; name: string; mode: string; criteria: { priceMax: number; zip: string; radiusMiles: number; make?: string; model?: string }; preset: boolean }>>([]);
  const [alerts, setAlerts] = useState<Array<{ id: string; vin: string; why: string; createdAt: string; mode: string; priceUsd: number; year: number; make: string; model: string }>>([]);
  const [watchNote, setWatchNote] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [telegramNote, setTelegramNote] = useState<string | null>(null);
  const [feedReady, setFeedReady] = useState(false);

  async function loadFeed() {
    const response = await fetch("/api/radar/feed");
    if (!response.ok) return;
    const body = (await response.json()) as { demo?: boolean; searches?: typeof searches; alerts?: typeof alerts };
    setDemo(Boolean(body.demo));
    setSearches(body.searches ?? []);
    setAlerts(body.alerts ?? []);
    setFeedReady(true);
  }

  useEffect(() => {
    void loadFeed();
  }, []);

  useEffect(() => {
    if (!feedReady || demo || !make || !model) {
      if (!make || !model) setRows(null);
      return;
    }
    let cancelled = false;
    setError(null);
    setRows(null);
    fetch("/api/radar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        make,
        model,
        zip: zip || undefined,
        year: year ? Number(year) : undefined,
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
  }, [feedReady, demo, make, model, zip, year, mode]);

  async function openReport(vin: string, reportMode: Mode = mode) {
    setBusyVin(vin);
    setError(null);
    try {
      const response = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: reportMode, vin, zip: zip || undefined, year: year ? Number(year) : undefined }),
      });
      const body = (await response.json()) as { id?: string; message?: string; error?: string };
      if (response.status === 403 && body.error === "credits_required") {
        router.push("/credits?need=1");
        return;
      }
      if (!response.ok || !body.id) {
        setError(body.message || "The report could not be built.");
        return;
      }
      router.push(`/report/${body.id}`);
    } catch {
      setError("The report request did not finish.");
    } finally {
      setBusyVin(null);
    }
  }

  async function checkNow() {
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

  async function connectTelegram() {
    const response = await fetch("/api/telegram/link", { method: "POST" });
    const body = (await response.json()) as { configured?: boolean; url?: string; message?: string };
    if (!body.configured || !body.url) {
      setTelegramNote(body.message || "Telegram is not configured. Alerts stay in this app.");
      return;
    }
    window.location.href = body.url;
  }

  return (
    <div className="sub">
      <div className="wrap">
        <p className="kicker">{demo ? "Guided preview" : "Saved search"}</p>
        <h1>Deal Radar</h1>
        <p className="lead">
          Save the car you want once. AutoFlip checks new listings on a schedule, and a full report runs only when you ask for it. Watching costs nothing.
        </p>
        {demo ? (
          <p className="hint">
            <Link href="/activity">Activity log</Link>
          </p>
        ) : null}
        <div className="hero-actions">
          <button className="action" type="button" onClick={checkNow} disabled={checking}>
            {checking ? "Checking…" : "Check now"}
          </button>
          <button className="quiet" type="button" onClick={connectTelegram}>
            Connect Telegram
          </button>
        </div>
        {watchNote ? <p className="warn">{watchNote}</p> : null}
        {telegramNote ? <p className="warn-box">{telegramNote}</p> : null}
        <h2>Saved searches</h2>
        {searches.length === 0 ? <p>No saved search yet.</p> : null}
        <ul className="refuse">
          {searches.map((search) => (
            <li key={search.id}>
              <strong>{search.name}</strong>
              {search.preset ? " · preset" : ""}
              {" · "}
              {search.mode === "flip" ? "Flip" : "Drive it"}
              {" · "}
              up to {formatUsd(search.criteria.priceMax)} near {search.criteria.zip}, {search.criteria.radiusMiles} mi
              {search.criteria.make ? ` · ${search.criteria.make} ${search.criteria.model ?? ""}` : ""}
            </li>
          ))}
        </ul>
        <h2>Alerts</h2>
        {alerts.length === 0 ? <p>No alerts yet. A scheduled check has not produced a new listing that passed the filter.</p> : null}
        <div className="radar-list">
          {alerts.map((alert) => (
            <article className="radar-row" key={alert.id} id={`alert-${alert.id}`}>
              <div>
                <div className="score">{formatUsd(alert.priceUsd)}</div>
                <span className="file-chip">{alert.mode === "flip" ? "Flip" : "Drive it"}</span>
              </div>
              <div />
              <div>
                <h2 className="car-title">
                  {alert.year} {alert.make} {alert.model}
                </h2>
                <p>{alert.why}</p>
                <p className="hint">{new Date(alert.createdAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC · {alert.vin}</p>
              </div>
              <div className="row-actions">
                <button className="action" type="button" onClick={() => openReport(alert.vin, alert.mode === "flip" ? "flip" : "personal")} disabled={busyVin === alert.vin}>
                  {busyVin === alert.vin ? "Working…" : "Analyze — 1 credit"}
                </button>
                <button className="quiet" type="button" onClick={() => skipAlert(alert.id)}>
                  Skip
                </button>
              </div>
            </article>
          ))}
        </div>
        {demo ? null : (
          <>
            <h2>One-time scan</h2>
            <p className="hint">This scan is not saved and does not alert you later.</p>
            <SearchPanel initial={{ make, model, zip, year, mode }} />
          </>
        )}
        {sample ? (
          <p className="warn-box">
            <span className="file-chip">Sample</span> {message}
          </p>
        ) : null}
        {!sample && message ? <p className="warn-box">{message}</p> : null}
        {error ? <p className="warn">{error}</p> : null}
        {!make || !model ? <p>Enter a make and model to scan.</p> : null}
        {make && model && rows === null && !error ? <p>Scanning…</p> : null}
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
                <p>{row.reason}</p>
                <p className="mono">{row.vin}</p>
              </div>
              <div className="row-actions">
                <button className="action" type="button" onClick={() => openReport(row.vin)} disabled={busyVin === row.vin}>
                  {busyVin === row.vin ? "Working…" : "Full report · 1 credit"}
                </button>
              </div>
            </article>
          ))}
        </div>
        <p className="hint">
          <Link href="/credits">Buy credits</Link> for a full report.
        </p>
      </div>
    </div>
  );
}

export default function RadarPage() {
  return (
    <Suspense fallback={<div className="wrap page">Loading Deal Radar…</div>}>
      <RadarInner />
    </Suspense>
  );
}
