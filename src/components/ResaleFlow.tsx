"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { ServDecisionJournal } from "@/components/ServDecisionJournal";
import { MakeModelFields } from "@/components/MakeModelFields";
import { useAccountLoad } from "@/components/use-account-load";
import type { AgentVerdict } from "@/domain/agent-verdict-schema";
import type { DecisionProofRecord } from "@/domain/decision-proof-view";
import type { ResaleDecisionJournal } from "@/domain/resale-decision-journal";
import { formatUsd } from "@/domain/format";
import { criteriaParseLabel, criteriaParseTechnicalLine } from "@/domain/radar-criteria-provenance";
import { NOTE_BODY_STYLES } from "@/domain/note-intake";
import { NOT_ENOUGH_SIMILAR_CARS } from "@/domain/price-evaluation";
import type { ResaleAssessment } from "@/domain/resale-evaluate";
import type { ResaleCandidatePnl } from "@/domain/resale-pnl";
import { resalePrimaryListingLink } from "@/domain/resale-listing-link";
import { resaleCardCopy } from "@/domain/resale-outcome";
import { resaleEdgeSentence, resalePickHeading } from "@/domain/resale-presentation";
import { SEARCH_RADII_MILES } from "@/domain/need";
import { refreshPublishedCreditBalance } from "@/domain/credit-balance-event";
import { RunMirror } from "./RunMirror";

