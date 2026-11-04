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

  useEffect(() => {
    if (!make || !model) {
      setRows(null);
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
  }, [make, model, zip, year, mode]);

  async function openReport(vin: string) {
    setBusyVin(vin);
    setError(null);
    try {
      const response = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, vin, zip: zip || undefined, year: year ? Number(year) : undefined }),
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

  return (
    <div className="wrap page">
      <h1>Deal Radar</h1>
      <p className="lede">A free scan. Each score uses the other cars in this result set. It does not include recalls or fuel — those are on the full report.</p>
      <SearchPanel initial={{ make, model, zip, year, mode }} />
      {sample ? (
        <p className="banner-note">
          <span className="sample-chip">Sample</span> {message}
        </p>
      ) : null}
      {!sample && message ? <p className="banner-note">{message}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}
      {!make || !model ? <p>Enter a make and model to scan.</p> : null}
      {make && model && rows === null && !error ? <p>Scanning…</p> : null}
      <div className="cards" style={{ marginTop: 16 }}>
        {(rows ?? []).map((row) => (
          <article className="card radar-card" key={row.vin}>
            {row.primaryImage ? (
              <img src={row.primaryImage} alt="" width={168} height={112} />
            ) : (
              <div className="photo-fallback" />
            )}
            <div>
              <div className="score">{row.score === null ? "—" : row.score}</div>
              <span className={`badge ${row.verdict}`}>{verdictLabel(row.verdict === "not_scored" ? "insufficient_data" : row.verdict)}</span>
              {row.source === "sample" ? (
                <div style={{ marginTop: 8 }}>
                  <span className="sample-chip">Sample</span>
                </div>
              ) : null}
            </div>
            <div>
              <h2>
                {row.year} {row.make} {row.model} {row.trim ?? ""}
              </h2>
              <p className="meta">
                {row.priceUsd === null ? "No price" : formatUsd(row.priceUsd)}
                {" · "}
                {row.miles === null ? "No mileage" : `${formatNumber(row.miles)} miles`}
                {row.city ? ` · ${row.city}, ${row.state ?? ""}` : ""}
              </p>
              <p>{row.reason}</p>
              <p className="mono">{row.vin}</p>
            </div>
            <div className="row-actions">
              <button className="btn" type="button" onClick={() => openReport(row.vin)} disabled={busyVin === row.vin}>
                {busyVin === row.vin ? "Working…" : "Full report · 1 credit"}
              </button>
            </div>
          </article>
        ))}
      </div>
      <p className="meta" style={{ marginTop: 18 }}>
        <Link href="/credits">Buy credits</Link> for a full report.
      </p>
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
