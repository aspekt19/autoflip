"use client";

import Link from "next/link";
import { useState } from "react";
import { ServChat, type ServChatDonePayload } from "@/components/ServChat";
import { ServDecisionJournal } from "@/components/ServDecisionJournal";
import { useAccountLoad } from "@/components/use-account-load";
import { formatUsd } from "@/domain/format";
import type { ResaleCandidatePnl } from "@/domain/resale-pnl";
import type { ResaleDecisionJournal } from "@/domain/resale-decision-journal";
import { formatShopperBriefCard, type ShopperBrief } from "@/domain/shopper-brief";

export function ResaleChatFlow() {
  const account = useAccountLoad();
  const loading = account.phase === "loading";
  const signedIn = account.phase === "loaded" && account.body?.authenticated === true;
  const authConfigured = account.body?.auth?.configured !== false;
  const [done, setDone] = useState<ServChatDonePayload | null>(null);

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
        <p className="lead">Resale searches live dealer inventory for flips. A free account keeps usage tied to you.</p>
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

  if (!done) {
    return (
      <ServChat
        endpoint="/api/resale/chat"
        placeholder="Describe the flip you want and your budget…"
        onDone={setDone}
      />
    );
  }

  const result = done.result;
  const best = (result.best ?? null) as ResaleCandidatePnl | null;
  const alternatives = (Array.isArray(result.alternatives) ? result.alternatives : []) as ResaleCandidatePnl[];
  const message = typeof result.message === "string" ? result.message : null;
  const creditNote = typeof result.creditNote === "string" ? result.creditNote : null;
  const confirmedBrief = (result.confirmedBrief ?? null) as ShopperBrief | null;
  const runId = typeof result.runId === "string" ? result.runId : null;
  const journal = (result.journal ?? null) as ResaleDecisionJournal | null;
  const agentPicks = Array.isArray(
    (result.agentVerdict as { picks?: unknown } | null | undefined)?.picks,
  )
    ? ((result.agentVerdict as { picks: Array<{ vin?: string; why?: string; riskNotes?: string | null }> })
        .picks)
    : [];
  const sourcesByVin = (result.sourcesCheckedByVin ?? {}) as Record<
    string,
    Array<{ source?: string; status?: string; label?: string }>
  >;
  const cars = best ? [best, ...alternatives] : alternatives;

  return (
    <div className="find-results" id="resale-results">
      {message ? <p className="lead">{message}</p> : null}
      {creditNote ? <p className="hint">{creditNote}</p> : null}

      {confirmedBrief ? (
        <section className="onboarding-note" aria-label="Confirmed search brief">
          <h2>Confirmed brief</h2>
          <pre className="hint" style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>
            {formatShopperBriefCard(confirmedBrief)}
          </pre>
        </section>
      ) : null}

      {runId ? (
        <p className="btn-row">
          <Link className="quiet" href={`/run/${runId}`}>
            Open match report
          </Link>
        </p>
      ) : null}

      {cars.length === 0 ? (
        <p className="lead">SERV did not choose a flip from live inventory for this chat.</p>
      ) : (
        <div className="listing-grid">
          {cars.slice(0, 8).map((car) => {
            const l = car.listing;
            const distance = l.distanceMiles;
            const vdp = typeof l.vdp === "string" && l.vdp.trim() ? l.vdp.trim() : null;
            const pick = agentPicks.find(
              (p) => (p.vin ?? "").toUpperCase() === (car.vin ?? "").toUpperCase(),
            );
            return (
              <article key={car.vin || `${l.year}-${l.make}-${l.model}`} className="listing-card">
                <div className="listing-body">
                  <h3>
                    {l.year} {l.make} {l.model}
                  </h3>
                  <p>
                    Ask {formatUsd(car.askingUsd)}
                    {distance != null ? ` · ${Math.round(distance)} mi away` : ""}
                  </p>
                  <p className="hint">
                    {[l.bodyStyle, l.drivetrain].filter(Boolean).join(" · ") || "Body/drivetrain not listed"}
                  </p>
                  {car.vin ? <p className="hint">VIN {car.vin}</p> : null}
                  <ul className="refuse">
                    <li>
                      Expected resale:{" "}
                      {car.resaleLowUsd != null ? formatUsd(car.resaleLowUsd) : "—"} /{" "}
                      {car.resaleMidUsd != null ? formatUsd(car.resaleMidUsd) : "—"} /{" "}
                      {car.resaleHighUsd != null ? formatUsd(car.resaleHighUsd) : "—"}
                    </li>
                    <li>
                      Purchase path: negotiate ~{formatUsd(car.negotiatedOfferUsd)}
                      {car.salesTaxUsd != null ? ` · tax ${formatUsd(car.salesTaxUsd)}` : " · tax unknown"}
                      {` · fees/recon ${formatUsd((car.titleFeeAssumptionUsd ?? 0) + (car.reconUsd ?? 0))}`}
                    </li>
                    <li>
                      Profit range
                      {car.profitScopeLabel ? ` (${car.profitScopeLabel})` : ""}:{" "}
                      {car.profitLowUsd != null ? formatUsd(car.profitLowUsd) : "—"} to{" "}
                      {car.profitHighUsd != null ? formatUsd(car.profitHighUsd) : "—"} (mid{" "}
                      {car.profitMidUsd != null ? formatUsd(car.profitMidUsd) : "—"})
                    </li>
                  </ul>
                  {pick?.why ? <p>{pick.why}</p> : null}
                  {pick?.riskNotes ? <p className="hint">Risk: {pick.riskNotes}</p> : null}
                  {car.vin && sourcesByVin[car.vin.toUpperCase()]?.length ? (
                    <p className="hint">
                      Sources:{" "}
                      {sourcesByVin[car.vin.toUpperCase()]!
                        .map((s) => `${s.label ?? s.source} (${(s.status ?? "").replace(/_/g, " ")})`)
                        .join(" · ")}
                    </p>
                  ) : null}
                  {vdp && /^https?:\/\//i.test(vdp) ? (
                    <p>
                      <a href={vdp} target="_blank" rel="noreferrer">
                        Listing
                      </a>
                    </p>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      )}
      <ServDecisionJournal resaleJournal={journal} defaultOpen verifyId={runId} />
    </div>
  );
}
