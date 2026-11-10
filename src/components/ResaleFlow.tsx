"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { AgentDecisionTrail } from "@/components/AgentDecisionTrail";
import { ResaleDecisionJournalView } from "@/components/ResaleDecisionJournal";
import { useAccountLoad } from "@/components/use-account-load";
import type { AgentVerdict } from "@/domain/agent-verdict-schema";
import type { ResaleDecisionJournal } from "@/domain/resale-decision-journal";
import { formatUsd } from "@/domain/format";
import { NOTE_BODY_STYLES } from "@/domain/note-intake";
import { NOT_ENOUGH_SIMILAR_CARS } from "@/domain/price-evaluation";
import type { ResaleAssessment } from "@/domain/resale-evaluate";
import type { ResaleCandidatePnl } from "@/domain/resale-pnl";
import { SEARCH_RADII_MILES } from "@/domain/need";
import { publishCreditBalance } from "@/domain/credit-balance-event";

export function ResaleFlow() {
  const account = useAccountLoad();
  const router = useRouter();
  const loading = account.phase === "loading";
  const signedIn = account.phase === "loaded" && account.body?.authenticated === true;
  const authConfigured = account.body?.auth?.configured !== false;
  const credits = typeof account.body?.credits === "number" ? account.body.credits : null;

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
          Resale searches live dealer inventory for flips inside your budget. A free account keeps that usage tied to you.
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

  return (
    <ResaleSearchForm
      credits={credits}
      onAuthLost={() => router.push(`/login?callbackUrl=${encodeURIComponent("/resale")}`)}
    />
  );
}

type SearchResult = {
  best: ResaleCandidatePnl | null;
  alternatives: ResaleCandidatePnl[];
  verdictAction: string;
  confidence: "High" | "Medium" | "Low";
  agentVerdict: AgentVerdict;
  journal: ResaleDecisionJournal;
  headline: string;
  message: string;
  nextStep: string;
  creditNote: string;
  balance?: number;
  budgetUsd: number;
  zip?: string | null;
  distanceMiles?: number | null;
};

