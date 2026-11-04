"use client";

import Link from "next/link";
import { useState } from "react";
import { PLAN_CATALOG } from "@/domain/plans";

export default function PricingPage() {
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  async function subscribe(planId: string) {
    setMessage(null);
    setPending(planId);
    try {
      const response = await fetch("/api/plans/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId }),
      });
      const body = (await response.json()) as { url?: string; message?: string };
      if (!response.ok || !body.url) {
        setMessage(body.message || "Checkout is not available.");
        return;
      }
      window.location.href = body.url;
    } catch {
      setMessage("Checkout did not start.");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="sub">
      <div className="sheet-page">
        <p className="kicker">Preview pricing</p>
        <h1>Radar plans</h1>
        <p className="lead">
          These amounts are placeholders for the preview. A radar plan does not include report credits. The shared demo turns both modes on without a charge.
        </p>
        <h2>Personal</h2>
        <p className="hint">Priced by how many model lists you watch. Each model is one listings call.</p>
        <div className="choice-grid">
          {PLAN_CATALOG.filter((plan) => plan.mode === "personal").map((plan) => (
            <article className="choice-card" key={plan.id}>
              <strong className="choice-title">{plan.name}</strong>
              <span className="choice-desc">{plan.detail}</span>
              <b>${plan.amountCents / 100}/month</b>
              <button className="action" type="button" disabled={pending === plan.id} onClick={() => void subscribe(plan.id)}>
                {pending === plan.id ? "Starting…" : "Subscribe in test mode"}
              </button>
            </article>
          ))}
        </div>
        <h2>Flip</h2>
        <p className="hint">Priced higher because a resale scan reads the whole budget in a ZIP, not one model.</p>
        <div className="choice-grid">
          {PLAN_CATALOG.filter((plan) => plan.mode === "flip").map((plan) => (
            <article className="choice-card" key={plan.id}>
              <strong className="choice-title">{plan.name}</strong>
              <span className="choice-desc">{plan.detail}</span>
              <b>${plan.amountCents / 100}/month</b>
              <button className="action" type="button" disabled={pending === plan.id} onClick={() => void subscribe(plan.id)}>
                {pending === plan.id ? "Starting…" : "Subscribe in test mode"}
              </button>
            </article>
          ))}
        </div>
        {message ? <p className="warn">{message}</p> : null}
        <p>
          <Link href="/credits">Report credits are separate.</Link>
        </p>
      </div>
    </div>
  );
}
