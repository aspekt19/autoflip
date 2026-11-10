"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { formatFreeChecksSignInPrompt } from "@/domain/free-check-quota";
import { useAccountLoad } from "@/components/use-account-load";

/**
 * Show a clear sign-in prompt BEFORE any check/find form fields when signed out.
 * Owner decision: login is required to prevent free VIN-checker abuse.
 */
function gateLead(callbackPath: "/check" | "/find" | "/radar"): string {
  if (callbackPath === "/check") {
    return "Checking a listing or VIN requires a free account. This keeps the monthly free checks honest.";
  }
  if (callbackPath === "/radar") {
    return "Deal Radar saved searches require a free account so watches stay tied to you — not an anonymous browser cookie.";
  }
  return "Finding cars requires a free account so searches stay tied to your credits.";
}

export function SignInGate({
  callbackPath,
  children,
}: {
  callbackPath: "/check" | "/find" | "/radar";
  children: ReactNode;
}) {
  const account = useAccountLoad();
  const loading = account.phase === "loading";
  const signedIn = account.phase === "loaded" && account.body?.authenticated === true;
  const authConfigured = account.body?.auth?.configured !== false;

  if (loading) {
    return (
      <div className="panel" aria-busy="true">
        <p className="hint">Checking your sign-in…</p>
      </div>
    );
  }

  if (!signedIn) {
    const loginHref = `/login?callbackUrl=${encodeURIComponent(callbackPath)}`;
    return (
      <div className="panel sign-in-gate" role="region" aria-label="Sign in required">
        <h2>Sign in to continue</h2>
        <p className="lead">{gateLead(callbackPath)}</p>
        {callbackPath === "/radar" ? (
          <p className="hint">Deal Radar watches require a paid plan (Radar or Radar Pro). Opening a full report still costs 1 credit.</p>
        ) : (
          <p className="hint">{formatFreeChecksSignInPrompt()}</p>
        )}
        {authConfigured ? (
          <p className="btn-row">
            <Link className="action" href={loginHref}>
              Sign in
            </Link>
          </p>
        ) : (
          <p className="warn" role="alert">
            Sign-in is not available in this environment right now.
          </p>
        )}
      </div>
    );
  }

  return <>{children}</>;
}