export function ResaleFlow() {
  const account = useAccountLoad();
  const router = useRouter();
  const loading = account.phase === "loading";
  const signedIn = account.phase === "loaded" && account.body?.authenticated === true;
  const [keptForm, setKeptForm] = useState(false);
  useEffect(() => {
    if (signedIn) setKeptForm(true);
  }, [signedIn]);
  const authConfigured = account.body?.auth?.configured !== false;
  const credits = typeof account.body?.credits === "number" ? account.body.credits : null;

  if (loading && !keptForm) {
    return (
      <div className="panel" aria-busy="true">
        <p className="hint">Checking your sign-in…</p>
      </div>
    );
  }

  if (!signedIn && !keptForm) {
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
  verdictLabel: string;
  confidence: "High" | "Medium" | "Low";
  reviewNote: string | null;
  agentVerdict: AgentVerdict;
  journal: ResaleDecisionJournal;
  proofRecords: DecisionProofRecord[];
  headline: string;
  message: string;
  nextStep: string;
  creditNote: string;
  balance?: number;
  budgetUsd: number;
  zip?: string | null;
  distanceMiles?: number | null;
  freeText?: string | null;
  bodyStyle?: string | null;
  preferredMakes?: string[];
  make?: string;
  model?: string;
  yearMin?: number | null;
  yearMax?: number | null;
  milesMax?: number | null;
  repairAbility?: "unknown" | "none" | "minor" | "major";
  targetProfitUsd?: number | null;
  criteriaParseSource?: "serv" | "code" | "form";
  criteriaResponseId?: string | null;
};

function ResaleSearchForm({ credits, onAuthLost }: { credits: number | null; onAuthLost: () => void }) {
  const router = useRouter();
  const filtersId = useId();
  const [budget, setBudget] = useState("");
  const [freeText, setFreeText] = useState("");
  const [zip, setZip] = useState("");
  const [radius, setRadius] = useState<string>("");
  const [bodyStyle, setBodyStyle] = useState("");
  const [makes, setMakes] = useState("");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [yearMin, setYearMin] = useState("");
  const [yearMax, setYearMax] = useState("");
  const [milesMax, setMilesMax] = useState("");
  const [repairAbility, setRepairAbility] = useState<"unknown" | "none" | "minor" | "major">("unknown");
  const [timeToSell, setTimeToSell] = useState<"any" | "faster" | "unknown">("any");
  const [sellWithinDays, setSellWithinDays] = useState("30");
  const [targetProfit, setTargetProfit] = useState("");
  const [criteriaParse, setCriteriaParse] = useState<{
    source: "serv" | "code" | "form";
    responseId: string | null;
    label: string;
  } | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [pending, setPending] = useState(false);
  const [progressLabel, setProgressLabel] = useState<string | null>(null);
  const [progressSteps, setProgressSteps] = useState<
    Array<{ id: number; label: string; status: "pending" | "current" | "done" }> | null
  >(null);
  const [partialJournal, setPartialJournal] = useState<ResaleDecisionJournal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [followRun, setFollowRun] = useState(false);
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
    verdictLabel?: string;
    confidence?: "High" | "Medium" | "Low";
    reviewNote?: string | null;
    agentVerdict?: AgentVerdict;
    journal?: ResaleDecisionJournal;
    proofRecords?: DecisionProofRecord[];
    runId?: string | null;
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

  function openRun(id: string) {
    setRunId(id);
    window.sessionStorage.setItem("lemonless-resale-run", id);
    router.push(`/run/${id}`);
  }

  function finishFromBody(body: JobBody) {
    if (typeof body.runId === "string" && body.runId) openRun(body.runId);
    if (!body.agentVerdict || !body.confidence || !body.verdictAction) {
      if (runId || body.runId) {
        setFollowRun(true);
        return;
      }
      const hint =
        typeof body.nextStepHint === "string" && body.nextStepHint.trim()
          ? ` ${body.nextStepHint.trim()}`
          : "";
      setError(`${body.message ?? "The resale search did not finish."}${hint}`);
      return;
    }
    void refreshPublishedCreditBalance();
    setResult({
      best: body.best ?? null,
      alternatives: body.alternatives ?? [],
      verdictAction: body.verdictAction,
      verdictLabel: body.verdictLabel || body.headline || "Pass",
      confidence: body.confidence,
      reviewNote: body.reviewNote ?? null,
      agentVerdict: body.agentVerdict,
      journal: body.journal ?? {
        schemaVersion: "lemonless.resale_journal.v1",
        steps: [],
        servCalls: 0,
      },
      proofRecords: Array.isArray(body.proofRecords) ? body.proofRecords : [],
      headline: body.headline ?? "Resale search",
      message: body.message ?? "",
      nextStep: body.nextStepHint ?? "",
      creditNote: body.creditNote ?? "1 report credit per delivered resale search.",
      balance: body.balance,
      budgetUsd: typeof body.budgetUsd === "number" ? body.budgetUsd : Number(budget),
      zip: zip.trim() || null,
      distanceMiles: radius === "" ? null : Number(radius),
      freeText: freeText.trim() || null,
      bodyStyle: bodyStyle || null,
      preferredMakes: makes
        .split(/[,;/|]+/)
        .map((part) => part.trim())
        .filter(Boolean),
      make: make || undefined,
      model: model || undefined,
      yearMin: yearMin ? Number(yearMin) : null,
      yearMax: yearMax ? Number(yearMax) : null,
      milesMax: milesMax.trim() === "" ? null : Number(milesMax.replace(/[^0-9.]/g, "")),
      repairAbility,
      targetProfitUsd: targetProfit.trim() === "" ? null : Number(targetProfit.replace(/[^0-9.]/g, "")),
      criteriaParseSource: criteriaParse?.source ?? "form",
      criteriaResponseId: criteriaParse?.responseId ?? null,
    });
    setProgressLabel(null);
    setProgressSteps(null);
    setPartialJournal(null);
    setFollowRun(true);
  }

  useEffect(() => {
    if (!followRun || !runId || pending) return;
    router.replace(`/run/${runId}`);
  }, [followRun, runId, pending, router]);

  async function parseFreeText() {
    if (!freeText.trim()) {
      setCriteriaParse({ source: "form", responseId: null, label: criteriaParseLabel({ source: "form", responseId: null }) });
      return;
    }
    try {
      const response = await fetch("/api/need", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: freeText,
          mode: "flip",
          budgetUsd: budget.trim() ? Number(budget.replace(/[^0-9.]/g, "")) || null : null,
          budgetKnown: Boolean(budget.trim()),
          zip: zip.trim() || null,
          distanceMiles: radius === "" ? null : Number(radius),
        }),
      });
      const body = (await response.json()) as {
        need?: {
          budgetUsd?: number | null;
          zip?: string | null;
          distanceMiles?: number | null;
          bodyStyle?: string | null;
          preferredMakes?: string[];
          make?: string | null;
          preferredModels?: Array<{ make: string; model: string } | string>;
          yearMin?: number | null;
          yearMax?: number | null;
          milesMax?: number | null;
          repairAbility?: "unknown" | "none" | "minor" | "major";
          targetProfitUsd?: number | null;
        };
        criteriaParse?: { source: "serv" | "code" | "form"; responseId: string | null; label: string };
        message?: string;
      };
      if (!response.ok || !body.need) {
        setCriteriaParse({
          source: "code",
          responseId: null,
          label: criteriaParseLabel({ source: "code", responseId: null }),
        });
        return;
      }
      const parsed = body.criteriaParse ?? { source: "code" as const, responseId: null, label: "" };
      setCriteriaParse({
        source: parsed.source,
        responseId: parsed.responseId,
        label: criteriaParseLabel(parsed),
      });
      if (body.need.budgetUsd != null && !budget.trim()) setBudget(String(body.need.budgetUsd));
      if (body.need.zip && !zip.trim()) setZip(body.need.zip);
      if (body.need.distanceMiles != null && radius === "") setRadius(String(body.need.distanceMiles));
      if (body.need.bodyStyle && !bodyStyle) setBodyStyle(body.need.bodyStyle);
      const noteText = freeText.toLowerCase();
      const namedMakes = (body.need.preferredMakes ?? []).filter((item) => noteText.includes(item.toLowerCase()));
      if (namedMakes.length && !makes.trim()) setMakes(namedMakes.join(", "));
      if (body.need.make && !make && noteText.includes(body.need.make.toLowerCase())) setMake(body.need.make);
      const firstModel = body.need.preferredModels?.[0];
      if (firstModel && !model) {
        const modelName = typeof firstModel === "string" ? firstModel : firstModel.model;
        const makeName = typeof firstModel === "string" ? body.need.make : firstModel.make;
        if (modelName && noteText.includes(modelName.toLowerCase())) {
          setModel(modelName);
          if (makeName && !make && noteText.includes(makeName.toLowerCase())) setMake(makeName);
        }
      }
      if (body.need.yearMin != null && !yearMin) setYearMin(String(body.need.yearMin));
      if (body.need.yearMax != null && !yearMax) setYearMax(String(body.need.yearMax));
      if (body.need.milesMax != null && !milesMax.trim()) setMilesMax(String(body.need.milesMax));
      if (body.need.repairAbility && repairAbility === "unknown") setRepairAbility(body.need.repairAbility);
      if (body.need.targetProfitUsd != null && !targetProfit.trim()) setTargetProfit(String(body.need.targetProfitUsd));
      setShowFilters(true);
    } catch {
      setCriteriaParse({
        source: "code",
        responseId: null,
        label: criteriaParseLabel({ source: "code", responseId: null }),
      });
    }
  }

  async function submitSearch() {
    setError(null);
    setResult(null);
    setPartialJournal(null);
    setProgressSteps(null);
    setProgressLabel("Searching cars for sale");
    setPending(true);
    try {
      if (freeText.trim() && !criteriaParse) {
        await parseFreeText();
      }
      const response = await fetch("/api/resale/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          budgetUsd: budget,
          zip: zip.trim() || null,
          distanceMiles: radius === "" ? null : Number(radius),
          bodyStyle: bodyStyle || null,
          preferredMakes: make ? [make] : makes,
          make: make || undefined,
          model: model || undefined,
          preferredModels: make && model ? [{ make, model }] : undefined,
          yearMin: yearMin ? Number(yearMin) : null,
          yearMax: yearMax ? Number(yearMax) : null,
          milesMax: milesMax.trim() === "" ? null : milesMax,
          repairAbility,
          timeToSell,
          sellWithinDays: sellWithinDays.trim() === "" ? null : sellWithinDays,
          targetProfitUsd: targetProfit.trim() === "" ? null : targetProfit,
          freeText: freeText.trim() || null,
          criteriaParseSource: criteriaParse?.source ?? "form",
          criteriaResponseId: criteriaParse?.responseId ?? null,
          searchIdempotencyKey: idemKey,
          runId: null,
        }),
      });
      const body = (await response.json()) as JobBody;
      if (typeof body.runId === "string" && body.runId) setRunId(body.runId);
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
      let activeRun = typeof body.runId === "string" ? body.runId : null;
      let jobId = body.jobId;
      let next = body.nextStep ?? null;
      let latest = body;

      while (next != null && latest.done !== true) {
        const stepRes = await fetch("/api/resale/search/step", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId, step: next, runId: activeRun }),
        });
        const stepBody = (await stepRes.json()) as JobBody;
        if (typeof stepBody.runId === "string" && stepBody.runId) {
          activeRun = stepBody.runId;
          setRunId(stepBody.runId);
        }
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

  const [savedRunId, setSavedRunId] = useState<string | null>(null);
  useEffect(() => {
    const saved = window.sessionStorage.getItem("lemonless-resale-run");
    if (saved) setSavedRunId(saved);
  }, []);

  useEffect(() => {
    if (!result) return;
    document.getElementById("resale-result")?.scrollIntoView?.({ block: "start" });
  }, [result]);

  function startNewSearch() {
    setResult(null);
    setRunId(null);
    setFollowRun(false);
    setError(null);
    setProgressLabel(null);
    setProgressSteps(null);
    setPartialJournal(null);
    setSavedRunId(null);
    try {
      window.sessionStorage.removeItem("lemonless-resale-run");
    } catch {
      /* ignore */
    }
  }

  const resultIsPrimary = Boolean(result) || followRun;

  return (
    <div className="panel resale-flow">
      {runId && !result ? <RunMirror runId={runId} onPhase={(phase) => {
        if (phase === "finished" || phase === "stopped") setFollowRun(true);
      }} /> : null}
      {result ? (
        <div id="resale-result">
          <ResaleSearchResultView result={result} runId={runId} />
        </div>
      ) : null}
      {resultIsPrimary ? (
        <p className="btn-row">
          <button type="button" className="quiet" onClick={startNewSearch}>
            New search
          </button>
        </p>
      ) : null}
      {!resultIsPrimary && savedRunId && !runId && !result ? (
        <p className="hint">
          You have a recent resale search.{" "}
          <button
            type="button"
            className="quiet"
            onClick={() => {
              setRunId(savedRunId);
              setFollowRun(true);
            }}
          >
            Resume
          </button>{" "}
          <button
            type="button"
            className="quiet"
            onClick={() => {
              window.sessionStorage.removeItem("lemonless-resale-run");
              setSavedRunId(null);
            }}
          >
            New search
          </button>
        </p>
      ) : null}
      {!resultIsPrimary ? (
      <>
      <p className="hint">
        Budget is the only required field. Profit target and repair skill are optional. When cars match, the result
        includes a verdict (buy, negotiate, pass, or get it inspected) with High, Medium, or Low confidence. If no
        cars match, you get that explanation and no verdict. Figures are estimates from asking prices — not sold
        prices, and not a profit guarantee.
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

      <div className="field">
        <label htmlFor="resale-sell-within">Sell within (days)</label>
        <input
          id="resale-sell-within"
          value={sellWithinDays}
          onChange={(e) => setSellWithinDays(e.target.value)}
          inputMode="numeric"
          placeholder="30"
        />
        <p className="hint">Default is 30. A car estimated to take longer is not picked. Clear this for no window.</p>
      </div>

      <div className="field">
        <label htmlFor="resale-note">Describe the flip in your own words (optional)</label>
        <textarea
          id="resale-note"
          rows={3}
          value={freeText}
          onChange={(e) => {
            setFreeText(e.target.value);
            setCriteriaParse(null);
          }}
          placeholder="e.g. Honda or Toyota sedan under 80k miles near Dallas, light bodywork OK"
        />
        <p className="btn-row">
          <button type="button" className="quiet" onClick={() => void parseFreeText()} disabled={!freeText.trim() || pending}>
            Turn this note into filters
          </button>
        </p>
        {criteriaParse ? (
          <>
            <p className="hint">{criteriaParse.label}</p>
            {criteriaParseTechnicalLine(criteriaParse) ? (
              <details className="onboarding-note">
                <summary>Technical details</summary>
                <p className="hint">{criteriaParseTechnicalLine(criteriaParse)}</p>
              </details>
            ) : null}
          </>
        ) : null}
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
          </div>
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
                placeholder="Optional. Leave blank for no target."
              />
            </div>
          </div>
          <fieldset className="field">
            <legend>Repair skill (optional)</legend>
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
        <ServDecisionJournal resaleJournal={partialJournal} defaultOpen />
      ) : null}

      {error ? (
        <p className="warn" role="alert">
          {error}
        </p>
      ) : null}
      </>
      ) : null}

      {/* Page copy promises this stays available below the search — keep it after results too. */}
      <details className="onboarding-note">
        <summary>
          <strong>One-car buy-ceiling estimate</strong> (optional, no inventory search)
        </summary>
        <ResaleEvaluateForm onAuthLost={onAuthLost} />
      </details>
    </div>
  );
}

