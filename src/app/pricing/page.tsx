"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PLAN_CATALOG } from "@/domain/plans";

type PlanModeState = { status: string; lookupKey: string | null; searchLimit?: number };
type AccountState = {
  demo: boolean;
  plans: {
    personal: PlanModeState;
    flip: PlanModeState;
    billingPortalAvailable: boolean;
  };
};

function PricingContent() {
  const params = useSearchParams();
  const [account, setAccount] = useState<AccountState | null>(null);
  const [accountLoading, setAccountLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  async function refreshAccount() {
    setAccountLoading(true);
    try {
      const response = await fetch("/api/account", { cache: "no-store" });
      const body = (await response.json()) as AccountState;
      if (response.ok && body.plans) setAccount(body);
      else setMessage("Could not load the current plan status.");
    } catch {
      setMessage("Could not load the current plan status.");
    } finally {
      setAccountLoading(false);
    }
  }

  useEffect(() => {
    void refreshAccount();
  }, []);

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

  async function manageSubscription() {
    setMessage(null);
    setPending("portal");
    try {
      const response = await fetch("/api/plans/portal", { method: "POST" });
      const body = (await response.json()) as { url?: string; message?: string };
      if (!response.ok || !body.url) {
        setMessage(body.message || "Subscription management is not available.");
        return;
      }
      window.location.href = body.url;
    } catch {
      setMessage("Subscription management did not start.");
    } finally {
      setPending(null);
    }
  }

  const personal = account?.plans.personal;
  const flip = account?.plans.flip;
  const personalActive = personal?.status === "active" || personal?.status === "past_due";
  const flipActive = flip?.status === "active" || flip?.status === "past_due";

  return (
    <div className="sub">
      <div className="sheet-page">
        <p className="kicker">Preview pricing</p>
        <h1>Radar plans</h1>
        <p className="lead">Preview-only test subscriptions. Displayed monthly amounts are placeholders, and Stripe test mode does not charge real money. Radar plans cover ongoing saved-search alerts; report credits are separate.</p>
        <p className="hint">To test a subscription, use Stripe card 4242 4242 4242 4242, any future expiry date and any CVC. No real payment is taken.</p>

        {params.get("status") === "success" ? (
          <p className="warn-box">Stripe returned from a successful test checkout. Your plan status may take a few seconds to update. <button className="quiet" type="button" onClick={() => void refreshAccount()}>Refresh status</button></p>
        ) : null}
        {params.get("status") === "cancel" ? <p className="warn-box">Test checkout was canceled. No real payment was taken.</p> : null}
        {params.get("status") === "portal" ? <p className="warn-box">You returned from subscription management. Your current plan status is shown below.</p> : null}

        {accountLoading ? <p className="hint">Loading your current plan…</p> : null}
        {account?.demo ? (
          <p className="warn-box">Shared demo: both Personal and For resale alerts are already included. You do not need to start a subscription here.</p>
        ) : null}
        {!account?.demo && (personalActive || flipActive) ? (
          <section className="subscription-status">
            <h2>Your current plan</h2>
            {personalActive ? <p>For me: <strong>{personal?.status === "past_due" ? "Payment needs attention" : "Active"}</strong> · {personal?.searchLimit ?? 0} saved searches</p> : null}
            {flipActive ? <p>For resale: <strong>{flip?.status === "past_due" ? "Payment needs attention" : "Active"}</strong> · one local market</p> : null}
            {account?.plans.billingPortalAvailable ? (
              <button className="action" type="button" onClick={() => void manageSubscription()} disabled={pending === "portal"}>
                {pending === "portal" ? "Opening…" : "Manage subscription"}
              </button>
            ) : (
              <p className="hint">The Stripe customer link is not available yet. If you just subscribed, refresh this page after the test webhook completes.</p>
            )}
          </section>
        ) : null}

        <h2>For me</h2>
        <p className="hint">Choose how many saved vehicle searches you want AutoFlip to monitor.</p>
        <div className="choice-grid">
          {PLAN_CATALOG.filter((plan) => plan.mode === "personal").map((plan) => (
            <article className="choice-card" key={plan.id}>
              <strong className="choice-title">{plan.name}</strong>
              <span className="choice-desc">{plan.detail}</span>
              <b>${plan.amountCents / 100}/month</b>
              <button className="action" type="button" disabled={accountLoading || pending === plan.id || Boolean(account?.demo) || Boolean(personalActive)} onClick={() => void subscribe(plan.id)}>
                {personalActive ? "Personal plan active" : account?.demo ? "Included in shared demo" : pending === plan.id ? "Starting…" : "Start test subscription"}
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
              <button className="action" type="button" disabled={accountLoading || pending === plan.id || Boolean(account?.demo) || Boolean(flipActive)} onClick={() => void subscribe(plan.id)}>
                {flipActive ? "For resale plan active" : account?.demo ? "Included in shared demo" : pending === plan.id ? "Starting…" : "Start test subscription"}
              </button>
            </article>
          ))}
        </div>
        {message ? <p className="warn">{message}</p> : null}
        <p><Link href="/credits">Report credits are separate.</Link></p>
        <p><Link href="/reports">View your report history.</Link></p>
      </div>
    </div>
  );
}

export default function PricingPage() {
  return <Suspense fallback={<div className="wrap page">Loading pricing…</div>}><PricingContent /></Suspense>;
}
