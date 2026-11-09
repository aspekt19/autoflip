"use client";

import { useEffect, useState } from "react";
import { isSignInWithEmailLink, signInWithEmailLink } from "firebase/auth";
import type { FirebasePublicConfig } from "@/auth/config";
import { EMAIL_LINK_STORAGE_KEY } from "@/auth/email-link";
import { firebaseAuth } from "@/auth/firebase-browser";
import { signInWithEmailLinkToken } from "@/auth/actions";

export function EmailLinkFinish({
  firebase,
  callbackUrl,
}: {
  firebase: FirebasePublicConfig;
  callbackUrl: string;
}) {
  const [email, setEmail] = useState("");
  const [needsEmail, setNeedsEmail] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function complete(address: string) {
    const trimmed = address.trim();
    if (!trimmed.includes("@")) {
      window.localStorage.removeItem(EMAIL_LINK_STORAGE_KEY);
      setMessage("Enter a valid email address.");
      setNeedsEmail(true);
      return;
    }
    setPending(true);
    setMessage(null);
    let consumed = false;
    try {
      const auth = firebaseAuth(firebase);
      if (!isSignInWithEmailLink(auth, window.location.href)) {
        setMessage("Open the sign-in link from your email on this page.");
        setNeedsEmail(true);
        return;
      }
      consumed = true;
      window.localStorage.removeItem(EMAIL_LINK_STORAGE_KEY);
      const credential = await signInWithEmailLink(auth, trimmed, window.location.href);
      const idToken = await credential.user.getIdToken();
      window.localStorage.removeItem(EMAIL_LINK_STORAGE_KEY);
      const result = await signInWithEmailLinkToken(idToken, callbackUrl);
      if (result?.error) {
        setMessage("That sign-in link did not work. Request a new one.");
        setNeedsEmail(true);
      }
    } catch {
      setMessage("That sign-in link did not work. Request a new one.");
      setNeedsEmail(true);
    } finally {
      if (consumed) window.localStorage.removeItem(EMAIL_LINK_STORAGE_KEY);
      setPending(false);
    }
  }

  useEffect(() => {
    const stored = window.localStorage.getItem(EMAIL_LINK_STORAGE_KEY);
    if (stored) {
      void complete(stored);
      return;
    }
    setNeedsEmail(true);
    // Run once on open. complete closes over the public Firebase config and the safe callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="auth-panel">
      {message ? (
        <p className="warn" role="alert">
          {message}
        </p>
      ) : null}
      {pending ? (
        <p className="hint" role="status">
          Signing you in…
        </p>
      ) : null}
      {needsEmail ? (
        <form
          className="auth-email"
          onSubmit={(event) => {
            event.preventDefault();
            void complete(email);
          }}
        >
          <label htmlFor="email-link-confirm">Email</label>
          <input
            id="email-link-confirm"
            name="email"
            type="email"
            autoComplete="email"
            required
            placeholder="you@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <p className="hint">This link was opened without the saved email. Enter the same address you used to ask for it.</p>
          <button className="action" type="submit" disabled={pending}>
            Continue
          </button>
        </form>
      ) : null}
    </div>
  );
}
