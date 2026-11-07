"use client";

import { useEffect, useState } from "react";

type OwnerCaps = {
  allowlisted: boolean;
  canPreferLive: boolean;
  canUseServPlanner: boolean;
  authorityReady: boolean;
  authorityBlockReason: string | null;
};

type ScoutCapabilities = {
  enabled: boolean;
  ownerAllowlistConfigured: boolean;
  servPlannerFlag: boolean;
  owner?: OwnerCaps;
};

type ScoutApiResponse = {
  error?: string;
  message?: string;
  inventoryMode?: string;
  isFixture?: boolean;
  partial?: boolean;
  paidBlockedReason?: string | null;
  presentation?: { kind: string; warning: string | null };
  capabilities?: ScoutCapabilities;
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
 * Owner can enter an arbitrary mandate. Live/SERV only when server capabilities allow.
 * Does not claim title history or verified profit. Behind SCOUT_UI_ENABLED.
 */
export function ScoutPanel() {
  const [apiKey, setApiKey] = useState("");
  const [mode, setMode] = useState<"flip" | "personal">("flip");
  const [makes, setMakes] = useState("Toyota");
  const [zip, setZip] = useState("72712");
  const [nationwide, setNationwide] = useState(false);
  const [maxDistanceMiles, setMaxDistanceMiles] = useState("500");
  const [maxMiles, setMaxMiles] = useState("");
  const [targetProfitUsd, setTargetProfitUsd] = useState("500");
  const [budgetUsd, setBudgetUsd] = useState("25000");
  const [preferLive, setPreferLive] = useState(false);
  const [planner, setPlanner] = useState<"offline_heuristic" | "serv">("offline_heuristic");
  const [caps, setCaps] = useState<ScoutCapabilities | null>(null);
  const [busy, setBusy] = useState(false);
  const [response, setResponse] = useState<ScoutApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadCaps() {
      try {
        const headers: HeadersInit = {};
        if (apiKey.trim().startsWith("af_")) {
          headers.Authorization = `Bearer ${apiKey.trim()}`;
        }
        const res = await fetch("/api/scout", { headers });
        const body = (await res.json()) as ScoutApiResponse;
        if (!cancelled) setCaps(body.capabilities ?? null);
      } catch {
        if (!cancelled) setCaps(null);
      }
    }
    void loadCaps();
    return () => {
      cancelled = true;
    };
  }, [apiKey]);

  const canPreferLive = Boolean(caps?.owner?.canPreferLive);
  const canUseServ = Boolean(caps?.owner?.canUseServPlanner);

  useEffect(() => {
    if (!canPreferLive && preferLive) setPreferLive(false);
    if (!canUseServ && planner === "serv") setPlanner("offline_heuristic");
  }, [canPreferLive, canUseServ, preferLive, planner]);

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
    const preferredMakes = makes
      .split(/[,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!preferredMakes.length) {
      setError("Enter at least one preferred make.");
      return;
    }
    if (preferLive && !canPreferLive) {
      setError(
        caps?.owner?.authorityBlockReason ??
          "Live inventory is not authorized for this key on this deployment.",
      );
      return;
    }
    if (planner === "serv" && !canUseServ) {
      setError("SERV planner is not enabled for this key on this deployment.");
      return;
    }

    const dist = nationwide ? null : Number(maxDistanceMiles);
    const milesCap = maxMiles.trim() === "" ? null : Number(maxMiles);
    const profit = mode === "flip" ? Number(targetProfitUsd) : null;
    const budget = mode === "personal" ? Number(budgetUsd) : null;

    setBusy(true);
    try {
      const idem =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `scout-${Date.now()}`;
      const res = await fetch("/api/scout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey.trim()}`,
          "Idempotency-Key": idem,
        },
        body: JSON.stringify({
          planner: preferLive && canUseServ ? planner : "offline_heuristic",
          preferLive: preferLive && canPreferLive,
          mandate: {
            mode,
            preferredMakes,
            openToOtherMakes: mode === "personal",
            zip: nationwide ? null : zip.trim() || null,
            maxDistanceMiles: nationwide ? null : Number.isFinite(dist) ? dist : 500,
            maxMiles: milesCap != null && Number.isFinite(milesCap) ? milesCap : null,
            targetProfitUsd: profit != null && Number.isFinite(profit) ? profit : null,
            budgetUsd: budget != null && Number.isFinite(budget) ? budget : null,
            budgetKnown: mode === "personal" && budget != null && Number.isFinite(budget),
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
  const runLabel = preferLive && canPreferLive ? "Run scout (live)" : "Run scout (replay)";

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
          Preferred makes (comma-separated)
          <input
            type="text"
            value={makes}
            onChange={(e) => setMakes(e.target.value)}
            placeholder="Toyota, Honda"
            disabled={busy}
          />
        </label>
        <label>
          ZIP
          <input
            type="text"
            value={zip}
            onChange={(e) => setZip(e.target.value)}
            placeholder="72712"
            disabled={busy || nationwide}
          />
        </label>
        <label className="scout-check">
          <input
            type="checkbox"
            checked={nationwide}
            onChange={(e) => setNationwide(e.target.checked)}
            disabled={busy}
          />
          Nationwide (no ZIP / distance)
        </label>
        {!nationwide ? (
          <label>
            Max distance (miles)
            <input
              type="number"
              value={maxDistanceMiles}
              onChange={(e) => setMaxDistanceMiles(e.target.value)}
              disabled={busy}
            />
          </label>
        ) : null}
        <label>
          Max miles (optional)
          <input
            type="number"
            value={maxMiles}
            onChange={(e) => setMaxMiles(e.target.value)}
            placeholder="Leave blank if unknown"
            disabled={busy}
          />
        </label>
        {mode === "flip" ? (
          <label>
            Target profit USD (investigation only — not verified)
            <input
              type="number"
              value={targetProfitUsd}
              onChange={(e) => setTargetProfitUsd(e.target.value)}
              disabled={busy}
            />
          </label>
        ) : (
          <label>
            Budget USD
            <input
              type="number"
              value={budgetUsd}
              onChange={(e) => setBudgetUsd(e.target.value)}
              disabled={busy}
            />
          </label>
        )}
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
        <label className="scout-check">
          <input
            type="checkbox"
            checked={preferLive && canPreferLive}
            onChange={(e) => setPreferLive(e.target.checked)}
            disabled={busy || !canPreferLive}
          />
          Prefer live inventory
          {!canPreferLive
            ? " (server-authorized owners only — no fixture fallback when checked)"
            : " (fail closed if blocked; never labels fixture as live)"}
        </label>
        {canUseServ ? (
          <label>
            Planner
            <select
              value={planner}
              onChange={(e) => setPlanner(e.target.value as "offline_heuristic" | "serv")}
              disabled={busy || !preferLive}
            >
              <option value="offline_heuristic">Offline heuristic</option>
              <option value="serv">SERV (bounded search/check/replan)</option>
            </select>
          </label>
        ) : null}
        <button type="button" className="btn" onClick={onRun} disabled={busy}>
          {busy ? "Running…" : runLabel}
        </button>
      </div>

      {caps?.owner?.authorityBlockReason && preferLive ? (
        <p className="scout-status scout-status-warn" role="status">
          Live path: {caps.owner.authorityBlockReason}
        </p>
      ) : null}

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
