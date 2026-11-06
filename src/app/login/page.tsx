import type { Metadata } from "next";
import { Suspense } from "react";
import { authStatusPayload } from "@/auth/config";
import { LoginForm } from "@/components/LoginForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in" };

function leadFor(auth: ReturnType<typeof authStatusPayload>): string {
  if (!auth.configured) {
    return "Account sign-in is not enabled on this deploy yet. Search stays available; paid checkout stays locked.";
  }
  if (auth.google && auth.email) {
    return "Sign in with Google or a one-time email link so purchased credits and reports survive clearing cookies.";
  }
  if (auth.google) {
    return "Sign in with Google so purchased credits and reports survive clearing cookies.";
  }
  return "Sign in with a one-time email link so purchased credits and reports survive clearing cookies.";
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
            Sign-in providers are not configured on this project. Paid checkout stays locked until an operator sets{" "}
            <code>AUTH_SECRET</code> and a live provider (<code>AUTH_GOOGLE_ID</code> / <code>AUTH_GOOGLE_SECRET</code>{" "}
            and/or <code>EMAIL_SERVER</code> / <code>EMAIL_FROM</code>). Inactive login methods are not offered.
          </p>
        ) : (
          <Suspense fallback={<p className="hint">Loading sign-in…</p>}>
            <LoginForm google={auth.google} email={auth.email} />
          </Suspense>
        )}
        <p className="hint">Search and browsing stay available without signing in. Checkout requires a verified account once sign-in is enabled.</p>
      </div>
    </div>
  );
}
