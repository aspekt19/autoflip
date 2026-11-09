"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { sendSignInLinkToEmail } from "firebase/auth";
import { safeAuthCallbackUrl, type FirebasePublicConfig } from "@/auth/config";
import { EMAIL_LINK_FINISH_PATH, EMAIL_LINK_STORAGE_KEY } from "@/auth/email-link";
import { firebaseAuth } from "@/auth/firebase-browser";
import { signInWithGoogle } from "@/auth/actions";

export function LoginForm({
  google,
  email,
  firebase,
}: {
  google: boolean;
  email: boolean;
  firebase: FirebasePublicConfig | null;
}) {
  const params = useSearchParams();
  const callbackUrl = safeAuthCallbackUrl(params.get("callbackUrl")) ?? "/account";
  const error = params.get("error");
  const [pending, startTransition] = useTransition();
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const showEmail = email && firebase !== null;

  async function sendEmailLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!firebase) return;
    const address = String(new FormData(event.currentTarget).get("email") ?? "").trim();
    if (!address.includes("@")) {
      setMessage("Enter a valid email address.");
      return;
    }
    setSending(true);
    setMessage(null);
    try {
      const finish = new URL(EMAIL_LINK_FINISH_PATH, window.location.origin);
      finish.searchParams.set("callbackUrl", callbackUrl);
      await sendSignInLinkToEmail(firebaseAuth(firebase), address, {
        url: finish.toString(),
        handleCodeInApp: true,
      });
      window.localStorage.setItem(EMAIL_LINK_STORAGE_KEY, address);
      setMessage("Check your inbox (and spam) for a sign-in link.");
    } catch {
      setMessage("Could not send the sign-in link. Try again in a few minutes.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="auth-panel">
      {error ? <p className="warn" role="alert">Sign-in did not finish. Try again.</p> : null}
      {message ? <p className="warn-box" role="status">{message}</p> : null}
      {google ? (
        <p>
          <button
            className="action"
            type="button"
            disabled={pending || sending}
            onClick={() => {
              setMessage(null);
              startTransition(async () => {
                const result = await signInWithGoogle(callbackUrl);
                if (result?.error) setMessage("Google sign-in is not available.");
              });
            }}
          >
            {pending ? "Starting…" : "Continue with Google"}
          </button>
        </p>
      ) : null}
      {showEmail ? (
        <form className="auth-email" onSubmit={(event) => void sendEmailLink(event)}>
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="email" required placeholder="you@example.com" />
          <button className="quiet" type="submit" disabled={pending || sending}>
            {sending ? "Sending…" : "Email me a sign-in link"}
          </button>
        </form>
      ) : null}
      {!google && !showEmail ? <p className="warn">No sign-in providers are enabled.</p> : null}
    </div>
  );
}
