"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { formatFreeChecksSignInPrompt } from "@/domain/free-check-quota";
import { useAccountLoad } from "@/components/use-account-load";

/**
 * Show a clear sign-in prompt BEFORE any check/find form fields when signed out.
 * Owner decision: login is required to prevent free VIN-checker abuse.
 */
export function SignInGate({
  callbackPath,
  children,
}: {
  callbackPath: "/check" | "/find";
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
        <p className="lead">
          {callbackPath === "/check"
            ? "Checking a listing or VIN requires a free account. This keeps the monthly free checks honest."
            : "Finding cars requires a free account so searches stay tied to your credits."}
        </p>
        <p className="hint">{formatFreeChecksSignInPrompt()}</p>
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
