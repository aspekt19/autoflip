import type { Metadata } from "next";
import { AccountPanel } from "@/components/AccountPanel";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Account" };

export default function AccountPage() {
  return (
    <div className="sub">
      <div className="sheet-page site-frame">
        <p className="kicker">Account</p>
        <h1>Account</h1>
        <p className="lead">Your signed-in balance and report history stay with this account after cookies are cleared.</p>
        <AccountPanel />
        <p className="hint">
          Purchases require a verified Google or email sign-in. Success redirects never grant credits — only the signed
          Stripe webhook does.
        </p>
      </div>
    </div>
  );
}
