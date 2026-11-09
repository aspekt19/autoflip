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
