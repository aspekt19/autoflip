import type { Metadata } from "next";
import { Suspense } from "react";
import { authStatusPayload } from "@/auth/config";
import { LoginForm } from "@/components/LoginForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in" };

function leadFor(auth: ReturnType<typeof authStatusPayload>): string {
  if (!auth.configured) return "Sign-in is not available yet.";
  if (auth.google && auth.email) {
    return "Sign in with Google or a one-time email link. A free account keeps your credits and reports after cookies are cleared.";
  }
  if (auth.google) {
    return "Sign in with Google. A free account keeps your credits and reports after cookies are cleared.";
  }
  return "Sign in with a one-time email link. A free account keeps your credits and reports after cookies are cleared.";
}

export default function LoginPage() {
  const auth = authStatusPayload();
  return (
    <div className="sub">
      <div className="sheet-page">
        <p className="kicker">Account</p>
        <h1>Sign in</h1>
        <p className="lead">{leadFor(auth)}</p>
        {!auth.configured ? (
          <p className="warn-box">
            Sign-in is not available yet. You can still look around the site. Vehicle checks, Find search, and buying
            credits stay locked until sign-in is turned on.
          </p>
        ) : (
          <Suspense fallback={<p className="hint">Loading sign-in…</p>}>
            <LoginForm google={auth.google} email={auth.email} />
          </Suspense>
        )}
        <p className="hint">You can look around without an account. Vehicle checks, Find search, and buying credits need a verified account once sign-in is on.</p>
      </div>
    </div>
  );
}
