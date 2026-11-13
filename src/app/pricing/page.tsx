"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CREDIT_PACKS } from "@/domain/assumptions";
import { PLAN_CATALOG } from "@/domain/plans";
import { StripeTestBuyButton } from "@/components/StripeTestBuyButton";

type PlanModeState = { status: string; lookupKey: string | null; searchLimit?: number };
type AccountState = {
  demo: boolean;
  authenticated?: boolean;
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
      const body = (await response.json()) as { url?: string; message?: string; error?: string };
      if (response.status === 401 || body.error === "auth_required") {
        window.location.href = `/login?callbackUrl=${encodeURIComponent("/pricing")}`;
        return;
      }
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

  async function buyPack(packId: string) {
    setMessage(null);
    setPending(`pack:${packId}`);
    try {
      const response = await fetch("/api/credits/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pack: packId, returnTo: "/pricing" }),
      });
      const body = (await response.json()) as { url?: string; message?: string; error?: string };
      if (response.status === 401 || body.error === "auth_required") {
        window.location.href = `/login?callbackUrl=${encodeURIComponent("/pricing")}`;
        return;
      }
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
  const signedIn = account?.authenticated === true && !account?.demo;

  return (
    <div className="sub">
      <div className="sheet-page site-frame">
        <p className="kicker">Pricing</p>
        <h1>Credits &amp; Deal Radar</h1>
        <p className="lead">
          Sign in required. Find and Resale each use 1 report credit per search (reserved before search starts).
          Checks include 3 free per account per UTC month, then 1 credit. Deal Radar is a separate monthly plan —
          watches only, no included report credits. Stripe TEST mode only.
        </p>
        <p className="hint">
          Preview prices — Stripe TEST mode only. Credit packs buy report credits. Radar plans buy watched searches.
          Same checkout button style for both.
        </p>

        {fromWatch ? (
          <p className="warn-box" role="status">
            Watch with Deal Radar needs an active Radar or Radar Pro plan. Choose a plan below to continue.
          </p>
        ) : null}

        {params.get("status") === "success" ? (
          <p className="warn-box">
            Stripe returned from a successful test checkout. Your balance or plan may take a few seconds to update.{" "}
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
              <StripeTestBuyButton
                label="Manage subscription"
                pendingLabel="Opening…"
                pending={pending === "portal"}
                onClick={() => void manageSubscription()}
              />
            ) : (
              <p className="hint">
                The Stripe customer link is not available yet. If you just subscribed, refresh this page after the test
                webhook completes.
              </p>
            )}
          </section>
        ) : null}

        <h2>Radar plans (Stripe TEST)</h2>
        <p className="hint">Required for Watch with Deal Radar. No report credits included.</p>
        <div className="prices">
          {PLAN_CATALOG.map((plan) => (
            <article className="pack" key={plan.id} id={`plan-${plan.id}`}>
              <h3>{plan.name}</h3>
              <p className="sum">${(plan.amountCents / 100).toFixed(0)}/mo</p>
              <p className="hint">{plan.detail}</p>
              <StripeTestBuyButton
                label={
                  radarUi === false
                    ? "Not available in this preview"
                    : planActive
                      ? "Plan active"
                      : account?.demo
                        ? "Sign in to subscribe"
                        : "Buy with Stripe TEST"
                }
                pending={pending === plan.id}
                disabled={
                  radarUi !== true || accountLoading || Boolean(account?.demo) || planActive || !signedIn
                }
                onClick={() => void subscribe(plan.id)}
              />
            </article>
          ))}
        </div>

        <h2>Report credit packs</h2>
        <p className="hint">One-time purchases. They add report credits only — they do not unlock Deal Radar watches.</p>
        <div className="prices">
          {CREDIT_PACKS.map((pack) => (
            <article className="pack" key={pack.id}>
              <h3>{pack.name}</h3>
              <p className="sum">${(pack.amountCents / 100).toFixed(0)}</p>
              <p className="hint">
                {pack.credits} report credits. No radar watches included. Test price.
              </p>
              <StripeTestBuyButton
                label={account?.demo || !signedIn ? "Sign in to buy" : "Buy with Stripe TEST"}
                pending={pending === `pack:${pack.id}`}
                disabled={accountLoading || Boolean(account?.demo) || !signedIn}
                onClick={() => void buyPack(pack.id)}
              />
            </article>
          ))}
        </div>

        {message ? <p className="warn">{message}</p> : null}
        <p>
          <Link href="/radar">Open Deal Radar</Link>
          {" · "}
          <Link href="/credits">Credits balance</Link>
        </p>
      </div>
    </div>
  );
}

export default function PricingPage() {
  return (
    <Suspense
      fallback={
        <div className="sub">
          <div className="sheet-page site-frame">
            <p className="eyebrow">Loading pricing…</p>
          </div>
        </div>
      }
    >
      <PricingContent />
    </Suspense>
  );
}
