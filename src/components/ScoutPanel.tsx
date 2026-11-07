"use client";

import { useState } from "react";

type ScoutApiResponse = {
  error?: string;
  message?: string;
  inventoryMode?: string;
  isFixture?: boolean;
  partial?: boolean;
  paidBlockedReason?: string | null;
  presentation?: { kind: string; warning: string | null };
  result?: {
    runId: string;
    state: string;
    failReason: string | null;
    message: string | null;
    autonomyClaim: string;
    inventorySource: string;
    inventoryProvenance: string | null;
    investigation: Array<{
      vin: string;
      listing: {
        year: number;
        make: string;
        model: string;
        priceUsd: number | null;
        miles: number | null;
        source: string;
      };
      historyStatus: string;
      claimsSafeBuy: boolean;
      claimsVerifiedProfit: boolean;
      disposition: string;
      rejectReason?: string | null;
      dispositionRationale?: {
        kind: string;
        groundedReason: string;
        plannerReasonRaw: string;
        assumptionsDisclosed: boolean;
        citedEvidence: Array<{ kind: string; epistemic: string; detail: string }>;
      } | null;
      constraintQualification?: {
        hardConstraintVerified: boolean;
        price: { status: string };
        miles: { status: string };
        geo: { status: string };
      } | null;
    }>;
    candidates?: Array<{
      vin: string;
      disposition: string;
      rejectReason?: string | null;
      dispositionRationale?: {
        kind: string;
        groundedReason: string;
        plannerReasonRaw: string;
        assumptionsDisclosed: boolean;
      } | null;
      listing: { year: number; make: string; model: string };
    }>;
    provenance: Array<{ state: string; reason: string; toolId: string | null }>;
  };
};

/**
 * Minimal Scout UI — progress / partial / source / unknown / refusal.
 * Does not claim title history or verified profit. Behind SCOUT_UI_ENABLED.
 */
