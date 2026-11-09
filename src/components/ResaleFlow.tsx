"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAccountLoad } from "@/components/use-account-load";
import { formatUsd } from "@/domain/format";
import { NOT_ENOUGH_SIMILAR_CARS } from "@/domain/price-evaluation";
import type { ResaleAssessment } from "@/domain/resale-evaluate";

export function ResaleFlow() {
  const account = useAccountLoad();
  const router = useRouter();
  const loading = account.phase === "loading";
  const signedIn = account.phase === "loaded" && account.body?.authenticated === true;
  const authConfigured = account.body?.auth?.configured !== false;

  if (loading) {
    return (
      <div className="panel" aria-busy="true">
        <p className="hint">Checking your sign-in…</p>
      </div>
    );
  }

  if (!signedIn) {
    return (
      <div className="panel sign-in-gate" role="region" aria-label="Sign in required">
        <h2>Sign in to continue</h2>
        <p className="lead">
          Resale estimates use live similar listings. A free account keeps that usage tied to you.
        </p>
        {authConfigured ? (
          <p className="btn-row">
            <Link className="action" href={`/login?callbackUrl=${encodeURIComponent("/resale")}`}>
              Sign in
            </Link>
          </p>
        ) : (
          <p className="warn" role="alert">
            Sign-in is not available in this environment right now.
          </p>
        )}
      </div>
    );
  }

  return <ResaleForm onAuthLost={() => router.push(`/login?callbackUrl=${encodeURIComponent("/resale")}`)} />;
}

