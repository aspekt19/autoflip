import type { Metadata } from "next";
import { Suspense } from "react";
import { authStatusPayload } from "@/auth/config";
import { LoginForm } from "@/components/LoginForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  const auth = authStatusPayload();
  return (
    <div className="sub">
      <div className="sheet-page">
        <p className="kicker">Account</p>
        <h1>Sign in</h1>
        <p className="lead">Sign in with Google or a one-time email link so purchased credits and reports survive clearing cookies.</p>
        {!auth.configured ? (
          <p className="warn-box">
            Sign-in is not configured on this deploy. Paid checkout stays locked until{" "}
            <code>AUTH_SECRET</code> and at least one of Google (<code>AUTH_GOOGLE_ID</code> /{" "}
            <code>AUTH_GOOGLE_SECRET</code>) or email (<code>EMAIL_SERVER</code> / <code>EMAIL_FROM</code>, or{" "}
            <code>AUTH_EMAIL_MODE=test</code> for stubs) are set.
          </p>
        ) : (
          <Suspense fallback={<p className="hint">Loading sign-in…</p>}>
            <LoginForm google={auth.google} email={auth.email} />
          </Suspense>
        )}
        <p className="hint">Search and browsing stay available without signing in. Checkout requires a verified account.</p>
      </div>
    </div>
  );
}