export function ScoutPanel() {
  const [apiKey, setApiKey] = useState("");
  const [mode, setMode] = useState<"flip" | "personal">("flip");
  const [busy, setBusy] = useState(false);
  const [response, setResponse] = useState<ScoutApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onRun() {
    setError(null);
    setResponse(null);
    if (!apiKey.trim()) {
      setError("Enter an af_ API key from /developers before running Scout.");
      return;
    }
    if (!apiKey.trim().startsWith("af_")) {
      setError("Scout only accepts Lemonless af_ API keys.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/scout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey.trim()}`,
        },
        body: JSON.stringify({
          planner: "offline_heuristic",
          preferLive: false,
          mandate: {
            mode,
            preferredMakes: ["Toyota"],
            openToOtherMakes: false,
            zip: "72712",
            maxDistanceMiles: 500,
            maxMiles: null,
            targetProfitUsd: mode === "flip" ? 500 : null,
            budgetUsd: mode === "personal" ? 25000 : null,
            budgetKnown: mode === "personal",
            repairAbility: "unknown",
            notes: null,
          },
        }),
      });
      const body = (await res.json()) as ScoutApiResponse & {
        partial?: boolean;
        result?: ScoutApiResponse["result"];
      };
      setResponse(body);
      // Honest partial coverage is not a hard failure — only HTTP/fail states are.
      if (!res.ok || body.result?.state === "failed") {
        setError(
          body.message ??
            body.result?.message ??
            body.error ??
            `Scout ended with HTTP ${res.status} / state ${body.result?.state ?? "unknown"}`,
        );
      }
    } catch {
      setError("Network error talking to /api/scout.");
    } finally {
      setBusy(false);
    }
  }

  const result = response?.result;

  return (
    <div className="scout-panel">
      <div className="scout-controls">
        <label>
          Mode
          <select value={mode} onChange={(e) => setMode(e.target.value as "flip" | "personal")} disabled={busy}>
            <option value="flip">Flip (investigation)</option>
            <option value="personal">Personal (investigation)</option>
          </select>
        </label>
        <label>
          API key (af_…)
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Required when SCOUT_ENABLED"
            disabled={busy}
          />
        </label>
        <button type="button" className="btn" onClick={onRun} disabled={busy}>
          {busy ? "Running…" : "Run scout (replay)"}
        </button>
      </div>

      {error ? (
        <p className="scout-status scout-status-error" role="status">
          {error}
        </p>
      ) : null}

      {response?.presentation?.warning ? (
        <p className="scout-status scout-status-warn" role="status">
          {response.presentation.warning}
        </p>
      ) : null}

      {response?.paidBlockedReason ? (
        <p className="scout-status" role="status">
          Live inventory blocked: {response.paidBlockedReason}
        </p>
      ) : null}

      {response?.partial && result && result.state !== "failed" ? (
        <p className="scout-status scout-status-warn" role="status">
          Partial coverage — some inventory or checks were incomplete. Not a verified full market pull.
        </p>
      ) : null}

      {result ? (
        <div className="scout-result">
          <p className="scout-status">
            State: <strong>{result.state}</strong>
            {result.failReason ? ` (${result.failReason})` : ""}
            {" · "}
            Source: {result.inventorySource}
            {" · "}
            Autonomy claim: {result.autonomyClaim}
            {" · "}
            Run id: <code>{result.runId}</code>
          </p>
          {result.message ? <p className="lead">{result.message}</p> : null}
          {result.inventoryProvenance ? (
            <p className="muted">Provenance: {result.inventoryProvenance}</p>
          ) : null}

          <h2>Investigation candidates ({result.investigation.length}/5)</h2>
          {result.investigation.length === 0 ? (
            <p>Honest empty / abstain — no investigation candidates.</p>
          ) : (
            <ul className="scout-list">
              {result.investigation.map((c) => (
                <li key={c.vin}>
                  <strong>
                    {c.listing.year} {c.listing.make} {c.listing.model}
                  </strong>{" "}
                  · VIN {c.vin}
                  <br />
                  Asking (seller claim): {c.listing.priceUsd == null ? "unknown" : `$${c.listing.priceUsd}`}
                  {" · "}
                  Miles: {c.listing.miles == null ? "unknown" : c.listing.miles}
                  <br />
                  History: {c.historyStatus} · listing source: {c.listing.source}
                  <br />
                  Hard-constraint verified:{" "}
                  {c.constraintQualification
                    ? String(c.constraintQualification.hardConstraintVerified)
                    : "unknown"}
                  {c.constraintQualification ? (
                    <>
                      {" "}
                      (price {c.constraintQualification.price.status}, miles{" "}
                      {c.constraintQualification.miles.status}, geo{" "}
                      {c.constraintQualification.geo.status})
                    </>
                  ) : null}
                  <br />
                  Claims verified safe buy: {String(c.claimsSafeBuy)} · Claims verified profit:{" "}
                  {String(c.claimsVerifiedProfit)}
                </li>
              ))}
            </ul>
          )}

          {result.candidates &&
          result.candidates.some(
            (c) => c.disposition === "rejected" || c.disposition === "replaced",
          ) ? (
            <>
              <h2>Disposition rationale (grounded)</h2>
              <ul className="scout-list">
                {result.candidates
                  .filter((c) => c.disposition === "rejected" || c.disposition === "replaced")
                  .map((c) => (
                    <li key={`disp-${c.vin}`}>
                      <strong>
                        {c.listing.year} {c.listing.make} {c.listing.model}
                      </strong>{" "}
                      · {c.disposition} · VIN {c.vin}
                      <br />
                      Endorsed: {c.rejectReason ?? c.dispositionRationale?.groundedReason ?? "—"}
                      {c.dispositionRationale ? (
                        <>
                          <br />
                          Kind: {c.dispositionRationale.kind}
                          {c.dispositionRationale.assumptionsDisclosed
                            ? " · assumptions disclosed"
                            : ""}
                          <br />
                          <span className="muted">
                            Planner raw (audit only): {c.dispositionRationale.plannerReasonRaw}
                          </span>
                        </>
                      ) : null}
                    </li>
                  ))}
              </ul>
            </>
          ) : null}

          <h2>Progress</h2>
          <ol className="scout-list">
            {result.provenance.slice(-12).map((step, i) => (
              <li key={`${step.state}-${i}`}>
                [{step.state}] {step.toolId ? `${step.toolId}: ` : ""}
                {step.reason}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}
