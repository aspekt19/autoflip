"use client";

import { safeAuthCallbackUrl } from "@/auth/config";
import { creditsNeedNotice } from "@/domain/find-buyer-copy";
import { buyerFacingFailure } from "@/domain/buyer-facing-error";
import { CREDIT_PACKS } from "@/domain/assumptions";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

type AccountSnap = {
  credits?: number;
  stripeConfigured?: boolean;
  demo?: boolean;
  authenticated?: boolean;
  emailVerified?: boolean;
  auth?: { configured?: boolean };
};

function CreditsInner() {
  const params = useSearchParams();
  const need = params.get("need") === "1";
  const status = params.get("status");
  const back = safeAuthCallbackUrl(params.get("return"));
  const [snap, setSnap] = useState<AccountSnap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/account")
      .then((response) => response.json())
      .then((body: AccountSnap) => setSnap(body))
      .catch(() => setError("Could not load the credit balance."));
  }, []);

  async function buy(pack: string) {
    setPending(pack);
    setError(null);
    try {
      const response = await fetch("/api/credits/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pack, returnTo: params.get("return") }),
      });
      const body = (await response.json()) as { url?: string; message?: string; error?: string };
      if (response.status === 401 || body.error === "auth_required") {
        window.location.href = `/login?callbackUrl=${encodeURIComponent("/credits")}`;
        return;
      }
      if (!response.ok || !body.url) {
        setError(buyerFacingFailure(body.error, body.message, "Checkout is not available."));
        return;
      }
      window.location.href = body.url;
    } catch {
      setError("Checkout did not start.");
    } finally {
      setPending(null);
    }
  }

  const credits = snap?.credits;
  const stripeOn = snap?.stripeConfigured ?? null;
  const demo = Boolean(snap?.demo);
  const signedIn = Boolean(snap?.authenticated);
  const authOn = Boolean(snap?.auth?.configured);

  return (
    <div className="sub">
      <div className="sheet-page">
      <p className="kicker">Test checkout</p>
      <h1>Credits</h1>
      <p className="lead">A full vehicle report costs 1 report credit. Verified accounts get 3 free VIN or your own listing URL checks per UTC month. Find is a credit-priced search when billing is enabled. Ongoing saved-search alerts require a separate Radar plan. All preview prices are in U.S. dollars.</p>
      <p className="hint">This is Stripe test mode: test-card checkouts do not take real money. Use 4242 4242 4242 4242, any future expiry date and any CVC.</p>
      {demo ? (
        <p className="hint">You are using the shared demo account. Its credits and saved activity may be visible to other demo visitors.</p>
      ) : signedIn ? (
        <p className="hint">Credits are tied to your signed-in account and survive clearing cookies. <Link href="/account">Account</Link></p>
      ) : authOn ? (
        <p className="hint">
          Sign in before buying so credits stay with your account after cookies are cleared.{" "}
          <Link href="/login?callbackUrl=/credits">Sign in</Link>
        </p>
      ) : (
        <p className="hint">Sign-in is not available yet. Paid checkout and free monthly vehicle checks stay locked until sign-in is turned on.</p>
      )}
      <p className="warn-box">
        Balance: <strong>{credits === null || credits === undefined ? "…" : credits}</strong>
        {stripeOn === false ? " Stripe test keys are not configured, so checkout cannot start." : null}
        {authOn === false ? " Sign-in is not configured, so paid checkout stays locked." : null}
      </p>
      {need ? <p className="warn">{creditsNeedNotice(back)}</p> : null}
      {status === "success" ? (
        <p className="warn-box">
          Payment returned from checkout. If the balance has not moved, the payment notice has not arrived yet.
          {back ? (
            <>
              {" "}
              <a href={back}>Back to the car</a>
            </>
          ) : null}
        </p>
      ) : null}
      {status === "cancel" ? <p className="warn-box">Checkout was canceled. No credit was added.</p> : null}
      <div className="prices">
        {CREDIT_PACKS.map((pack) => (
          <article className="pack" key={pack.id}>
            <h3>{pack.name}</h3>
            <p className="sum">${(pack.amountCents / 100).toFixed(0)}</p>
            <p className="hint">Test price</p>
            <button className="action" type="button" onClick={() => buy(pack.id)} disabled={pending === pack.id || !authOn || !signedIn}>
              {pending === pack.id
                ? "Starting…"
                : !authOn
                  ? "Checkout locked"
                  : signedIn
                    ? "Buy in test mode"
                    : "Sign in to buy"}
            </button>
          </article>
        ))}
      </div>
      {error ? <p className="warn">{error}</p> : null}
      <p className="hint">These are test prices and test transactions only. No live payment is processed. Success redirects never grant credits — only the signed Stripe webhook does.</p>
      </div>
    </div>
  );
}

export default function CreditsPage() {
  return (
    <Suspense fallback={<div className="wrap page">Loading credits…</div>}>
      <CreditsInner />
    </Suspense>
  );
}
