"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { signOutAction } from "@/auth/actions";
import {
  ACCOUNT_LOAD_FAILED_LABEL,
  ACCOUNT_LOADING_LABEL,
  ACCOUNT_RETRY_LABEL,
  accountAuthConfigured,
  accountSignedOutMessage,
  type AccountSnapshot,
} from "@/domain/account-load";
import { buyerFacingFailure } from "@/domain/buyer-facing-error";
import { freeChecksRemainingFromAccount } from "@/domain/free-check-quota";
import { useAccountLoad } from "./use-account-load";

export function AccountPanel() {
  const account = useAccountLoad();
  const body: AccountSnapshot | null = account.phase === "loaded" ? account.body : null;
  const [claimMsg, setClaimMsg] = useState<string | null>(null);
  const [adminEmail, setAdminEmail] = useState("");
  const [adminSessions, setAdminSessions] = useState("1");
  const [adminGrantMsg, setAdminGrantMsg] = useState<string | null>(null);
  const [adminGrantPending, setAdminGrantPending] = useState(false);
  const [pending, setPending] = useState(false);
  const [signingOut, startSignOut] = useTransition();

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
        setClaimMsg(buyerFacingFailure(undefined, json.message, "Claim failed."));
        return;
      }
      setClaimMsg(
        `Moved ${json.movedCredits ?? 0} credit(s) and ${json.movedReports ?? 0} report(s) onto this account.`,
      );
      await account.reload();
    } catch {
      setClaimMsg("Claim failed.");
    } finally {
      setPending(false);
    }
  }

  async function grantSearchAccess(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (adminGrantPending) return;
    setAdminGrantPending(true);
    setAdminGrantMsg(null);
    try {
      const response = await fetch("/api/admin/search-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: adminEmail, additionalSessions: Number(adminSessions) }),
      });
      const json = (await response.json()) as {
        message?: string;
        email?: string;
        additionalSessionsGranted?: number;
        totalExtraSessions?: number;
      };
      if (!response.ok) {
        setAdminGrantMsg(json.message || "Could not grant additional search access.");
        return;
      }
      setAdminGrantMsg(
        `Granted ${json.additionalSessionsGranted ?? 0} additional Find/Resale search session(s) to ${json.email}. Total extra allowance: ${json.totalExtraSessions ?? 0}.`,
      );
      setAdminEmail("");
    } catch {
      setAdminGrantMsg("Could not grant additional search access.");
    } finally {
      setAdminGrantPending(false);
    }
  }

  if (account.phase === "failed") {
    return (
      <p className="warn">
        {ACCOUNT_LOAD_FAILED_LABEL}{" "}
        <button className="quiet" type="button" onClick={() => account.retry()}>
          {ACCOUNT_RETRY_LABEL}
        </button>
      </p>
    );
  }
  if (account.phase === "loading" || !body) return <p className="hint" aria-busy="true">{ACCOUNT_LOADING_LABEL}</p>;

  const freeCheckLine = freeChecksRemainingFromAccount(body);

  if (body.authenticated !== true) {
    const signedOut = accountSignedOutMessage(accountAuthConfigured(body));
    return (
      <div>
        <p className="warn-box">{signedOut.text}</p>
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
        <br />
        Find and Resale reserve 1 credit before each search. Checks: 3 free / UTC month, then 1 credit.
        <br />
        {freeCheckLine === "missing" || freeCheckLine === "signed-out"
          ? "Free checks could not be loaded."
          : freeCheckLine}
      </p>
      {body.browserClaimable ? (
        <p>
          <button className="quiet" type="button" disabled={pending} onClick={claimBrowser}>
            {pending ? "Moving…" : "Move this browser’s credits & reports to my account"}
          </button>
        </p>
      ) : null}
      {claimMsg ? <p className="hint">{claimMsg}</p> : null}
      {body.isAdmin ? (
        <section className="onboarding-note" aria-label="Admin search access">
          <h2>Admin · Additional search access</h2>
          <p className="hint">
            Grant extra Find and Resale search sessions to a registered, verified account. The allowance is combined across both products.
          </p>
          <form onSubmit={grantSearchAccess}>
            <label htmlFor="admin-search-email">Account email</label>
            <input
              id="admin-search-email"
              type="email"
              required
              value={adminEmail}
              onChange={(event) => setAdminEmail(event.target.value)}
              placeholder="user@example.com"
            />
            <label htmlFor="admin-search-count">Additional searches</label>
            <input
              id="admin-search-count"
              type="number"
              min="1"
              max="100"
              step="1"
              required
              value={adminSessions}
              onChange={(event) => setAdminSessions(event.target.value)}
            />
            <button className="action" type="submit" disabled={adminGrantPending || !adminEmail.trim()}>
              {adminGrantPending ? "Granting…" : "Grant additional searches"}
            </button>
          </form>
          {adminGrantMsg ? <p className="hint" role="status">{adminGrantMsg}</p> : null}
        </section>
      ) : null}
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