function ResaleForm({ onAuthLost }: { onAuthLost: () => void }) {
  const yearNow = new Date().getUTCFullYear();
  const [year, setYear] = useState(String(yearNow - 4));
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [trim, setTrim] = useState("");
  const [miles, setMiles] = useState("");
  const [asking, setAsking] = useState("");
  const [zip, setZip] = useState("");
  const [targetProfit, setTargetProfit] = useState("1500");
  const [repairAbility, setRepairAbility] = useState<"unknown" | "none" | "minor" | "major">("unknown");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [assessment, setAssessment] = useState<ResaleAssessment | null>(null);

  async function submit() {
    setError(null);
    setAssessment(null);
    setTitle(null);
    setPending(true);
    try {
      const response = await fetch("/api/resale/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          year: Number(year),
          make,
          model,
          trim: trim || null,
          miles: Number(miles.replace(/[^0-9.]/g, "")),
          askingUsd: asking,
          zip: zip.trim() || null,
          targetProfitUsd: targetProfit,
          repairAbility,
        }),
      });
      const body = (await response.json()) as {
        error?: string;
        message?: string;
        title?: string;
        assessment?: ResaleAssessment;
      };
      if (response.status === 401 || response.status === 403) {
        if (body.error === "auth_required" || body.error === "email_unverified" || body.error === "auth_unconfigured") {
          onAuthLost();
          return;
        }
      }
      if (!response.ok || !body.assessment) {
        setError(body.message ?? "The resale estimate did not finish.");
        return;
      }
      setTitle(body.title ?? null);
      setAssessment(body.assessment);
    } catch {
      setError("The resale estimate did not finish.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="panel resale-flow">
      <p className="hint">
        Enter one car you might buy to flip. Lemonless compares the ask with similar dealer listings and shows a buy
        ceiling, a resale range, and example costs. Figures are estimates from asking prices — not sold prices, and not a
        profit guarantee.
      </p>
      <div className="pair">
        <div className="field">
          <label htmlFor="resale-year">Year</label>
          <input id="resale-year" value={year} onChange={(e) => setYear(e.target.value)} inputMode="numeric" />
        </div>
        <div className="field">
          <label htmlFor="resale-miles">Mileage</label>
          <input
            id="resale-miles"
            value={miles}
            onChange={(e) => setMiles(e.target.value)}
            inputMode="numeric"
            placeholder="e.g. 42,000"
          />
        </div>
      </div>
      <div className="pair">
        <div className="field">
          <label htmlFor="resale-make">Make</label>
          <input id="resale-make" value={make} onChange={(e) => setMake(e.target.value)} placeholder="e.g. Toyota" />
        </div>
        <div className="field">
          <label htmlFor="resale-model">Model</label>
          <input id="resale-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. Camry" />
        </div>
      </div>
      <div className="field">
        <label htmlFor="resale-trim">Trim (optional)</label>
        <input id="resale-trim" value={trim} onChange={(e) => setTrim(e.target.value)} placeholder="e.g. SE" />
      </div>
      <div className="pair">
        <div className="field">
          <label htmlFor="resale-ask">Asking price you would pay</label>
          <input
            id="resale-ask"
            value={asking}
            onChange={(e) => setAsking(e.target.value)}
            inputMode="decimal"
            placeholder="e.g. 18,500"
          />
        </div>
        <div className="field">
          <label htmlFor="resale-profit">Target profit (estimate)</label>
          <input
            id="resale-profit"
            value={targetProfit}
            onChange={(e) => setTargetProfit(e.target.value)}
            inputMode="decimal"
            placeholder="e.g. 1,500"
          />
        </div>
      </div>
      <div className="field">
        <label htmlFor="resale-zip">U.S. ZIP for nearby comps (optional)</label>
        <input
          id="resale-zip"
          value={zip}
          onChange={(e) => setZip(e.target.value)}
          inputMode="numeric"
          placeholder="Nationwide if blank"
        />
      </div>
      <fieldset className="field">
        <legend>Repair ability (affects recon estimate only)</legend>
        <div className="pills" role="radiogroup" aria-label="Repair ability">
          {(
            [
              ["unknown", "Not sure"],
              ["none", "Pay a shop"],
              ["minor", "Basic repairs"],
              ["major", "Mechanical work"],
            ] as const
          ).map(([value, label]) => (
            <label className="pill" key={value}>
              <input
                type="radio"
                name="repair"
                checked={repairAbility === value}
                onChange={() => setRepairAbility(value)}
              />{" "}
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="btn-row">
        <button className="action" type="button" disabled={pending} onClick={() => void submit()}>
          {pending ? "Estimating…" : "Estimate resale"}
        </button>
      </div>
      {error ? (
        <p className="warn" role="alert">
          {error}
        </p>
      ) : null}
      {assessment ? <ResaleResult title={title} assessment={assessment} /> : null}
    </div>
  );
}

function ResaleResult({ title, assessment }: { title: string | null; assessment: ResaleAssessment }) {
  if (!assessment.ok) {
    return (
      <article className="warn-box" aria-live="polite">
        {title ? <h2>{title}</h2> : null}
        <p className="lead">
          <strong>{NOT_ENOUGH_SIMILAR_CARS}</strong> · Confidence: {assessment.confidence}
        </p>
        <p>{assessment.reason}</p>
        <p className="hint">{assessment.methodNote}</p>
      </article>
    );
  }

  return (
    <article className="warn-box check-result" aria-live="polite">
      {title ? <h2>{title}</h2> : null}
      <p className="lead">
        <strong>Buy ceiling {formatUsd(assessment.buyCeilingUsd)}</strong>
        {" · "}
        Confidence: {assessment.confidence}
      </p>
      <p>{assessment.summary}</p>
      <section>
        <h3>Expected resale range</h3>
        <ul className="refuse">
          <li>Low: {formatUsd(assessment.resaleLowUsd)}</li>
          <li>Mid: {formatUsd(assessment.resaleMidUsd)}</li>
          <li>High: {formatUsd(assessment.resaleHighUsd)}</li>
          <li>
            Based on {assessment.sampleSize} similar listings. {assessment.methodNote}
          </li>
        </ul>
      </section>
      <section>
        <h3>Example costs (estimates)</h3>
        <ul className="refuse">
          {assessment.costLines.map((line) => (
            <li key={line}>{line}</li>
          ))}
          <li>All-in at this ask (ask + title + recon): {formatUsd(assessment.allInUsd)}</li>
          <li>Conservative proceeds (low resale after friction): {formatUsd(assessment.conservativeProceedsUsd)}</li>
          <li>
            Estimated margin at this ask: {formatUsd(assessment.marginUsd)} — not a promise you will earn this.
          </li>
        </ul>
      </section>
      <p className="hint">
        Missing history is not the same as clean. Get a title report and a pre-purchase inspection before you buy.
      </p>
    </article>
  );
}
