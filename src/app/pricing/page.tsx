"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CREDIT_PACKS } from "@/domain/assumptions";
import { PLAN_CATALOG } from "@/domain/plans";

type PlanModeState = { status: string; lookupKey: string | null; searchLimit?: number };
type AccountState = {
  demo: boolean;
  plans: {
    personal: PlanModeState;
    flip: PlanModeState;
    billingPortalAvailable: boolean;
    planId?: string | null;
  };
};

function PricingContent() {
  const params = useSearchParams();
  const [account, setAccount] = useState<AccountState | null>(null);
  const [accountLoading, setAccountLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [radarUi, setRadarUi] = useState<boolean | null>(null);

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
  const planActive =
    personal?.status === "active" ||
    personal?.status === "past_due" ||
    flip?.status === "active" ||
    flip?.status === "past_due";
  const fromWatch = params.get("from") === "watch";

  return (
    <div className="sub">
      <div className="sheet-page site-frame">
        <p className="kicker">Pricing</p>
        <h1>Deal Radar plans</h1>
        <p className="lead">
          Deal Radar is paid-only — no free tier and no trial. Watches cover Find and Resale searches under one cap.
          The scheduler ticks hourly and only checks watches that are due for your plan cadence. In-site alerts only.
          Opening a full vehicle report costs 1 report credit.
        </p>
        <p className="hint">
          Preview prices — Stripe TEST mode only. One-time credit packs ($9 for 3, $25 for 10) buy report credits only
          and do <strong>not</strong> include Deal Radar — see <Link href="/credits">Credits</Link>.
        </p>

        {fromWatch ? (
          <p className="warn-box" role="status">
            Watch with Deal Radar needs an active Radar or Radar Pro plan. Choose a plan below to continue.
          </p>
        ) : null}

        {params.get("status") === "success" ? (
          <p className="warn-box">
            Stripe returned from a successful test checkout. Your plan status may take a few seconds to update.{" "}
            <button className="quiet" type="button" onClick={() => void refreshAccount()}>
              Refresh status
            </button>
          </p>
        ) : null}
        {params.get("status") === "cancel" ? (
          <p className="warn-box">Test checkout was canceled. No real payment was taken.</p>
        ) : null}
        {params.get("status") === "portal" ? (
          <p className="warn-box">You returned from subscription management. Your current plan status is shown below.</p>
        ) : null}

        {accountLoading ? <p className="hint">Loading your current plan…</p> : null}
        {account?.demo ? (
          <p className="warn-box">
            Shared demo account: Deal Radar is still paid-only (Radar $100/mo or Radar Pro $250/mo). Sign in with your own
            account to start a TEST subscription.
          </p>
        ) : null}
        {!account?.demo && planActive ? (
          <section className="subscription-status">
            <h2>Your current plan</h2>
            <p>
              Status:{" "}
              <strong>
                {personal?.status === "past_due" || flip?.status === "past_due"
                  ? "Payment needs attention"
                  : "Active"}
              </strong>
              {personal?.searchLimit ? ` · up to ${personal.searchLimit} watched searches` : null}
            </p>
            {account?.plans.billingPortalAvailable ? (
              <button className="action" type="button" onClick={() => void manageSubscription()} disabled={pending === "portal"}>
                {pending === "portal" ? "Opening…" : "Manage subscription"}
              </button>
            ) : (
              <p className="hint">
                The Stripe customer link is not available yet. If you just subscribed, refresh this page after the test
                webhook completes.
              </p>
            )}
          </section>
        ) : null}

        <h2>Radar plans (Stripe TEST)</h2>
        <p className="hint">Required for Watch with Deal Radar. Credit packs never unlock radar.</p>
        <div className="choice-grid">
          {PLAN_CATALOG.map((plan) => (
            <article className="choice-card" key={plan.id} id={`plan-${plan.id}`}>
              <strong className="choice-title">{plan.name}</strong>
              <span className="choice-desc">{plan.detail}</span>
              <b>${(plan.amountCents / 100).toFixed(0)}/month (test)</b>
              <button
                className="action"
                type="button"
                disabled={radarUi !== true || accountLoading || pending === plan.id || Boolean(account?.demo) || planActive}
                onClick={() => void subscribe(plan.id)}
              >
                {radarUi === false
                  ? "Not available in this preview"
                  : planActive
                    ? "Plan active"
                    : account?.demo
                      ? "Sign in to subscribe"
                      : pending === plan.id
                        ? "Starting…"
                        : "Start test subscription"}
              </button>
            </article>
          ))}
        </div>

        <h2>Report credit packs (no radar)</h2>
        <p className="hint">One-time purchases. They add report credits only — they do not create or unlock Deal Radar watches.</p>
        <div className="choice-grid">
          {CREDIT_PACKS.map((pack) => (
            <article className="choice-card" key={pack.id}>
              <strong className="choice-title">{pack.name}</strong>
              <span className="choice-desc">
                ${(pack.amountCents / 100).toFixed(0)} · {pack.credits} report credits. No radar watches included.
              </span>
              <b>${(pack.amountCents / 100).toFixed(0)}</b>
              <Link className="action" href="/credits">
                Buy on Credits
              </Link>
            </article>
          ))}
        </div>

        {message ? <p className="warn">{message}</p> : null}
        <p>
          <Link href="/radar">Open Deal Radar</Link>
        </p>
        <p>
          <Link href="/reports">View your report history.</Link>
        </p>
      </div>
    </div>
  );
}

export default function PricingPage() {
  return (
    <Suspense
      fallback={
        <div className="wrap site-frame page">
          <p className="eyebrow">Loading pricing…</p>
        </div>
      }
    >
      <PricingContent />
    </Suspense>
  );
}
