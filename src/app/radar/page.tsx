"use client";

import Link from "next/link";
import type { DecisionProof } from "@/domain/decision-note";
import { CoverageLine } from "@/components/CoverageNote";
import { DecisionNote } from "@/components/DecisionNote";
import { PriceBadgeView, PriceRatingHow } from "@/components/PriceBadge";
import type { PriceBadge } from "@/domain/price-badge";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent } from "react";
import { MakeModelFields } from "@/components/MakeModelFields";
import { ZipRadiusFields } from "@/components/ZipRadiusFields";
import { parseUsdInput } from "@/domain/budget";
import { parseDistanceMiles } from "@/domain/need";
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
  const [searches, setSearches] = useState<Array<{ id: string; name: string; mode: string; criteria: { priceMax: number; zip: string; radiusMiles: number; make?: string; model?: string }; preset: boolean }>>([]);
  const [alerts, setAlerts] = useState<Array<{ id: string; vin: string; why: string; createdAt: string; mode: string; priceUsd: number; year: number; make: string; model: string; checks?: DecisionProof[]; coverage?: string; coverageLevel?: "low" | "medium" | "high"; badge?: PriceBadge }>>([]);
  const [watchNote, setWatchNote] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [telegramNote, setTelegramNote] = useState<string | null>(null);
  const [credits, setCredits] = useState<number | null>(null);
  const [feedReady, setFeedReady] = useState(false);
  const [savedReportId, setSavedReportId] = useState<string | null>(null);
  const confirmId = params.get("confirm");

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
    fetch("/api/account")
      .then((response) => response.json())
      .then((body: { credits?: number }) => {
        if (typeof body.credits === "number") setCredits(body.credits);
      })
      .catch(() => setCredits(null));
  }, []);

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

  async function openReport(vin: string, reportMode: Mode = mode) {
    setBusyVin(vin);
    setError(null);
    try {
      const response = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: reportMode,
          vin,
          zip: zip || undefined,
          year: yearMin && yearMin === yearMax ? Number(yearMin) : undefined,
        }),
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
    if (!demo && searches.length === 0) {
      setWatchNote("Save a search before checking. A check with nothing saved does not look up listings.");
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
      <div className="wrap">
        <p className="kicker">{demo ? "Guided preview" : "Saved search"}</p>
        <h1>Deal Radar</h1>
        <p className="lead">Save a vehicle search and Lemonless will check for new matching dealer listings on a schedule. Ongoing alerts require a <Link href="/pricing">Radar plan</Link>; opening a full vehicle report separately costs 1 report credit.</p>
        {demo ? (
          <p className="hint">
            <Link href="/activity">Activity log</Link>
          </p>
        ) : null}
        <div className="hero-actions">
          <button className="action" type="button" onClick={checkNow} disabled={checking || !feedReady || (!demo && searches.length === 0)}>
            {checking ? "Checking…" : !feedReady ? "Loading…" : !demo && searches.length === 0 ? "Save a search first" : "Check now"}
          </button>
          <button className="quiet" type="button" onClick={connectTelegram}>
            Connect Telegram
          </button>
        </div>
        {watchNote ? <p className="warn">{watchNote}</p> : null}
        {telegramNote ? <p className="warn-box">{telegramNote}</p> : null}
        <h2>Saved searches</h2>
        {searches.length === 0 ? (
          <article className="warn-box">
            <h3>Create your first saved search</h3>
            <p>Choose a vehicle or local budget below. Once saved, Lemonless can look for new matching dealer listings. A Radar plan is required for ongoing alerts.</p>
            <p><Link href="/find">Start by finding a car</Link> · <Link href="/pricing">See Radar plans</Link></p>
          </article>
        ) : null}
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
                onClick={() => openReport(confirmAlert.vin, confirmAlert.mode === "flip" ? "flip" : "personal")}
                disabled={busyVin === confirmAlert.vin}
              >
                {busyVin === confirmAlert.vin ? "Working…" : "Confirm — 1 credit"}
              </button>
            )}
          </article>
        ) : null}
        <h2>Alerts</h2>
        {alerts.length === 0 ? <p>No new matches yet. New qualifying dealer listings will appear here after a scheduled check.</p> : null}
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
                {alert.badge ? <PriceBadgeView badge={alert.badge} /> : null}
                <p><strong>Why this car. </strong>{alert.why}</p>
                {alert.coverage && alert.coverageLevel ? (
                  <CoverageLine confidence={alert.coverageLevel} sentence={alert.coverage} />
                ) : (
                  <p className="hint">{alert.coverage ?? "Coverage was not recorded for this alert."}</p>
                )}
                <DecisionNote scene={alert.mode === "flip" ? "flip" : "personal_alert"} proofs={alert.checks ?? []} />
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
                <button className="action" type="button" onClick={() => openReport(row.vin)} disabled={busyVin === row.vin}>
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
  const [name, setName] = useState("Saved search");
  const [searchMode, setSearchMode] = useState<Mode>("personal");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [yearMin, setYearMin] = useState("");
  const [yearMax, setYearMax] = useState("");
  const [priceMax, setPriceMax] = useState("18000");
  const [zip, setZip] = useState("");
  const [distanceMiles, setDistanceMiles] = useState<number | null>(50);
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
    if (!zip.trim() || budget === null) {
      setError("Add a ZIP and a maximum price.");
      return;
    }
    const radiusParsed = parseDistanceMiles(distanceMiles);
    if (!radiusParsed.ok || radiusParsed.miles == null) {
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
            radiusMiles: radiusParsed.miles,
            minProfitUsd: searchMode === "flip" ? 1500 : undefined,
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
        <p className="hint">Flip uses the budget and ZIP only. Make stays Any.</p>
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
        allowNationwide={false}
      />
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
          {error} {/plan/i.test(error) ? <Link href="/pricing">See radar plans</Link> : null}
        </p>
      ) : null}
    </form>
  );
}

export default function RadarPage() {
  return (
    <Suspense fallback={<div className="wrap page">Loading Deal Radar…</div>}>
      <RadarInner />
    </Suspense>
  );
}
