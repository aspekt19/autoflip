"use client";

import { useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { signInWithEmail, signInWithGoogle } from "@/auth/actions";

function safeCallback(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("://")) return "/account";
  return value.slice(0, 200);
}

export function LoginForm({ google, email }: { google: boolean; email: boolean }) {
  const params = useSearchParams();
  const callbackUrl = safeCallback(params.get("callbackUrl"));
  const verify = params.get("verify") === "1";
  const error = params.get("error");
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(
    verify ? "Check your email for a one-time sign-in link. It expires and can be used once." : null,
  );

  return (
    <div className="auth-panel">
      {error ? <p className="warn">Sign-in failed ({error}). Try again, or use the other method.</p> : null}
      {message ? <p className="warn-box">{message}</p> : null}
      {google ? (
        <p>
          <button
            className="action"
            type="button"
            disabled={pending}
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
      {email ? (
        <form
          className="auth-email"
          action={async (formData) => {
            setMessage(null);
            const result = await signInWithEmail(formData);
            if (result && "error" in result) {
              if (result.error === "email_rate_limited") setMessage("Too many email attempts. Try again later.");
              else if (result.error === "invalid_email") setMessage("Enter a valid email address.");
              else setMessage("Could not send the sign-in link.");
              return;
            }
            setMessage("Check your email for a one-time sign-in link. It expires and can be used once.");
          }}
        >
          <input type="hidden" name="callbackUrl" value={callbackUrl} />
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="email" required placeholder="you@example.com" />
          <button className="quiet" type="submit" disabled={pending}>
            Email me a sign-in link
          </button>
        </form>
      ) : null}
      {!google && !email ? <p className="warn">No sign-in providers are enabled.</p> : null}
    </div>
  );
}
