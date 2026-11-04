"use client";

import { CREDIT_PACKS } from "@/domain/assumptions";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

function CreditsInner() {
  const params = useSearchParams();
  const need = params.get("need") === "1";
  const status = params.get("status");
  const [credits, setCredits] = useState<number | null>(null);
  const [stripeOn, setStripeOn] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/account")
      .then((response) => response.json())
      .then((body: { credits?: number; stripeConfigured?: boolean }) => {
        if (typeof body.credits === "number") setCredits(body.credits);
        setStripeOn(Boolean(body.stripeConfigured));
      })
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
      const body = (await response.json()) as { url?: string; message?: string };
      if (!response.ok || !body.url) {
        setError(body.message || "Checkout is not available.");
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
      <div className="sheet-page">
      <p className="kicker">Test checkout</p>
      <h1>Credits</h1>
      <p className="lead">Monitoring (saved searches and Deal Radar alerts) needs a radar plan. A full report costs 1 credit. Checkout is charged in US dollars.</p>
      <p className="warn-box">
        Balance: <strong>{credits === null ? "…" : credits}</strong>
        {stripeOn === false ? " Stripe test keys are not configured, so checkout cannot start." : null}
      </p>
      {need ? <p className="warn">A full report needs 1 credit.</p> : null}
      {status === "success" ? (
        <p className="warn-box">
          Payment returned from checkout. If the balance has not moved, the payment notice has not arrived yet.
          {params.get("return")?.startsWith("/") ? (
            <>
              {" "}
              <a href={params.get("return") ?? "/find"}>Back to the car</a>
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
            <button className="action" type="button" onClick={() => buy(pack.id)} disabled={pending === pack.id}>
              {pending === pack.id ? "Starting…" : "Buy in test mode"}
            </button>
          </article>
        ))}
      </div>
      {error ? <p className="warn">{error}</p> : null}
      <p className="hint">
        In test mode, use card 4242 4242 4242 4242, any future date, and any CVC. A live card is refused.
      </p>
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