function ResaleSearchResultView({ result, runId }: { result: SearchResult; runId: string | null }) {
  const router = useRouter();
  const [watchPending, setWatchPending] = useState(false);
  const [watchError, setWatchError] = useState<string | null>(null);
  const parseRecord = {
    source: result.criteriaParseSource ?? ("form" as const),
    responseId: result.criteriaResponseId ?? null,
  };
  const parseLabel = criteriaParseLabel(parseRecord);
  const parseTechnical = criteriaParseTechnicalLine(parseRecord);

  async function watchWithRadar() {
    if (!result.budgetUsd) return;
    setWatchPending(true);
    setWatchError(null);
    try {
      const response = await fetch("/api/radar/searches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Resale watch",
          mode: "flip",
          criteria: {
            priceMax: result.budgetUsd,
            zip: result.zip ?? "",
            radiusMiles: result.distanceMiles,
            nationwide: result.distanceMiles == null || undefined,
            bodyStyle: result.bodyStyle ?? undefined,
            make: result.make,
            model: result.model,
            preferredMakes: result.preferredMakes,
            yearMin: result.yearMin ?? undefined,
            yearMax: result.yearMax ?? undefined,
            milesMax: result.milesMax ?? undefined,
            repairAbility: result.repairAbility ?? "unknown",
            minProfitUsd: result.targetProfitUsd ?? undefined,
            freeText: result.freeText ?? undefined,
            notes: result.freeText ?? undefined,
            criteriaParseSource: result.criteriaParseSource ?? (result.freeText ? "form" : "form"),
            criteriaResponseId: result.criteriaResponseId ?? null,
          },
        }),
      });
      const body = (await response.json()) as { message?: string; error?: string; redirect?: string };
      if (!response.ok) {
        if (body.error === "plan_required" || response.status === 402) {
          router.push(body.redirect || "/pricing?from=watch");
          return;
        }
        setWatchError(body.message || "The watch was not saved.");
        return;
      }
      router.push("/radar");
    } catch {
      setWatchError("The watch was not saved.");
    } finally {
      setWatchPending(false);
    }
  }

  return (
    <article className="warn-box check-result resale-results" aria-live="polite">
      {runId ? <RunMirror runId={runId} /> : <h2 className="verdict-level">{result.verdictLabel}</h2>}
      <p className="lead">
        <strong>Verdict: {result.verdictLabel}</strong>
        {" · "}
        Confidence: {result.confidence}
      </p>
      {result.reviewNote ? <p>{result.reviewNote}</p> : null}
      <p>{result.message}</p>
      <p className="hint">{result.nextStep}</p>
      <p className="hint">{parseLabel}</p>
      {parseTechnical ? (
        <details className="onboarding-note">
          <summary>Technical details</summary>
          <p className="hint">{parseTechnical}</p>
        </details>
      ) : null}
      {result.budgetUsd ? (
        <p className="btn-row">
          <button className="action" type="button" onClick={() => void watchWithRadar()} disabled={watchPending}>
            {watchPending ? "Saving watch…" : "Watch with Deal Radar"}
          </button>
        </p>
      ) : null}
      {watchError ? <p className="warn">{watchError}</p> : null}
      <p className="hint">{result.creditNote}</p>
      {typeof result.balance === "number" ? <p className="hint">Balance after search: {result.balance}</p> : null}

      {result.best ? (
        <CandidateCard
          title={resalePickHeading(result.verdictAction, true) ?? "Closest candidate"}
          candidate={result.best}
          featured
          budgetUsd={result.budgetUsd}
          action={result.verdictAction}
          reason={result.message}
          resultConfidence={result.confidence}
        />
      ) : null}
      {result.alternatives.length > 0 ? (
        <section>
          <h3>Alternatives</h3>
          {result.alternatives.map((item) => (
            <CandidateCard
              key={item.vin}
              title={`${item.listing.year} ${item.listing.make} ${item.listing.model}`}
              candidate={item}
              budgetUsd={result.budgetUsd}
            />
          ))}
        </section>
      ) : null}

      {runId ? null : (
      <ServDecisionJournal
        agentVerdict={result.agentVerdict}
        proofRecords={result.proofRecords}
        resaleJournal={result.journal}
        defaultOpen
      />
      )}
    </article>
  );
}