function ResaleSearchForm({ credits, onAuthLost }: { credits: number | null; onAuthLost: () => void }) {
  const filtersId = useId();
  const [budget, setBudget] = useState("");
  const [zip, setZip] = useState("");
  const [radius, setRadius] = useState<string>("");
  const [bodyStyle, setBodyStyle] = useState("");
  const [makes, setMakes] = useState("");
  const [milesMax, setMilesMax] = useState("");
  const [repairAbility, setRepairAbility] = useState<"unknown" | "none" | "minor" | "major">("unknown");
  const [timeToSell, setTimeToSell] = useState<"any" | "faster" | "unknown">("any");
  const [targetProfit, setTargetProfit] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [pending, setPending] = useState(false);
  const [progressLabel, setProgressLabel] = useState<string | null>(null);
  const [progressSteps, setProgressSteps] = useState<
    Array<{ id: number; label: string; status: "pending" | "current" | "done" }> | null
  >(null);
  const [partialJournal, setPartialJournal] = useState<ResaleDecisionJournal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [idemKey] = useState(
    () => `resale-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`,
  );

  type JobBody = {
    error?: string;
    message?: string;
    jobId?: string;
    step?: number;
    nextStep?: number | null;
    done?: boolean;
    progress?: {
      label?: string;
      steps?: Array<{ id: number; label: string; status: "pending" | "current" | "done" }>;
    };
    best?: ResaleCandidatePnl | null;
    alternatives?: ResaleCandidatePnl[];
    verdictAction?: string;
    confidence?: "High" | "Medium" | "Low";
    agentVerdict?: AgentVerdict;
    journal?: ResaleDecisionJournal;
    headline?: string;
    nextStepHint?: string;
    creditNote?: string;
    balance?: number;
    budgetUsd?: number;
    chargedCredit?: boolean;
  };

  function applyProgress(body: JobBody) {
    if (body.progress?.steps?.length) setProgressSteps(body.progress.steps);
    if (body.progress?.label) setProgressLabel(body.progress.label);
    if (body.journal) setPartialJournal(body.journal);
  }

  function finishFromBody(body: JobBody) {
    if (!body.agentVerdict || !body.confidence || !body.verdictAction) {
      const hint =
        typeof body.nextStepHint === "string" && body.nextStepHint.trim()
          ? ` ${body.nextStepHint.trim()}`
          : "";
      setError(`${body.message ?? "The resale search did not finish."}${hint}`);
      return;
    }
    if (typeof body.balance === "number" && Number.isFinite(body.balance)) {
      publishCreditBalance(body.balance);
    }
    setResult({
      best: body.best ?? null,
      alternatives: body.alternatives ?? [],
      verdictAction: body.verdictAction,
      confidence: body.confidence,
      agentVerdict: body.agentVerdict,
      journal: body.journal ?? {
        schemaVersion: "lemonless.resale_journal.v1",
        steps: [],
        servCalls: 0,
        servCallCap: 6,
      },
      headline: body.headline ?? "Resale search",
      message: body.message ?? "",
      nextStep: body.nextStepHint ?? "",
      creditNote: body.creditNote ?? "1 report credit per delivered resale search.",
      balance: body.balance,
      budgetUsd: typeof body.budgetUsd === "number" ? body.budgetUsd : Number(budget),
      zip: zip.trim() || null,
      distanceMiles: radius === "" ? null : Number(radius),
    });
    setProgressLabel(null);
    setProgressSteps(null);
    setPartialJournal(null);
  }

  async function submitSearch() {
    setError(null);
    setResult(null);
    setPartialJournal(null);
    setProgressSteps(null);
    setProgressLabel("Plan & inventory");
    setPending(true);
    try {
      const response = await fetch("/api/resale/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          budgetUsd: budget,
          zip: zip.trim() || null,
          distanceMiles: radius === "" ? null : Number(radius),
          bodyStyle: bodyStyle || null,
          preferredMakes: makes,
          milesMax: milesMax.trim() === "" ? null : milesMax,
          repairAbility,
          timeToSell,
          targetProfitUsd: targetProfit.trim() === "" ? null : targetProfit,
          searchIdempotencyKey: idemKey,
        }),
      });
      const body = (await response.json()) as JobBody;
      if (response.status === 401 || response.status === 403) {
        if (body.error === "auth_required" || body.error === "email_unverified" || body.error === "auth_unconfigured") {
          onAuthLost();
          return;
        }
        if (body.error === "credits_required") {
          setError(body.message ?? "Resale search costs 1 report credit.");
          return;
        }
      }
      if (!response.ok) {
        const hint =
          typeof body.nextStepHint === "string" && body.nextStepHint.trim()
            ? ` ${body.nextStepHint.trim()}`
            : "";
        setError(`${body.message ?? "The resale search did not finish."}${hint}`);
        return;
      }

      // Legacy / replay full delivery in one response.
      if (body.done === true || (body.agentVerdict && body.confidence && body.verdictAction && !body.jobId)) {
        finishFromBody(body);
        return;
      }

      if (!body.jobId) {
        setError(body.message ?? "The resale search did not return a job id.");
        return;
      }

      applyProgress(body);
      let jobId = body.jobId;
      let next = body.nextStep ?? null;
      let latest = body;

      while (next != null && latest.done !== true) {
        const stepRes = await fetch("/api/resale/search/step", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId, step: next }),
        });
        const stepBody = (await stepRes.json()) as JobBody;
        if (stepRes.status === 401 || stepRes.status === 403) {
          if (
            stepBody.error === "auth_required" ||
            stepBody.error === "email_unverified" ||
            stepBody.error === "auth_unconfigured"
          ) {
            onAuthLost();
            return;
          }
          if (stepBody.error === "forbidden") {
            setError(stepBody.message ?? "This resale job belongs to another account.");
            return;
          }
          if (stepBody.error === "credits_required") {
            setError(stepBody.message ?? "Resale search costs 1 report credit.");
            return;
          }
        }
        if (!stepRes.ok) {
          setError(stepBody.message ?? "A resale search step did not finish. Retry — credit is only charged on delivery.");
          applyProgress(stepBody);
          return;
        }
        applyProgress(stepBody);
        latest = stepBody;
        if (stepBody.jobId) jobId = stepBody.jobId;
        next = stepBody.nextStep ?? null;
        if (stepBody.done) break;
        // SERV finished but debit failed — show the result honestly; do not spin on step 4.
        if (
          stepBody.step != null &&
          stepBody.step >= 6 &&
          stepBody.agentVerdict &&
          stepBody.verdictAction &&
          stepBody.chargedCredit === false
        ) {
          break;
        }
      }

      finishFromBody(latest);
    } catch {
      setError("The resale search did not finish. Retry — failed searches never debit a credit.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="panel resale-flow">
      <p className="hint">
        Budget is the only required field. Everything else is optional. Results always include a verdict (buy /
        negotiate / pass / needs inspection) with High / Medium / Low confidence — never a dead end. Figures are
        estimates from asking prices — not sold prices, and not a profit guarantee.
      </p>
      {credits != null ? (
        <p className="hint">
          Credits on this account: {credits}. This search uses 1 report credit when results are delivered.
        </p>
      ) : null}

      <div className="field">
        <label htmlFor="resale-budget">Budget (required)</label>
        <input
          id="resale-budget"
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
          inputMode="decimal"
          placeholder="e.g. 12,000"
          required
        />
      </div>

      <p className="btn-row">
        <button
          type="button"
          className="ghost"
          aria-expanded={showFilters}
          aria-controls={filtersId}
          onClick={() => setShowFilters((v) => !v)}
        >
          {showFilters ? "Hide optional filters" : "Optional filters"}
        </button>
      </p>

      {showFilters ? (
        <div id={filtersId} className="resale-optional-filters">
          <div className="pair">
            <div className="field">
              <label htmlFor="resale-zip">ZIP</label>
              <input
                id="resale-zip"
                value={zip}
                onChange={(e) => setZip(e.target.value)}
                inputMode="numeric"
                placeholder="Nationwide if blank"
              />
            </div>
            <div className="field">
              <label htmlFor="resale-radius">Radius (miles)</label>
              <select id="resale-radius" value={radius} onChange={(e) => setRadius(e.target.value)}>
                <option value="">Nationwide</option>
                {SEARCH_RADII_MILES.map((miles) => (
                  <option key={miles} value={String(miles)}>
                    {miles} miles
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="pair">
            <div className="field">
              <label htmlFor="resale-body">Body type</label>
              <select id="resale-body" value={bodyStyle} onChange={(e) => setBodyStyle(e.target.value)}>
                <option value="">Any</option>
                {NOTE_BODY_STYLES.map((style) => (
                  <option key={style} value={style}>
                    {style}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="resale-makes">Makes (comma-separated)</label>
              <input
                id="resale-makes"
                value={makes}
                onChange={(e) => setMakes(e.target.value)}
                placeholder="e.g. Honda, Toyota"
              />
            </div>
          </div>
          <div className="pair">
            <div className="field">
              <label htmlFor="resale-miles-max">Max mileage</label>
              <input
                id="resale-miles-max"
                value={milesMax}
                onChange={(e) => setMilesMax(e.target.value)}
                inputMode="numeric"
                placeholder="No cap if blank"
              />
            </div>
            <div className="field">
              <label htmlFor="resale-target-profit">Target profit (optional)</label>
              <input
                id="resale-target-profit"
                value={targetProfit}
                onChange={(e) => setTargetProfit(e.target.value)}
                inputMode="decimal"
                placeholder="e.g. 1,500"
              />
            </div>
          </div>
          <fieldset className="field">
            <legend>Willingness to invest in repairs</legend>
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
                    name="repair-search"
                    checked={repairAbility === value}
                    onChange={() => setRepairAbility(value)}
                  />{" "}
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="field">
            <legend>Time to sell preference</legend>
            <div className="pills" role="radiogroup" aria-label="Time to sell">
              {(
                [
                  ["any", "Any"],
                  ["faster", "Prefer faster"],
                  ["unknown", "Do not rank on speed"],
                ] as const
              ).map(([value, label]) => (
                <label className="pill" key={value}>
                  <input
                    type="radio"
                    name="time-to-sell"
                    checked={timeToSell === value}
                    onChange={() => setTimeToSell(value)}
                  />{" "}
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      ) : null}

      <div className="btn-row">
        <button className="action" type="button" disabled={pending || !budget.trim()} onClick={() => void submitSearch()}>
          {pending ? progressLabel ?? "Searching flips…" : "Find flips (1 credit)"}
        </button>
      </div>

      {pending && progressSteps ? (
        <ol className="progress" aria-label="Resale search progress" aria-live="polite">
          {progressSteps.map((step) => (
            <li
              key={step.id}
              className={
                step.status === "current" ? "is-current" : step.status === "done" ? "is-done" : undefined
              }
            >
              {step.label}
            </li>
          ))}
        </ol>
      ) : null}

      {pending && partialJournal && partialJournal.steps.length > 0 ? (
        <ResaleDecisionJournalView journal={partialJournal} defaultOpen />
      ) : null}

      {error ? (
        <p className="warn" role="alert">
          {error}
        </p>
      ) : null}

      {result ? <ResaleSearchResultView result={result} /> : null}

      <details className="onboarding-note">
        <summary>
          <strong>One-car buy-ceiling estimate</strong> (optional, no inventory search)
        </summary>
        <ResaleEvaluateForm onAuthLost={onAuthLost} />
      </details>
    </div>
  );
}

function ResaleSearchResultView({ result }: { result: SearchResult }) {
  const watchHref = (() => {
    if (!result.budgetUsd) return null;
    const q = new URLSearchParams({ mode: "flip", priceMax: String(result.budgetUsd) });
    if (result.zip) q.set("zip", result.zip);
    if (result.distanceMiles != null && Number.isFinite(result.distanceMiles)) {
      q.set("distanceMiles", String(result.distanceMiles));
    } else {
      // Match nationwide Resale scope — Flip watches may save without a radius.
      q.set("nationwide", "1");
    }
    return `/radar?${q.toString()}`;
  })();
  return (
    <article className="warn-box check-result" aria-live="polite">
      <h2>{result.headline}</h2>
      <p className="lead">
        <strong>Verdict: {result.verdictAction}</strong>
        {" · "}
        Confidence: {result.confidence}
      </p>
      <p>{result.message}</p>
      <p className="hint">{result.nextStep}</p>
      {watchHref ? (
        <p className="btn-row">
          <Link className="action" href={watchHref}>
            Watch this budget on Deal Radar
          </Link>
        </p>
      ) : null}
      <p className="hint">{result.creditNote}</p>
      {typeof result.balance === "number" ? <p className="hint">Balance after search: {result.balance}</p> : null}

      {result.best ? <CandidateCard title="Best flip" candidate={result.best} featured /> : null}
      {result.alternatives.length > 0 ? (
        <section>
          <h3>Alternatives</h3>
          {result.alternatives.map((item) => (
            <CandidateCard key={item.vin} title={`${item.listing.year} ${item.listing.make} ${item.listing.model}`} candidate={item} />
          ))}
        </section>
      ) : null}

      <ResaleDecisionJournalView journal={result.journal} defaultOpen />
      <AgentDecisionTrail verdict={result.agentVerdict} defaultOpen />
    </article>
  );
}

function CandidateCard({
  title,
  candidate,
  featured = false,
}: {
  title: string;
  candidate: ResaleCandidatePnl;
  featured?: boolean;
}) {
  const l = candidate.listing;
  return (
    <section className={featured ? "resale-best" : undefined}>
      <h3>
        {title}
        {featured ? "" : ""}
      </h3>
      <p>
        {l.year} {l.make} {l.model}
        {l.trim ? ` ${l.trim}` : ""}
        {l.miles != null ? ` · ${l.miles.toLocaleString("en-US")} mi` : ""}
        {l.dealer ? ` · ${l.dealer}` : ""}
        {l.city || l.state || l.zip
          ? ` · listing feed: ${[l.city, l.state, l.zip].filter(Boolean).join(", ")}`
          : ""}
      </p>
      <ul className="refuse">
        <li>
          Ranking uses risk-adjusted mid profit: mid × deep-check risk × (low+mid)/(2×mid) when both
          ends exist; thin comps (&lt;3 / &lt;5 in the mileage band) already cut the risk multiplier.
          Comps in this scan: {candidate.compCount}.
        </li>
        <li>Ask: {formatUsd(candidate.askingUsd)}</li>
        <li>
          Negotiated offer estimate: {formatUsd(candidate.negotiatedOfferUsd)} — {candidate.negotiateBasis}
        </li>
        <li>
          Sales tax: {candidate.salesTaxUsd != null ? formatUsd(candidate.salesTaxUsd) : "unknown"} — {candidate.salesTaxBasis}
        </li>
        <li>
          Title/registration: unknown dollar amount — {candidate.titleRegistrationBasis}
        </li>
        <li>
          Title/fee assumption used in P&L: {formatUsd(candidate.titleFeeAssumptionUsd)} — {candidate.titleFeeBasis}
        </li>
        <li>
          Reconditioning estimate: {formatUsd(candidate.reconUsd)} — {candidate.reconBasis}
        </li>
        <li>
          Expected resale ({candidate.resaleChannel.replace("_", " ")}):{" "}
          {candidate.resaleLowUsd != null ? formatUsd(candidate.resaleLowUsd) : "—"} /{" "}
          {candidate.resaleMidUsd != null ? formatUsd(candidate.resaleMidUsd) : "—"} /{" "}
          {candidate.resaleHighUsd != null ? formatUsd(candidate.resaleHighUsd) : "—"} — {candidate.resaleChannelBasis}
        </li>
        <li>
          Expected net profit
          {candidate.profitScopeLabel ? ` (${candidate.profitScopeLabel})` : ""}:{" "}
          {candidate.profitLowUsd != null ? formatUsd(candidate.profitLowUsd) : "—"} to{" "}
          {candidate.profitHighUsd != null ? formatUsd(candidate.profitHighUsd) : "—"} (mid{" "}
          {candidate.profitMidUsd != null ? formatUsd(candidate.profitMidUsd) : "—"})
          {!candidate.salesTaxKnown && candidate.rankingProfitMidUsd != null
            ? ` · ranking uses ${formatUsd(candidate.rankingProfitMidUsd)} after the max statewide-base tax haircut`
            : ""}
        </li>
        <li>ROI (mid): {candidate.roiPctMid != null ? `${candidate.roiPctMid}%` : "unknown"}</li>
        <li>
          Estimated days to sell:{" "}
          {candidate.estimatedDaysToSell != null ? String(candidate.estimatedDaysToSell) : "unknown"} —{" "}
          {candidate.daysToSellBasis}
        </li>
        <li>
          Confidence: {candidate.confidence} — {candidate.confidenceBasis}
        </li>
        <li>Similar listings in this scan: {candidate.compCount}</li>
      </ul>
      {candidate.provenance?.length ? (
        <>
          <h4>Number sources</h4>
          <ul className="refuse">
            {candidate.provenance.map((row) => (
              <li key={row.field}>
                {row.field}: {row.display} · {row.source}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <h4>Key risks</h4>
      <ul className="refuse">
        {candidate.risks.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <h4>Check before buying</h4>
      <ul className="refuse">
        {candidate.checkBeforeBuying.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {l.vdp ? (
        <p>
          <a href={l.vdp} target="_blank" rel="noreferrer">
            Open listing
          </a>
        </p>
      ) : null}
    </section>
  );
}

function ResaleEvaluateForm({ onAuthLost }: { onAuthLost: () => void }) {
  const yearNow = new Date().getUTCFullYear();
  const [year, setYear] = useState(String(yearNow - 4));
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [trim, setTrim] = useState("");
  const [miles, setMiles] = useState("");
  const [asking, setAsking] = useState("");
  const [zip, setZip] = useState("");
  const [accidents, setAccidents] = useState("");
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
          accidentCount: accidents.trim() === "" ? null : Number(accidents),
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
    <div>
      <p className="hint">
        Optional what-if for one car you already have in mind. Does not search inventory and does not use a report
        credit.
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
        <label htmlFor="resale-accidents">Known accidents (optional)</label>
        <input
          id="resale-accidents"
          value={accidents}
          onChange={(e) => setAccidents(e.target.value)}
          inputMode="numeric"
          placeholder="Leave blank if you do not know"
        />
      </div>
      <div className="field">
        <label htmlFor="resale-eval-zip">U.S. ZIP for nearby comps (optional)</label>
        <input
          id="resale-eval-zip"
          value={zip}
          onChange={(e) => setZip(e.target.value)}
          inputMode="numeric"
          placeholder="Nationwide if blank"
        />
      </div>
      <fieldset className="field">
        <legend>Repair ability (affects recon estimate only)</legend>
        <div className="pills" role="radiogroup" aria-label="Repair ability for estimate">
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
                name="repair-eval"
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
      {assessment ? <ResaleEvalResult title={title} assessment={assessment} /> : null}
    </div>
  );
}

function ResaleEvalResult({ title, assessment }: { title: string | null; assessment: ResaleAssessment }) {
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
