"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ASSUMPTIONS } from "@/domain/assumptions";
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
  const [radarUi, setRadarUi] = useState<boolean | null>(null);
  const freeLimit = ASSUMPTIONS.radarFreeWatchLimit;
  const freeFlipLimit = ASSUMPTIONS.radarFreeFlipWatchLimit;

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
    let cancelled = false;
    fetch("/api/product-flags")
      .then((response) => response.json())
      .then((body: { flags?: { dealRadar?: boolean } }) => {
        if (!cancelled) setRadarUi(body.flags?.dealRadar === true);
      })
      .catch(() => {
        if (!cancelled) setRadarUi(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function subscribe(planId: string) {
    if (radarUi !== true) {
      setMessage("Deal Radar is not available in this preview, so a plan cannot be started.");
      return;
    }
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
      <div className="sheet-page site-frame">
        <p className="kicker">Pricing</p>
        <h1>Deal Radar and report credits</h1>
        <p className="lead">
          Deal Radar personal watches are free with a signed-in account — up to {freeLimit} saved radars. Verified accounts also get {freeFlipLimit} free Flip watch
          {freeFlipLimit === 1 ? "" : "es"} so Deal Radar can send resale options on a schedule. Scheduled checks and in-app alerts do not spend report credits. Opening a full vehicle report costs 1 report credit. Email alerts are not configured in this deployment (in-app only). Telegram stays off.
        </p>
        <p className="hint">
          Optional Stripe test subscriptions below only raise the personal watch cap above {freeLimit}, or raise the Flip watch cap above {freeFlipLimit}. Displayed monthly amounts are Stripe test placeholders and do not charge real money. For a one-car flip estimate without a watch, use{" "}
          <Link href="/resale">Resale</Link>.
        </p>

        {params.get("status") === "success" ? (
          <p className="warn-box">Stripe returned from a successful test checkout. Your plan status may take a few seconds to update. <button className="quiet" type="button" onClick={() => void refreshAccount()}>Refresh status</button></p>
        ) : null}
        {params.get("status") === "cancel" ? <p className="warn-box">Test checkout was canceled. No real payment was taken.</p> : null}
        {params.get("status") === "portal" ? <p className="warn-box">You returned from subscription management. Your current plan status is shown below.</p> : null}

        {accountLoading ? <p className="hint">Loading your current plan…</p> : null}
        {account?.demo ? (
          <p className="warn-box">Shared demo: Deal Radar watches are included. You do not need to start a subscription here.</p>
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

        <h2>Optional paid caps (Stripe test)</h2>
        <p className="hint">Only needed if you want more than {freeLimit} personal watches, or more than {freeFlipLimit} Flip watch{freeFlipLimit === 1 ? "" : "es"}.</p>
        <div className="choice-grid">
          {PLAN_CATALOG.filter((plan) => plan.mode === "personal").map((plan) => (
            <article className="choice-card" key={plan.id}>
              <strong className="choice-title">{plan.name}</strong>
              <span className="choice-desc">{plan.detail}</span>
              <b>${plan.amountCents / 100}/month (test)</b>
              <button className="action" type="button" disabled={radarUi !== true || accountLoading || pending === plan.id || Boolean(account?.demo) || Boolean(personalActive)} onClick={() => void subscribe(plan.id)}>
                {radarUi === false ? "Not available in this preview" : personalActive ? "Personal plan active" : account?.demo ? "Included in shared demo" : pending === plan.id ? "Starting…" : "Start test subscription"}
              </button>
            </article>
          ))}
        </div>
        <h2>For resale (Flip watches)</h2>
        <p className="hint">
          {freeFlipLimit} free Flip watch{freeFlipLimit === 1 ? "" : "es"} per verified account. Paid Flip plans raise that cap. Personal Deal Radar stays free up to {freeLimit}.
        </p>
        <div className="choice-grid">
          {PLAN_CATALOG.filter((plan) => plan.mode === "flip").map((plan) => (
            <article className="choice-card" key={plan.id}>
              <strong className="choice-title">{plan.name}</strong>
              <span className="choice-desc">{plan.detail}</span>
              <b>${plan.amountCents / 100}/month (test)</b>
              <button className="action" type="button" disabled={radarUi !== true || accountLoading || pending === plan.id || Boolean(account?.demo) || Boolean(flipActive)} onClick={() => void subscribe(plan.id)}>
                {radarUi === false ? "Not available in this preview" : flipActive ? "For resale plan active" : account?.demo ? "Included in shared demo" : pending === plan.id ? "Starting…" : "Start test subscription"}
              </button>
            </article>
          ))}
        </div>
        {message ? <p className="warn">{message}</p> : null}
        <p><Link href="/credits">Report credits are separate.</Link></p>
        <p><Link href="/radar">Open Deal Radar</Link></p>
        <p><Link href="/reports">View your report history.</Link></p>
      </div>
    </div>
  );
}

export default function PricingPage() {
  return (
    <Suspense fallback={<div className="wrap site-frame page">Loading pricing…</div>}>
      <PricingContent />
    </Suspense>
  );
}
