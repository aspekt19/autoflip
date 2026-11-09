"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { signOutAction } from "@/auth/actions";

type AccountBody = {
  credits?: number;
  authenticated?: boolean;
  email?: string | null;
  emailVerified?: boolean;
  browserClaimable?: boolean;
  demo?: boolean;
  auth?: { configured?: boolean };
};

export function AccountPanel() {
  const [body, setBody] = useState<AccountBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claimMsg, setClaimMsg] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [signingOut, startSignOut] = useTransition();

  async function refresh() {
    const response = await fetch("/api/account");
    const json = (await response.json()) as AccountBody;
    setBody(json);
  }

  useEffect(() => {
    refresh().catch(() => setError("Could not load account."));
  }, []);

  async function claimBrowser() {
    setPending(true);
    setClaimMsg(null);
    try {
      const response = await fetch("/api/account/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "browser" }),
      });
      const json = (await response.json()) as {
        message?: string;
        movedCredits?: number;
        movedReports?: number;
      };
      if (!response.ok) {
        setClaimMsg(json.message || "Claim failed.");
        return;
      }
      setClaimMsg(
        `Moved ${json.movedCredits ?? 0} credit(s) and ${json.movedReports ?? 0} report(s) onto this account.`,
      );
      await refresh();
    } catch {
      setClaimMsg("Claim failed.");
    } finally {
      setPending(false);
    }
  }

  if (error) return <p className="warn">{error}</p>;
  if (!body) return <p className="hint">Loading account…</p>;

  if (!body.authenticated) {
    const authConfigured = Boolean(body.auth?.configured);
    return (
      <div>
        <p className="warn-box">
          {authConfigured
            ? "You are browsing without an account. Sign in so checks and purchases stay with you after cookies are cleared."
            : "Sign-in is not available yet. Vehicle checks, Find search, and buying credits stay locked."}
        </p>
        <p>
          <Link className="action" href="/login?callbackUrl=/account">
            Sign in
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="auth-panel">
      <p className="warn-box">
        Signed in as <strong>{body.email || "account"}</strong>
        {body.emailVerified ? " (verified)" : " (unverified — checkout blocked)"}
        <br />
        Balance: <strong>{typeof body.credits === "number" ? body.credits : "…"}</strong> report credit
        {body.credits === 1 ? "" : "s"}
      </p>
      {body.browserClaimable ? (
        <p>
          <button className="quiet" type="button" disabled={pending} onClick={claimBrowser}>
            {pending ? "Moving…" : "Move this browser’s credits & reports to my account"}
          </button>
        </p>
      ) : null}
      {claimMsg ? <p className="hint">{claimMsg}</p> : null}
      <p className="btn-row">
        <Link className="quiet" href="/credits">
          Credits
        </Link>
        <Link className="quiet" href="/reports">
          Reports
        </Link>
        <button
          className="ghost"
          type="button"
          disabled={signingOut}
          onClick={() => startSignOut(() => signOutAction())}
        >
          Sign out
        </button>
      </p>
    </div>
  );
}