function CandidateCard({
  title,
  candidate,
  featured = false,
  budgetUsd = null,
  action = null,
  reason = null,
  resultConfidence = null,
}: {
  title: string;
  candidate: ResaleCandidatePnl;
  featured?: boolean;
  budgetUsd?: number | null;
  action?: string | null;
  reason?: string | null;
  resultConfidence?: string | null;
}) {
  const l = candidate.listing;
  const overBudget =
    budgetUsd != null &&
    candidate.askingUsd > budgetUsd &&
    candidate.risks.some((line) => /^Over budget:/i.test(line));
  const primary = resalePrimaryListingLink({
    dealer: l.dealer,
    vdp: l.vdp,
    dealerUrl: l.dealerUrl,
    vin: candidate.vin,
    year: l.year,
    trim: l.trim,
  });
  const link = primary.verifiability;
  return (
    <section className={featured ? "resale-best" : undefined}>
      <h3 className="prose-title">
        {title}
        {overBudget ? " · over budget" : ""}
        {!link.direct && primary.label !== "Listing on Carfax" ? " · no direct listing link" : ""}
      </h3>
      {featured ? (
        <p>
          {resaleEdgeSentence({
            amountUsd: candidate.profitMidUsd,
            action,
            reason: action === "pass" || action === "skip" ? reason : null,
            thresholdUsd: candidate.targetProfitUsd,
          })}
        </p>
      ) : null}
      <p>
        {l.year} {l.make} {l.model}
        {l.trim ? ` ${l.trim}` : ""}
        {l.miles != null ? ` · ${l.miles.toLocaleString("en-US")} mi` : ""}
        {l.dealer ? ` · ${l.dealer}` : ""}
        {l.city || l.state || l.zip
          ? ` · listing feed: ${[l.city, l.state, l.zip].filter(Boolean).join(", ")}`
          : ""}
      </p>
      {link.flag ? <p className="hint">{link.flag}</p> : null}
      {link.sellerMismatchNote ? <p className="hint">{link.sellerMismatchNote}</p> : null}
      {link.pageMismatchNote ? (
        <p className="hint">
          {link.pageMismatchNote} Similar cars may be for a different trim.
        </p>
      ) : null}
      {candidate.risks.some((line) => /^Not profitable at ask$/i.test(line)) ? (
        <p className="warn" aria-live="off">
          Not profitable at ask
        </p>
      ) : null}
      <ul className="refuse">
        <li>
          {resaleCardCopy.rank} Similar cars in this scan: {candidate.compCount}.
        </li>
        <li>Ask: {formatUsd(candidate.askingUsd)}</li>
        <li>
          {candidate.negotiateBasis}
        </li>
        <li>
          Sales tax: {candidate.salesTaxUsd != null ? formatUsd(candidate.salesTaxUsd) : "unknown"} — {candidate.salesTaxBasis}
        </li>
        <li>
          Title/registration: unknown dollar amount — {candidate.titleRegistrationBasis}
        </li>
        <li>
          Title fee used in the cost estimate: {formatUsd(candidate.titleFeeAssumptionUsd)} — {candidate.titleFeeBasis}
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
          Confidence: {featured && action ? (resultConfidence ?? candidate.confidence) : candidate.confidence}
          {featured && resultConfidence && resultConfidence !== candidate.confidence
            ? `. Similar-car prices support the dollar estimate. The result stays ${resultConfidence} because the profit is below the minimum that is worth the effort and time.`
            : ` — ${candidate.confidenceBasis}`}
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
      {primary.href && primary.label ? (
        <p>
          <a href={primary.href} target="_blank" rel="noreferrer">
            {primary.label}
          </a>
        </p>
      ) : primary.unavailableHint ? (
        <p className="hint">{primary.unavailableHint}</p>
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
  const [targetProfit, setTargetProfit] = useState("");
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
          targetProfitUsd: targetProfit.trim() === "" ? null : targetProfit,
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
            placeholder="Optional. Leave blank for no target."
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
        <label htmlFor="resale-eval-zip">U.S. ZIP for nearby similar cars (optional)</label>
        <input
          id="resale-eval-zip"
          value={zip}
          onChange={(e) => setZip(e.target.value)}
          inputMode="numeric"
          placeholder="Nationwide if blank"
        />
      </div>
      <fieldset className="field">
        <legend>Repair skill (optional, for the estimate only)</legend>
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
