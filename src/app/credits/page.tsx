"use client";

import { safeAuthCallbackUrl } from "@/auth/config";
import { creditsNeedNotice } from "@/domain/find-buyer-copy";
import { buyerFacingFailure } from "@/domain/buyer-facing-error";
import { canStartCreditCheckout, creditsPackButton, creditsPageModel } from "@/domain/account-load";
import { CREDIT_PACKS } from "@/domain/assumptions";
import {
  formatFreeChecksSignInPrompt,
  freeChecksRemainingFromAccount,
} from "@/domain/free-check-quota";
import { useAccountLoad } from "@/components/use-account-load";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";

const CREDITS_BEFORE_CHECKOUT_KEY = "lemonless.creditsBeforeCheckout";

function CreditsInner() {
  const params = useSearchParams();
  const need = params.get("need") === "1";
  const status = params.get("status");
  const back = safeAuthCallbackUrl(params.get("return"));
  const account = useAccountLoad();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [showSuccessPending, setShowSuccessPending] = useState(status === "success");
  const baselineBalance = useRef<number | null>(null);
  const snap = account.phase === "loaded" ? account.body : null;
  const model = creditsPageModel({ phase: account.phase, snap });
  const freeChecksLine =
    account.phase === "loaded"
      ? freeChecksRemainingFromAccount({
          authenticated: snap?.authenticated === true,
          freeChecks: snap?.freeChecks ?? null,
        })
      : null;

  useEffect(() => {
    if (status !== "success" || account.phase !== "loaded") return;
    const current = typeof snap?.credits === "number" && Number.isFinite(snap.credits) ? snap.credits : null;
    if (current == null) return;
    let before: number | null = null;
    try {
      const raw = sessionStorage.getItem(CREDITS_BEFORE_CHECKOUT_KEY);
      if (raw != null && raw !== "") {
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) before = parsed;
      }
    } catch {
      /* ignore */
    }
    if (before != null && current !== before) {
      setShowSuccessPending(false);
      try {
        sessionStorage.removeItem(CREDITS_BEFORE_CHECKOUT_KEY);
      } catch {
        /* ignore */
      }
      return;
    }
    if (baselineBalance.current == null) {
      baselineBalance.current = current;
      return;
    }
    if (current !== baselineBalance.current) {
      setShowSuccessPending(false);
      try {
        sessionStorage.removeItem(CREDITS_BEFORE_CHECKOUT_KEY);
      } catch {
        /* ignore */
      }
    }
  }, [status, account.phase, snap?.credits]);

  async function buy(pack: string) {
    if (!canStartCreditCheckout({ phase: account.phase, snap })) return;
    setPending(pack);
    setError(null);
    try {
      if (typeof snap?.credits === "number" && Number.isFinite(snap.credits)) {
        try {
          sessionStorage.setItem(CREDITS_BEFORE_CHECKOUT_KEY, String(snap.credits));
        } catch {
          /* ignore */
        }
      }
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

  return (
    <div className="sub">
      <div className="sheet-page site-frame">
      <p className="kicker">Test checkout</p>
      <h1>Credits</h1>
      <p className="lead">A full vehicle report costs 1 report credit. Verified accounts get 3 free VIN or listing checks per UTC month. Find is a credit-priced search when billing is enabled. Ongoing saved-search alerts require a separate Radar plan. All preview prices are in U.S. dollars.</p>
      <p className="hint">This is Stripe test mode: test-card checkouts do not take real money. Use 4242 4242 4242 4242, any future expiry date and any CVC.</p>
      {model.hint.kind === "loading" ? (
        <p className="hint" aria-busy="true">{model.hint.text}</p>
      ) : model.hint.kind === "failed" ? (
        <p className="warn-box">
          {model.hint.text}{" "}
          <button className="quiet" type="button" onClick={() => account.retry()}>
            {model.hint.retryLabel}
          </button>
        </p>
      ) : model.hint.kind === "demo" ? (
        <p className="hint">You are using the shared demo account. Its credits and saved activity may be visible to other demo visitors.</p>
      ) : model.hint.kind === "signed-in" ? (
        <p className="hint">Credits are tied to your signed-in account and survive clearing cookies. <Link href="/account">Account</Link></p>
      ) : model.hint.kind === "sign-in" ? (
        <p className="hint">
          {model.hint.text}{" "}
          <Link href="/login?callbackUrl=/credits">Sign in</Link>
        </p>
      ) : (
        <p className="hint">{model.hint.text}</p>
      )}
      {model.showBalance ? (
        <p className="warn-box">
          Balance: <strong>{model.balanceValue}</strong>
          {model.stripeOffNote ? ` ${model.stripeOffNote}` : null}
          {model.authOffNote ? ` ${model.authOffNote}` : null}
        </p>
      ) : null}
      {freeChecksLine === "signed-out" ? (
        <p className="hint">{formatFreeChecksSignInPrompt()}</p>
      ) : freeChecksLine === "missing" || freeChecksLine == null ? (
        account.phase === "loaded" && snap?.authenticated === true ? (
          <p className="hint">Free checks could not be loaded.</p>
        ) : null
      ) : (
        <p className="hint">{freeChecksLine}</p>
      )}
      {need ? <p className="warn">{creditsNeedNotice(back)}</p> : null}
      {status === "success" && showSuccessPending ? (
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
      {status === "success" && !showSuccessPending ? (
        <p className="hint">
          Payment returned from checkout. Balance updated.
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
        {CREDIT_PACKS.map((pack) => {
          const button = creditsPackButton({
            phase: account.phase,
            snap,
            pendingThis: pending === pack.id,
          });
          return (
            <article className="pack" key={pack.id}>
              <h3>{pack.name}</h3>
              <p className="sum">${(pack.amountCents / 100).toFixed(0)}</p>
              <p className="hint">Test price</p>
              <button className="action" type="button" onClick={() => buy(pack.id)} disabled={button.disabled}>
                {button.label}
              </button>
            </article>
          );
        })}
      </div>
      {error ? <p className="warn">{error}</p> : null}
      <p className="hint">These are test prices and test transactions only. No live payment is processed. Success redirects never grant credits — only the signed Stripe webhook does.</p>
      </div>
    </div>
  );
}

export default function CreditsPage() {
  return (
    <Suspense fallback={<div className="wrap site-frame page">Loading credits…</div>}>
      <CreditsInner />
    </Suspense>
  );
}
