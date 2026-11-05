"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PLAN_CATALOG } from "@/domain/plans";

function PricingContent() {
  const params = useSearchParams();
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
        <p className="lead">Preview-only test subscriptions. Displayed monthly amounts are placeholders, and Stripe test mode does not charge real money. Radar plans cover ongoing saved-search alerts; report credits are separate.</p>
        <p className="hint">To test a subscription, use Stripe card 4242 4242 4242 4242, any future expiry date and any CVC. No real payment is taken.</p>
        {params.get("status") === "success" ? <p className="warn-box">Stripe returned from a successful test checkout. Refresh Price alerts after a few seconds if the new plan is not available yet.</p> : null}
        {params.get("status") === "cancel" ? <p className="warn-box">Test checkout was canceled. No real payment was taken.</p> : null}
        <h2>For me</h2>
        <p className="hint">Choose how many saved vehicle searches you want AutoFlip to monitor.</p>
        <div className="choice-grid">
          {PLAN_CATALOG.filter((plan) => plan.mode === "personal").map((plan) => (
            <article className="choice-card" key={plan.id}>
              <strong className="choice-title">{plan.name}</strong>
              <span className="choice-desc">{plan.detail}</span>
              <b>${plan.amountCents / 100}/month</b>
              <button className="action" type="button" disabled={pending === plan.id} onClick={() => void subscribe(plan.id)}>
                {pending === plan.id ? "Starting…" : "Start test subscription"}
              </button>
            </article>
          ))}
        </div>
        <h2>For resale</h2>
        <p className="hint">Monitor one local market using a ZIP code, search radius and maximum purchase budget.</p>
        <div className="choice-grid">
          {PLAN_CATALOG.filter((plan) => plan.mode === "flip").map((plan) => (
            <article className="choice-card" key={plan.id}>
              <strong className="choice-title">{plan.name}</strong>
              <span className="choice-desc">{plan.detail}</span>
              <b>${plan.amountCents / 100}/month</b>
              <button className="action" type="button" disabled={pending === plan.id} onClick={() => void subscribe(plan.id)}>
                {pending === plan.id ? "Starting…" : "Start test subscription"}
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


export default function PricingPage() {
  return <Suspense fallback={<div className="wrap page">Loading pricing…</div>}><PricingContent /></Suspense>;
}
