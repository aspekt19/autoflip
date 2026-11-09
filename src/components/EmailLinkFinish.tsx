"use client";

import { useEffect, useState } from "react";
import { isSignInWithEmailLink, signInWithEmailLink } from "firebase/auth";
import type { FirebasePublicConfig } from "@/auth/config";
import { EMAIL_LINK_STORAGE_KEY } from "@/auth/email-link";
import { firebaseAuth } from "@/auth/firebase-browser";
import { signInWithEmailLinkToken } from "@/auth/actions";

export function EmailLinkFinish({ firebase }: { firebase: FirebasePublicConfig }) {
  const [email, setEmail] = useState("");
  const [needsEmail, setNeedsEmail] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function complete(address: string) {
    const trimmed = address.trim();
    if (!trimmed.includes("@")) {
      setMessage("Enter a valid email address.");
      setNeedsEmail(true);
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      const auth = firebaseAuth(firebase);
      if (!isSignInWithEmailLink(auth, window.location.href)) {
        setMessage("Open the sign-in link from your email on this page.");
        return;
      }
      const credential = await signInWithEmailLink(auth, trimmed, window.location.href);
      const idToken = await credential.user.getIdToken();
      window.localStorage.removeItem(EMAIL_LINK_STORAGE_KEY);
      const result = await signInWithEmailLinkToken(idToken);
      if (result?.error) setMessage("That sign-in link did not work. Request a new one.");
    } catch {
      setMessage("That sign-in link did not work. Request a new one.");
    } finally {
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
    // Run once on open. complete closes over the public Firebase config from this page.
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
          <p className="hint">Enter the same email address you used to ask for the link.</p>
          <button className="action" type="submit" disabled={pending}>
            Continue
          </button>
        </form>
      ) : null}
    </div>
  );
}
