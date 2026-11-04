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
        body: JSON.stringify({ pack }),
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
    <div className="wrap page">
      <h1>Credits</h1>
      <p className="lede">Deal Radar is free. A full report costs 1 credit. Checkout runs in Stripe test mode.</p>
      <p className="banner-note">
        Balance: <strong>{credits === null ? "…" : credits}</strong>
        {stripeOn === false ? " Stripe test keys are not configured, so checkout cannot start." : null}
      </p>
      {need ? <p className="form-error">A full report needs 1 credit.</p> : null}
      {status === "success" ? (
        <p className="banner-note">Payment returned from checkout. If the balance has not moved, the test webhook has not been delivered yet.</p>
      ) : null}
      {status === "cancel" ? <p className="banner-note">Checkout was canceled. No credit was added.</p> : null}
      <div className="card">
        {CREDIT_PACKS.map((pack) => (
          <div className="pack-row" key={pack.id}>
            <div>
              <strong>{pack.name}</strong>
              <div className="meta">${(pack.amountCents / 100).toFixed(2)} · test price</div>
            </div>
            <button className="btn" type="button" onClick={() => buy(pack.id)} disabled={pending === pack.id}>
              {pending === pack.id ? "Starting…" : "Buy in test mode"}
            </button>
          </div>
        ))}
      </div>
      {error ? <p className="form-error">{error}</p> : null}
      <p className="meta">
        Use Stripe’s test card 4242 4242 4242 4242, any future date, and any CVC. A real card is not accepted because live keys are refused. For a local preview without Stripe, set AUTOFLIP_DEV_CREDITS and restart.
      </p>
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
