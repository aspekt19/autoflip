"use client";

import Link from "next/link";
import { useState } from "react";
import { ServChat, type ServChatDonePayload } from "@/components/ServChat";
import { ServDecisionJournal } from "@/components/ServDecisionJournal";
import { useAccountLoad } from "@/components/use-account-load";
import { formatUsd } from "@/domain/format";
import type { ResaleCandidatePnl } from "@/domain/resale-pnl";

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
  const cars = best ? [best, ...alternatives] : alternatives;

  return (
    <div className="find-results" id="resale-results">
      {message ? <p className="lead">{message}</p> : null}
      {creditNote ? <p className="hint">{creditNote}</p> : null}
      {cars.length === 0 ? (
        <p className="lead">SERV did not choose a flip from live inventory for this chat.</p>
      ) : (
        <div className="listing-grid">
          {cars.slice(0, 8).map((car) => (
            <article key={car.vin || `${car.listing.year}-${car.listing.make}-${car.listing.model}`} className="listing-card">
              <div className="listing-body">
                <h3>
                  {car.listing.year} {car.listing.make} {car.listing.model}
                </h3>
                <p>
                  {formatUsd(car.askingUsd)}
                  {car.profitMidUsd != null ? ` · est. mid profit ${formatUsd(car.profitMidUsd)}` : ""}
                </p>
                {car.vin ? <p className="hint">VIN {car.vin}</p> : null}
              </div>
            </article>
          ))}
        </div>
      )}
      <ServDecisionJournal defaultOpen />
    </div>
  );
}
